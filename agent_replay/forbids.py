"""Deterministic evaluation of contract `forbids` rules against a completed candidate run. No LLM
judgement, no semantic matching: every form here is a pure function of the tool calls actually made and
the results actually injected during that run (spike/gate.py's GateToolTap freezes those results from the
reference recordings before the run starts, so what a rule inspects is fully known in advance).

Supported forms:
    <tool> when <other_tool>.<field> == <value>
    <tool> called more than <n> times
    <tool> called more than <n> times per <argument_name>
"""

from __future__ import annotations

import json
import re
from collections import Counter, defaultdict
from dataclasses import dataclass

from . import paths

paths.ensure_spike_importable()
from gate import _parse_kv, _try_json  # noqa: E402 (spike/gate.py, unchanged; same parsing gate.py itself uses)

_WHEN = re.compile(r"^(?P<tool>\S+)\s+when\s+(?P<other>\S+)\.(?P<field>\S+)\s*==\s*(?P<value>.+)$")
_COUNT_PER = re.compile(r"^(?P<tool>\S+)\s+called more than\s+(?P<n>\d+)\s+times per\s+(?P<arg>\S+)$")
_COUNT = re.compile(r"^(?P<tool>\S+)\s+called more than\s+(?P<n>\d+)\s+times$")


def parse(rule: str) -> tuple[str, dict]:
    rule = rule.strip()
    for pattern, kind in ((_WHEN, "when"), (_COUNT_PER, "count_per"), (_COUNT, "count")):
        m = pattern.match(rule)
        if m:
            return kind, m.groupdict()
    raise ValueError(
        f"unrecognized forbids rule: {rule!r}. Supported forms: "
        "'<tool> when <other_tool>.<field> == <value>', '<tool> called more than <n> times', "
        "'<tool> called more than <n> times per <argument_name>'."
    )


def _literal(raw: str):
    raw = raw.strip()
    if raw.lower() == "true":
        return True
    if raw.lower() == "false":
        return False
    try:
        return int(raw)
    except ValueError:
        pass
    try:
        return float(raw)
    except ValueError:
        pass
    return raw.strip("\"'")


def _coerce_pair(a, b):
    """Normalize both sides to a comparable form before ==. Tool output fields come back as whatever
    _try_json/_parse_kv produced -- real bools/numbers from JSON tools, always strings from 'k=v' tools
    (see spike/agent.py's toy tools) -- while the rule's <value> is always parsed from rule TEXT. Compare
    as bools/floats when either side looks like one, else as lowercased strings."""
    if isinstance(a, bool) or isinstance(b, bool):
        def as_bool(x):
            return x if isinstance(x, bool) else str(x).strip().lower() == "true"
        return as_bool(a), as_bool(b)
    try:
        return float(a), float(b)
    except (TypeError, ValueError):
        return str(a).strip().lower(), str(b).strip().lower()


def _output_fields(e: dict) -> dict:
    content = e["output"].get("content") or []
    text = " ".join(str(c.get("text", "")) for c in content if isinstance(c, dict))
    parsed = _try_json(text)
    return parsed if isinstance(parsed, dict) else _parse_kv(text)


@dataclass
class Violation:
    step: int
    rule: str
    detail: str


def evaluate(rules: list[str], candidate_steps: list[dict]) -> list[Violation]:
    """candidate_steps: the "tool"-type events from a candidate trace, each already carrying gate_step
    (spike/gate.py's GateToolTap sets it). Evaluated in execution order so `called more than N times` and
    the `per <argument_name>` variant can attribute a violation to the exact call that crossed the limit,
    and so `when` only sees results from calls that happened BEFORE the call being checked.
    """
    if not rules:
        return []
    parsed_rules = [(raw, *parse(raw)) for raw in rules]

    violations: list[Violation] = []
    call_count: Counter = Counter()
    per_arg_count: dict[tuple[str, str], Counter] = defaultdict(Counter)
    history: list[dict] = []

    for e in candidate_steps:
        name = e["input"]["name"]
        args = e["input"].get("input", {}) or {}
        step = e["gate_step"]
        call_count[name] += 1
        for arg_name, arg_value in args.items():
            per_arg_count[(name, arg_name)][json.dumps(arg_value, sort_keys=True)] += 1

        for raw, kind, g in parsed_rules:
            if g["tool"] != name:
                continue
            if kind == "count":
                n = int(g["n"])
                if call_count[name] > n:
                    violations.append(Violation(step, raw, f"{name} called {call_count[name]} times, limit {n}"))
            elif kind == "count_per":
                n, arg_name = int(g["n"]), g["arg"]
                if arg_name in args:
                    v_key = json.dumps(args[arg_name], sort_keys=True)
                    count = per_arg_count[(name, arg_name)][v_key]
                    if count > n:
                        violations.append(Violation(step, raw, f"{name}({arg_name}={args[arg_name]!r}) called {count} times, limit {n}"))
            elif kind == "when":
                other_tool, field, target = g["other"], g["field"], _literal(g["value"])
                for prior in history:
                    if prior["input"]["name"] != other_tool:
                        continue
                    fields = _output_fields(prior)
                    if field not in fields:
                        continue
                    a, b = _coerce_pair(fields[field], target)
                    if a == b:
                        violations.append(Violation(step, raw, f"{other_tool}.{field} == {g['value']}"))
                        break
        history.append(e)

    return violations
