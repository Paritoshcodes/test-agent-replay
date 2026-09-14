#!/usr/bin/env python
"""Render the agent-replay CI check's PR comment from `agent-replay test --json` output.

Standalone by design (no GitHub Actions dependency): run it locally against any saved JSON to preview
the exact comment CI would post, e.g.:

    agent-replay test --json --storage local > result.json 2>/dev/null
    python .github/scripts/render_pr_comment.py result.json

Reads GITHUB_SHA / GITHUB_SERVER_URL / GITHUB_REPOSITORY / GITHUB_RUN_ID / AGENT_REPLAY_DASHBOARD_URL from
the environment when present (real values in CI); falls back to clearly-fake placeholders otherwise, so
local runs are readable but never mistaken for a real report.
"""

from __future__ import annotations

import datetime
import json
import os
import sys

MARKER = "<!-- agent-replay-report -->"

CAUSE_SENTENCE = {
    "MISSING_STEP": "stopped calling `{tool}` -- every reference run called it, this one didn't.",
    "UNRECORDED": "called `{tool}` with arguments no reference run ever used.",
    "UNSOURCED_ARGUMENT": "called `{tool}` with a value that traces to nothing the model was shown or told -- likely fabricated.",
    "ORDER_VIOLATION": "called `{tool}` before the call it depends on ({detail}).",
    "FORBIDDEN": "called `{tool}` in a situation a human explicitly marked forbidden ({detail}).",
    "DIFFERENT_ANSWER": "produced a different final answer than every reference run (trajectory matched; text didn't).",
}


def plain_english(fd: dict | None) -> str:
    if fd is None:
        return "No divergence -- every call was required or permitted, in the right order, and nothing forbidden fired."
    template = CAUSE_SENTENCE.get(fd["cause"], "diverged from the contract at `{tool}`.")
    return template.format(tool=fd.get("tool") or "?", detail=fd.get("detail") or "no detail")


def commit_link() -> str:
    """/commit/{sha} (Phase 2.4, docs/DECISIONS.md) -- the triage view, every scenario's verdict for this
    commit at once, not a single run a reader would otherwise have no way to find. Uses the FULL commit
    SHA (not the 7-char short form shown elsewhere in this comment): that's the exact key
    agent_replay/ci.py wrote to DynamoDB's commit_sha field, and the dashboard's GET /commits/{sha} looks
    up that exact string."""
    base = os.environ.get("AGENT_REPLAY_DASHBOARD_URL", "").rstrip("/")
    sha = os.environ.get("GITHUB_SHA", "0000000000000000000000000000000000local")
    if not base:
        return "_(set AGENT_REPLAY_DASHBOARD_URL to link every scenario to its triage view)_"
    return f"[View the fork ↗]({base}/commit/{sha}) -- dashboard infra deploy is currently blocked, see docs/LIMITATIONS.md"


VERDICT_ICON = {"PASS": "✅", "FAIL": "❌", "ERROR": "⚠️"}


def error_label(r: dict) -> str:
    """⚠️ ERROR alone means "could not be evaluated" (missing data, etc.). A TRANSIENT error is a
    narrower, more reassuring claim: the live model itself hiccuped and stayed broken across one retry --
    worth a human's attention, but visually and textually distinct from both a real FAIL and a plain
    ERROR, so nobody reads "the agent broke a rule" into what is really "Bedrock had a bad moment twice"."""
    return "⏳ ERROR (TRANSIENT)" if r.get("transient") else f"{VERDICT_ICON['ERROR']} ERROR"


def scenario_block(r: dict) -> str:
    if r["verdict"] == "ERROR":
        if r.get("transient"):
            return (
                f"### {r['scenario']} -- {error_label(r)}\n\n"
                f"A live model call failed transiently and **stayed failed after one automatic retry** -- "
                f"{r.get('error', 'unknown transient error')}\n\n"
                "This is very likely a Bedrock service hiccup, not a behavioral regression in the agent. "
                "Re-running the check is reasonable before treating this as a real signal.\n\n"
                f"{commit_link()}"
            )
        return (
            f"### {r['scenario']} -- {error_label(r)}\n\n"
            f"Could not be evaluated at all -- {r.get('error', 'reference recording missing')}\n\n"
            f"{commit_link()}"
        )
    icon = VERDICT_ICON.get(r["verdict"], "❌")
    fd = r["first_divergence"]
    c = r["counters"]

    lines = [f"### {r['scenario']} -- {icon} {r['verdict']}", "", plain_english(fd)]
    if fd:
        boundary = "none" if r["attribution_boundary"] is None else f"step {r['attribution_boundary']}"
        lines += [
            "",
            f"**Cause:** `{fd['cause']}` at step {fd['step']} (`{fd['tool']}`) &middot; **{fd['attribution']}** &middot; attribution boundary: {boundary}",
        ]
    lines += [
        "",
        f"**Counters:** {c['model_calls']} live model calls &middot; {c['injected']} tool results injected &middot; "
        f"{c['unrecorded']} unrecorded &middot; {c['tool_bodies']} real tool executions",
        "",
        commit_link(),
    ]
    return "\n".join(lines)


def render(results: list[dict]) -> str:
    server = os.environ.get("GITHUB_SERVER_URL", "https://github.com")
    repo = os.environ.get("GITHUB_REPOSITORY", "your-org/agent-replay")
    run_id = os.environ.get("GITHUB_RUN_ID", "local")
    run_url = f"{server}/{repo}/actions/runs/{run_id}"

    if not results:
        # `agent-replay test` crashed before producing any per-scenario result at all (bad AWS
        # credentials, a missing reference recording, an unhandled exception) -- an empty list is NOT
        # the same as "every scenario passed" (`all([]) == True` would say otherwise), so this is its own
        # distinct, loudly-not-a-pass state rather than something that silently renders as green.
        return (
            f"{MARKER}\n## agent-replay &middot; ⚠️ NO RESULTS\n\n"
            "`agent-replay test` did not produce a result for any scenario -- it likely crashed before "
            f"finishing. This is NOT a pass. See the [workflow run]({run_url}) logs for what happened.\n"
        )

    overall_ok = all(r["verdict"] == "PASS" for r in results)
    non_passing = [r for r in results if r["verdict"] != "PASS"]
    all_transient = bool(non_passing) and all(r["verdict"] == "ERROR" and r.get("transient") for r in non_passing)
    icon = "✅" if overall_ok else "⏳" if all_transient else "❌"
    verdict = "PASS" if overall_ok else "FAIL (transient only)" if all_transient else "FAIL"

    def _row(r: dict) -> str:
        label = error_label(r) if r["verdict"] == "ERROR" else f"{VERDICT_ICON.get(r['verdict'], '❌')} {r['verdict']}"
        cause = "—" if r["verdict"] == "PASS" else (r["first_divergence"]["cause"] if r["first_divergence"] else r.get("error", "—"))
        attribution = r["first_divergence"]["attribution"] if r["first_divergence"] else "—"
        return f"| **{r['scenario']}** | {label} | {cause} | {attribution} |"

    rows = "\n".join(_row(r) for r in results)

    sha = os.environ.get("GITHUB_SHA", "0000000000000000000000000000000000local")
    now = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%d %H:%M UTC")

    blocks = "\n\n---\n\n".join(scenario_block(r) for r in results)

    return f"""{MARKER}
## agent-replay &middot; {icon} {verdict}

| scenario | verdict | cause | attribution |
|---|---|---|---|
{rows}

---

{blocks}

---

Commit `{sha[:7]}` &middot; [workflow run]({run_url}) &middot; updated {now}
"""


def main() -> int:
    path = sys.argv[1] if len(sys.argv) > 1 else None
    text = open(path, encoding="utf-8").read() if path else sys.stdin.read()
    results = json.loads(text)
    print(render(results))
    return 0


if __name__ == "__main__":
    sys.exit(main())
