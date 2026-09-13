"""Dependency security auditor agent: real tools hitting real public APIs (PyPI, OSV.dev), so the
zero-network proof in full replay (spike/replay_audit.py) actually proves something -- these tools would
genuinely reach the network if they ran. Reuses the generic record/replay machinery from spike/agent.py
(COUNTS, ReplayableBedrockModel, StoredResultTool, ToolTap, canonical, append_event, sha256) unchanged;
only the agent and its tools are new. spike/agent.py is untouched and still works standalone.

Replay is byte-identical replay by injection. It does not make the model deterministic.
"""

import json
import pathlib
import urllib.request

import requests
from strands import Agent, tool

from agent import (  # noqa: F401 -- re-exported for record_audit.py / replay_audit.py / gate.py
    COUNTS,
    MODEL_ID,
    REGION,
    ReplayableBedrockModel,
    StoredResultTool,
    ToolTap,
    append_event,
    canonical,
    real_execution_count,
    sha256,
)
from strands.hooks import HookProvider

# file:// URL, not a raw Windows path: a "D:\Project\..." path with backslashes in the prompt text is
# fragile for the model to reproduce verbatim in a tool call -- confirmed in practice, it mangled it into
# "D:\\" in 2/5 runs. .as_uri() gives an absolute, unambiguous, forward-slash target.
DEFAULT_TARGET = (pathlib.Path(__file__).resolve().parent.parent / "requirements.txt").as_uri()

SYSTEM_PROMPT = (
    "You are a dependency security auditor. Read the manifest, then for every pinned package call "
    "get_package_info to confirm what it is and check_vulnerabilities for the pinned version. Process "
    "packages in alphabetical order by name. Do not give a verdict until every pinned package has been "
    "checked. End your response on its own final line with a clear verdict: either 'SAFE TO DEPLOY' or "
    "'BLOCKED: <reason>'."
)


def build_prompt(target: str) -> str:
    return f"Audit the dependencies pinned in {target} and give a deploy verdict."


PROMPT = build_prompt(DEFAULT_TARGET)


@tool
def read_manifest(url: str) -> str:
    """Fetch the raw text of a requirements.txt from an https:// URL, a file:// URL, or a local path."""
    COUNTS["tool_bodies"] += 1
    if url.startswith(("http://", "https://")):
        resp = requests.get(url, timeout=10)
        resp.raise_for_status()
        return resp.text
    if url.startswith("file://"):
        # urllib handles file:// URIs correctly cross-platform (Windows drive-letter quirks included);
        # naively stripping the "file://" prefix does not.
        with urllib.request.urlopen(url) as resp:
            return resp.read().decode("utf-8")
    return pathlib.Path(url).read_text(encoding="utf-8")


@tool
def get_package_info(name: str) -> str:
    """Look up a package on PyPI; returns a trimmed summary (name, latest version, summary, license, release date)."""
    COUNTS["tool_bodies"] += 1
    resp = requests.get(f"https://pypi.org/pypi/{name}/json", timeout=10)
    resp.raise_for_status()
    data = resp.json()
    info = data.get("info", {})
    latest = info.get("version")
    releases = data.get("releases", {}).get(latest) or []
    trimmed = {
        "name": info.get("name", name),
        "latest_version": latest,
        "summary": (info.get("summary") or "")[:200],
        "license": (info.get("license") or "")[:60] or None,
        "release_date": releases[0]["upload_time"] if releases else None,
    }
    return json.dumps(trimmed, separators=(",", ":"))


@tool
def check_vulnerabilities(name: str, version: str) -> str:
    """Query OSV.dev for known vulnerabilities in a specific PyPI package version; returns a trimmed summary."""
    COUNTS["tool_bodies"] += 1
    resp = requests.post(
        "https://api.osv.dev/v1/query",
        json={"package": {"name": name, "ecosystem": "PyPI"}, "version": version},
        timeout=10,
    )
    resp.raise_for_status()
    trimmed = []
    for v in resp.json().get("vulns", []):
        fixed = None
        for affected in v.get("affected", []):
            for rng in affected.get("ranges", []):
                for event in rng.get("events", []):
                    fixed = event.get("fixed", fixed)
        sev = v.get("severity") or []
        trimmed.append({
            "id": v.get("id"),
            "aliases": (v.get("aliases") or [])[:5],
            "severity": sev[0].get("score") if sev else v.get("database_specific", {}).get("severity"),
            "summary": (v.get("summary") or v.get("details") or "")[:200],
            "fixed_version": fixed,
        })
    return json.dumps({"package": name, "version": version, "vulnerability_count": len(trimmed), "vulnerabilities": trimmed}, separators=(",", ":"))


def build_agent(
    trace: list,
    replay: bool = False,
    *,
    model_id: str = MODEL_ID,
    system_prompt: str = SYSTEM_PROMPT,
    tap: HookProvider | None = None,
) -> tuple[Agent, ReplayableBedrockModel, HookProvider]:
    """Same shape as spike/agent.py's build_agent, so record_audit.py/replay_audit.py/gate.py can use
    either agent module interchangeably."""
    model = ReplayableBedrockModel(trace, replay, model_id=model_id, region_name=REGION)
    if tap is None:
        tap = ToolTap(trace, replay)
    agent = Agent(
        model=model,
        tools=[read_manifest, get_package_info, check_vulnerabilities],
        system_prompt=system_prompt,
        hooks=[tap],
        callback_handler=None,
    )
    return agent, model, tap
