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
import math
from collections import Counter
from dataclasses import dataclass, field

import yaml

from . import forbids as forbids_mod
from .callsig import call_key, parse_call, render_call
from ._spike import gate_compare
from ._spike.agent import canonical

# Phase 0 fix (docs/DECISIONS.md, supersedes Phase 4 decision 2): the confidence bar is PER TOOL, not
# per recording. The exact rule: a key unanimous across N runs promotes to `requires` outright if its OWN
# tool shows no variance anywhere else in this SAME recording (no call to that tool was ever skipped or
# made with different arguments) -- exactly vulnerable-dependency's real historical shape, and exactly
# check_availability/scheduling_specialist in schedule-meter-reading, which have nothing to do with
# classify_intent's own separate discretion. Only when a key's OWN tool DOES show variance elsewhere (some
# call to that same tool, in this same recording, was skipped or used different arguments) is unanimity
# held to a confidence bar: N must be large enough that an accidental unanimous run is unlikely at that
# TOOL's own observed rate (the lowest seen-count/n across that tool's own keys in this recording -- not a
# project-wide constant borrowed from a different tool's history). 0.10 is the false-promotion risk this
# project chooses to accept at that rate (see _min_n_for_confidence). A prior version of this rule used one
# global rate (classify_intent's own 0.87, schedule-meter-reading, Phase 4.1) for every key in every
# scenario -- which meant one variable call anywhere in a recording could hold back an unrelated,
# genuinely-always-called tool elsewhere in the same recording; that was wrong, not just imprecise (see
# docs/DECISIONS.md's Phase 0 entry). See docs/LIMITATIONS.md for the trade-off a confidence bar creates at
# all: a real regression on an already-variable call can sit in `permits`, unflagged.
_ACCEPTED_FALSE_PROMOTION_RISK = 0.10


def _min_n_for_confidence(observed_rate: float) -> int:
    return math.ceil(math.log(_ACCEPTED_FALSE_PROMOTION_RISK) / math.log(observed_rate))


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
    # Phase 3, docs/DECISIONS.md: (tool, canonical_args) -> the agent that made that call, for render_yaml's
    # DISPLAY qualifier only (see callsig.render_call) -- never written to or read from the YAML file
    # itself, never consulted for matching. Empty on load() (an existing contract file has no way to
    # recover it and does not need to -- it is only ever needed once, at derive-then-render time).
    agent_by_key: dict[tuple[str, str], str] = field(default_factory=dict)
    # Phase 0 fix, docs/DECISIONS.md: one-line, human-readable reason a specific (tool, canonical_args) key
    # landed in requires vs permits vs was held back -- render_yaml's per-entry comment, same display-only
    # status as agent_by_key: never written to or read from the YAML file, never consulted for matching.
    reasoning: dict[tuple[str, str], str] = field(default_factory=dict)
    # Keys that WERE seen in every run but got held back in permits anyway because their own tool shows
    # real variance elsewhere in this recording and N did not meet that tool's confidence bar (see
    # _min_n_for_confidence) -- display only, same as agent_by_key/reasoning.
    held_back: set[tuple[str, str]] = field(default_factory=set)

    def require_keys(self) -> set[tuple[str, str]]:
        return {call_key(t, a) for t, a in self.requires}

    def permit_keys(self) -> set[tuple[str, str]]:
        return {call_key(t, a) for t, a, _ in self.permits}


def derive(scenario: str, runs: list[list[dict]], existing_forbids: list[str] | None = None) -> Contract:
    """existing_forbids: the forbids list of a previously-derived contract for this same scenario, if one
    exists on disk. requires/permits/order are fully re-derived from `runs` every time -- that IS the
    point, they describe what the recording shows -- but forbids is the one part of a contract a human
    authors by hand, not something any recording could have produced, so re-deriving must carry it
    forward unchanged rather than resetting it to empty. See forbids_warnings() for what happens when a
    preserved rule outlives the tool it refers to."""
    if not runs:
        raise ValueError("cannot derive a contract from zero recorded runs")
    n = len(runs)

    key_sets = [_run_keys(events) for events in runs]
    all_keys = set().union(*key_sets)
    seen_count: Counter = Counter()
    for ks in key_sets:
        seen_count.update(ks)

    # One representative (tool, args) per key -- args are identical by construction of the key (it IS the
    # canonicalized args), so any run that has the key gives byte-identical args back. agent_by_key is
    # collected alongside it, for render_yaml's display qualifier only (see Contract.agent_by_key) -- the
    # FIRST agent value seen for a key is used; every tool name in this project is unique to one agent, so
    # this is never actually ambiguous in practice, just defensive.
    example: dict[tuple[str, str], dict] = {}
    agent_by_key: dict[tuple[str, str], str] = {}
    for events in runs:
        for e in _tool_steps(events):
            k = (e["input"]["name"], canonical(e["input"].get("input", {}) or {}))
            example.setdefault(k, e["input"].get("input", {}) or {})
            if e.get("agent"):
                agent_by_key.setdefault(k, e["agent"])

    # Confidence bar (Phase 0 fix, docs/DECISIONS.md -- see the module-level comment above for the full
    # rule and its justification). Grouped PER TOOL, not per recording: a tool's own variance is evidence
    # about THAT tool, not about every other tool that happens to share a recording with it.
    keys_by_tool: dict[str, list[tuple[str, str]]] = {}
    for k in all_keys:
        keys_by_tool.setdefault(k[0], []).append(k)
    tool_has_variance = {tool: any(seen_count[k] < n for k in ks) for tool, ks in keys_by_tool.items()}
    # The tool's own worst observed rate -- only meaningful (and only computed) for a tool that DOES vary;
    # derived from this recording's own data, never a constant borrowed from a different tool or scenario.
    tool_rate = {
        tool: min(seen_count[k] / n for k in ks)
        for tool, ks in keys_by_tool.items() if tool_has_variance[tool]
    }

    requires: list[tuple[str, dict]] = []
    permits: list[tuple[str, dict, int]] = []
    held_back: set[tuple[str, str]] = set()
    reasoning: dict[tuple[str, str], str] = {}
    for k in sorted(all_keys):
        tool, _args_json = k
        args = example[k]
        if seen_count[k] != n:
            permits.append((tool, args, seen_count[k]))
            reasoning[k] = f"called in {seen_count[k]} of {n} runs, not every run -- present or absent, both PASS"
            continue
        if not tool_has_variance[tool]:
            requires.append((tool, args))
            reasoning[k] = f"unanimous across all {n} runs; {tool} shows no variance elsewhere in this recording, trusted outright"
            continue
        rate = tool_rate[tool]
        min_n = _min_n_for_confidence(rate)
        if n >= min_n:
            requires.append((tool, args))
            reasoning[k] = (
                f"unanimous across all {n} runs; {tool} also varies elsewhere in this recording "
                f"(its own worst observed rate here is {rate:.0%}), but N={n} meets the confidence bar (>= {min_n})"
            )
        else:
            permits.append((tool, args, seen_count[k]))
            held_back.add(k)
            reasoning[k] = (
                f"unanimous across all {n} runs, but held back: {tool} also varies elsewhere in this recording "
                f"(its own worst observed rate here is {rate:.0%}), and N={n} does not meet the confidence bar (>= {min_n})"
            )

    edge_sets = [_run_order_edges(events) for events in runs]
    order = sorted(set.intersection(*edge_sets)) if edge_sets else []

    return Contract(
        scenario=scenario, n_runs=n, requires=requires, permits=permits, order=order,
        forbids=list(existing_forbids or []), agent_by_key=agent_by_key, reasoning=reasoning, held_back=held_back,
    )


def forbids_warnings(forbids: list[str], runs: list[list[dict]]) -> list[str]:
    """Call after derive() with the SAME `forbids` and `runs` used there. A preserved rule can now
    reference a tool this recording never called -- not an error, the rule still applies verbatim the
    next time that tool DOES appear, but silently keeping a rule that can never fire is exactly the kind
    of thing a human reviewing a contract diff should be told about, not left to notice on their own."""
    seen_tools = {e["input"]["name"] for events in runs for e in events if e["type"] == "tool"}
    warnings = []
    for rule in forbids:
        try:
            missing = sorted({t for t in forbids_mod.referenced_tools(rule) if t not in seen_tools})
        except ValueError as e:
            warnings.append(f"forbids rule {rule!r} could not be parsed: {e}")
            continue
        if missing:
            warnings.append(f"forbids rule {rule!r} references {', '.join(missing)}, not seen in this recording -- kept, but it cannot fire until that tool appears again")
    return warnings


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
    # Phase 3: qualify a line with its agent (agent.tool(...)) ONLY when more than one distinct agent
    # appears anywhere in this contract -- an existing single-agent contract (or a fresh one from a
    # bare-module scenario, which never populates agent_by_key at all) renders exactly as it always did,
    # byte-for-byte. See callsig.render_call's docstring for why qualification never touches matching.
    distinct_agents = {v for v in c.agent_by_key.values() if v}
    qualify = len(distinct_agents) > 1

    def _agent_for(tool: str, args: dict) -> str | None:
        return c.agent_by_key.get((tool, canonical(args))) if qualify else None

    def _reason_for(t: str, a: dict) -> str:
        return c.reasoning.get((t, canonical(a)), "")

    if c.requires:
        lines.append("requires:")
        lines += [f"  - {render_call(t, a, agent=_agent_for(t, a))}  # {_reason_for(t, a)}" for t, a in c.requires]
    else:
        lines.append("requires: []")
    lines += ["", "# Called in SOME runs but not all, OR unanimous but held back -- see each entry's own comment.",
              "# Present or absent, both PASS."]
    # Phase 0 fix (docs/DECISIONS.md): the confidence bar is now derived PER TOOL from this recording's own
    # data (see contract.py's module-level comment) -- explain it in the header only when it actually held
    # something back here; a scenario with no observed variance at all (vulnerable-dependency's own real
    # shape) renders exactly as it always did, nothing new to explain.
    if c.held_back:
        lines += [
            f"# {len(c.held_back)} of the entries below were called in EVERY run but are held back from",
            "# requires anyway -- their own tool also varied elsewhere in this recording (see each entry's",
            "# comment for that tool's own observed rate and the confidence bar it did not meet).",
            "# See docs/LIMITATIONS.md for the trade-off a confidence bar creates at all.",
        ]

    if c.permits:
        lines.append("permits:")
        lines += [f"  - {render_call(t, a, agent=_agent_for(t, a))}  # {_reason_for(t, a)}" for t, a, seen in c.permits]
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


def _agent_prefix(rendered_call: str) -> str | None:
    """The `agent.` qualifier callsig.render_call prefixes a line with, when present -- parse_call itself
    discards it (matching never uses it, see its own docstring), but a MISSING_STEP synthetic step
    (evaluate.py, for a `requires` call the candidate never made) still needs SOME agent to put it in the
    right swimlane in the web UI (Phase 1, docs/DECISIONS.md), and there is no live event to read one off
    of for a call that never happened. Re-parsing the raw line for display is cheaper and more honest than
    inventing a new persisted field for something that is otherwise correctly display-only."""
    tool_part = rendered_call.strip().partition("(")[0]
    if "." in tool_part:
        agent, _, _ = tool_part.rpartition(".")
        return agent
    return None


def load(path) -> Contract:
    raw = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    requires_lines = [str(s) for s in (raw.get("requires") or [])]
    permits_lines = [str(s) for s in (raw.get("permits") or [])]
    requires = [parse_call(s) for s in requires_lines]
    permits = [(*parse_call(s), None) for s in permits_lines]
    # See _agent_prefix's docstring: populated on load() too now, not just derive()-then-render, so a
    # MISSING_STEP entry at test/gate time can still be placed in the right swimlane.
    agent_by_key: dict[tuple[str, str], str] = {}
    for line in requires_lines + permits_lines:
        agent = _agent_prefix(line)
        if agent:
            tool, args = parse_call(line)
            agent_by_key[call_key(tool, args)] = agent
    order: list[tuple[str, str]] = []
    for s in raw.get("order") or []:
        a, _, b = str(s).partition("->")
        order.append((a.strip(), b.strip()))
    forbids = [str(s) for s in (raw.get("forbids") or [])]
    n_runs = int(raw.get("runs", 1))
    return Contract(scenario=path.stem, n_runs=n_runs, requires=requires, permits=permits, order=order, forbids=forbids, agent_by_key=agent_by_key)
