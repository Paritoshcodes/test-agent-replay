"""agent-replay/scenarios.yaml: one entry per scenario `agent-replay record` knows how to run. Written by
`agent-replay init`; read by every other subcommand.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import yaml

_HEADER = (
    "# agent-replay scenarios. Each entry is (agent module, input prompt, run count).\n"
    "# `agent-replay record <name>` runs it `runs` times and derives contracts/<name>.yaml from the\n"
    "# results. Add scenarios by hand or via `agent-replay init`.\n"
)

_REDACT_HEADER = (
    "\n"
    "# Regex patterns applied to every recorded string (tool arguments, tool output, model answers)\n"
    "# before anything is written to disk or AWS. A blunt instrument, not a guarantee: a pattern that\n"
    "# doesn't match won't redact, and a pattern that's too broad will over-redact. Review a scenario's\n"
    "# own recording before trusting this for anything actually sensitive. See README.md.\n"
)


@dataclass
class Scenario:
    name: str
    agent: str
    input: str
    runs: int = 1


def load_scenarios_file(path: Path) -> tuple[list[Scenario], list[str]]:
    """Returns ([], []) if the file doesn't exist yet -- callers treat that as "nothing configured", not
    an error, so `agent-replay init` can be the first command run in a fresh project."""
    if not path.exists():
        return [], []
    data = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    redact = [str(p) for p in (data.get("redact") or [])]
    scenarios = [
        Scenario(name=s["name"], agent=s["agent"], input=s["input"], runs=int(s.get("runs", 1)))
        for s in (data.get("scenarios") or [])
    ]
    return scenarios, redact


def render_scenarios_yaml(scenarios: list[Scenario], redact: list[str]) -> str:
    """Whole-structure yaml.safe_dump (not field-by-field): safe_dump on an individual long string wraps
    it mid-word and appends a stray `...` document-end marker, which is unreadable and fragile to hand-
    edit. Dumping the full dict at once with a wide `width` avoids both, at the cost of per-field
    comments -- acceptable here since, unlike a contract, this file has no derived numbers worth
    annotating inline."""
    data: dict = {"scenarios": [{"name": s.name, "agent": s.agent, "input": s.input, "runs": s.runs} for s in scenarios]}
    body = yaml.safe_dump(data, sort_keys=False, default_flow_style=False, width=100_000, allow_unicode=True)
    redact_body = yaml.safe_dump({"redact": redact}, sort_keys=False, default_flow_style=False, width=100_000, allow_unicode=True)
    return _HEADER + "\n" + body + _REDACT_HEADER + redact_body
