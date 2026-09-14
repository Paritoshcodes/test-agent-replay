"""Contract derivation: exact set logic over (tool_name, arguments) observed across the N reference runs
`agent-replay record <scenario> --runs N` captured. Nothing statistical, nothing fuzzy -- see README.md
for the requires/permits/order/forbids semantics this produces.

Order derivation reuses spike/gate_compare.py's own happens-before edge builder UNCHANGED (_build_edges):
the same dependency-aware, data-flow logic gate replay already uses to detect ORDER_VIOLATION within one
candidate-vs-golden comparison, applied here once per reference run and then intersected. Everything else
below is new: gate_compare.py has no notion of "across N runs" at all.
"""

from __future__ import annotations

import datetime
from collections import Counter
from dataclasses import dataclass, field

import yaml

from . import paths
from .callsig import call_key, parse_call, render_call

paths.ensure_spike_importable()
import gate_compare  # noqa: E402 (spike/gate_compare.py, unchanged, imported after sys.path setup above)
from agent import canonical  # noqa: E402


def _tool_steps(events: list) -> list[dict]:
    return [e for e in events if e["type"] == "tool"]


def _run_keys(events: list) -> set[tuple[str, str]]:
    return {(e["input"]["name"], canonical(e["input"].get("input", {}) or {})) for e in _tool_steps(events)}


def _run_order_edges(events: list) -> set[tuple[str, str]]:
    """Tool-name-level happens-before edges within one run, via gate_compare._build_edges (index-level,
    unchanged). Same-tool self-edges (e.g. two get_package_info calls for different packages) are dropped:
    they say "one of these particular calls preceded the other", not "this KIND of call always precedes
    that kind", which is the only thing a contract aggregated across N runs can meaningfully assert."""
    steps = _tool_steps(events)
    edges = gate_compare._build_edges(steps)
    names = [s["input"]["name"] for s in steps]
    return {(names[i], names[j]) for (i, j) in edges if names[i] != names[j]}


@dataclass
class Contract:
    scenario: str
    n_runs: int
    requires: list[tuple[str, dict]]  # (tool, args) called in every reference run with identical args
    permits: list[tuple[str, dict, int]]  # (tool, args, seen_in_n_of_n_runs)
    order: list[tuple[str, str]]  # (before_tool, after_tool) tool-name edges present in every run
    forbids: list[str] = field(default_factory=list)  # raw rule strings; empty until a human adds one

    def require_keys(self) -> set[tuple[str, str]]:
        return {call_key(t, a) for t, a in self.requires}

    def permit_keys(self) -> set[tuple[str, str]]:
        return {call_key(t, a) for t, a, _ in self.permits}


def derive(scenario: str, runs: list[list[dict]]) -> Contract:
    if not runs:
        raise ValueError("cannot derive a contract from zero recorded runs")
    n = len(runs)

    key_sets = [_run_keys(events) for events in runs]
    all_keys = set().union(*key_sets)
    seen_count: Counter = Counter()
    for ks in key_sets:
        seen_count.update(ks)

    # One representative (tool, args) per key -- args are identical by construction of the key (it IS the
    # canonicalized args), so any run that has the key gives byte-identical args back.
    example: dict[tuple[str, str], dict] = {}
    for events in runs:
        for e in _tool_steps(events):
            k = (e["input"]["name"], canonical(e["input"].get("input", {}) or {}))
            example.setdefault(k, e["input"].get("input", {}) or {})

    requires: list[tuple[str, dict]] = []
    permits: list[tuple[str, dict, int]] = []
    for k in sorted(all_keys):
        tool, _args_json = k
        args = example[k]
        if seen_count[k] == n:
            requires.append((tool, args))
        else:
            permits.append((tool, args, seen_count[k]))

    edge_sets = [_run_order_edges(events) for events in runs]
    order = sorted(set.intersection(*edge_sets)) if edge_sets else []

    return Contract(scenario=scenario, n_runs=n, requires=requires, permits=permits, order=order, forbids=[])


def render_yaml(c: Contract) -> str:
    """Hand-formatted, not yaml.safe_dump: every entry here is a single already-rendered plain scalar
    (see callsig.render_call), and a `# k of N runs` comment needs to sit on that exact line -- something
    no YAML dumper does. This is the file a reviewer reads in a pull request; it must read like a short,
    literal list, not a data structure."""
    lines = [
        f"# Derived from {c.n_runs} recorded run{'s' if c.n_runs != 1 else ''} of scenario \"{c.scenario}\"",
        f"# on {datetime.date.today().isoformat()} by `agent-replay record {c.scenario} --runs {c.n_runs}`.",
        "#",
        "# This is a starting point, meant to be read and edited by a human -- `agent-replay test` enforces",
        "# exactly what is written below, nothing more. Move a `permits` entry into `requires` once you",
        "# trust it always happens; delete a `permits` entry you don't want to allow at all. `forbids` is",
        "# where you add constraints the recording alone cannot infer -- see README.md for its syntax.",
        "",
        "# Called in EVERY recorded run, with these exact arguments.",
    ]
    if c.requires:
        lines.append("requires:")
        lines += [f"  - {render_call(t, a)}" for t, a in c.requires]
    else:
        lines.append("requires: []")
    lines += ["", "# Called in SOME runs but not all. Present or absent, both PASS."]
    if c.permits:
        lines.append("permits:")
        lines += [f"  - {render_call(t, a)}  # {seen} of {c.n_runs} runs" for t, a, seen in c.permits]
    else:
        lines.append("permits: []")
    lines += [
        "",
        "# Happens-before edges present in every recorded run (dependency-aware -- reuses",
        "# gate_compare.py's own edge logic, aggregated to tool-name granularity). \"a -> b\" means some",
        "# call to b consumed a's output in every run that called both.",
    ]
    if c.order:
        lines.append("order:")
        lines += [f"  - {a} -> {b}" for a, b in c.order]
    else:
        lines.append("order: []")
    lines += [
        "",
        "# Always empty on generation -- the recording alone cannot tell you what an agent must NEVER do;",
        "# only a human reviewing this file can. Supported forms (see README.md):",
        "#   <tool> when <other_tool>.<field> == <value>",
        "#   <tool> called more than <n> times",
        "#   <tool> called more than <n> times per <argument_name>",
    ]
    if c.forbids:
        lines.append("forbids:")
        lines += [f"  - {rule}" for rule in c.forbids]
    else:
        lines.append("forbids: []")
    lines += [
        "",
        f"# runs: {c.n_runs}  (machine-read by `agent-replay test`/`gate` to find the {c.n_runs} reference",
        "# recording(s) this contract's injected tool results come from -- traces {scenario}--1.. Do not",
        "# hand-edit; re-run `agent-replay record` with a different --runs to change it.)",
        f"runs: {c.n_runs}",
        "",
    ]
    return "\n".join(lines)


def load(path) -> Contract:
    raw = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    requires = [parse_call(s) for s in (raw.get("requires") or [])]
    permits = [(*parse_call(s), None) for s in (raw.get("permits") or [])]
    order: list[tuple[str, str]] = []
    for s in raw.get("order") or []:
        a, _, b = str(s).partition("->")
        order.append((a.strip(), b.strip()))
    forbids = [str(s) for s in (raw.get("forbids") or [])]
    n_runs = int(raw.get("runs", 1))
    return Contract(scenario=path.stem, n_runs=n_runs, requires=requires, permits=permits, order=order, forbids=forbids)
