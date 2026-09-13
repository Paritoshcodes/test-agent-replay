"""Rule-based comparison of a gate-replay candidate trace against its golden trace.

Comparison is dependency-aware, not positional. Two trajectories are equivalent when (1) they contain the
same multiset of (tool_name, args) calls, and (2) every happens-before edge derived from data flow in one
run is respected in the other. Order between causally INDEPENDENT calls (no data-flow edge) is never a
divergence -- e.g. auditing package A before package B when neither's args depend on the other's output.
Order between DEPENDENT calls (an edge exists) is a divergence: ORDER_VIOLATION.

A happens-before edge A -> B is recorded when some argument value of call B appears (substring match) in
call A's output text, A having executed earlier in that same run. Matching is plain string containment on
stringified values -- no semantics, no heuristics beyond literal data flow, deterministic and explainable.

Multiset correspondence reuses spike/gate.py's own runtime bookkeeping: GateToolTap already matches each
candidate call to a golden call by (tool_name, args) via a per-key FIFO queue, tagging it "recorded" (a
match existed) or "unrecorded" (none did). A "recorded" call's multiset membership is therefore already
proven at runtime; comparison here only (a) finds golden calls never consumed (MISSING_STEP) and (b)
checks edge order among matched calls (ORDER_VIOLATION). An "unrecorded" call is further split by whether
its arguments trace to any prior output or to the original input: if not, UNSOURCED_ARGUMENT -- a
fabricated argument (e.g. a hallucinated package version) is a more specific and more serious finding than
a merely-unmatched call, so it gets its own label instead of being folded into UNRECORDED.

Raw model text is NOT compared as part of the trajectory: hosted inference is not reproducible even when
nothing changed (see AGENTS.md). Final-answer text is informational only (see compare()).
"""

import json
import re
from collections import defaultdict, deque
from dataclasses import dataclass

# Splits output/context text into discrete tokens for exact-value matching. Hyphens are NOT a separator,
# so "strands-agents" and "strands-agents-tools" stay distinct tokens rather than one containing the
# other as a substring -- fixes a false happens-before edge the old substring-containment check produced.
_TOKEN_SPLIT = re.compile(r'[\s;,:="{}\[\]]+')


def _tokens(text: str) -> set[str]:
    return {t for t in _TOKEN_SPLIT.split(text) if t}

CAUSES = ("MISSING_STEP", "UNRECORDED", "UNSOURCED_ARGUMENT", "ORDER_VIOLATION", "DIFFERENT_ANSWER")
# DIFFERENT_TOOL / DIFFERENT_ARGS / EXTRA_STEP from the old positional comparator are retired: under a
# multiset + happens-before model there is no meaningful "position" left to be different at. A candidate
# call with no golden counterpart is UNRECORDED or UNSOURCED_ARGUMENT; a golden call the candidate never
# made is MISSING_STEP; same calls in a data-flow-violating order is ORDER_VIOLATION.


@dataclass
class StepReport:
    step: int
    golden: dict | None  # {"tool": str, "args": dict} or {"answer": str}; None if golden has nothing here
    candidate: dict | None  # {"tool": str, "args": dict} or {"answer": str}; None if candidate has nothing here
    gate_status: str  # "recorded", "unrecorded", or "n/a" (a golden-only / answer row)
    cause: str | None  # one of CAUSES, or None if this step matches golden
    attribution: str  # "ATTRIBUTABLE" or "UNATTRIBUTED"
    mutated: bool = False  # True if this tool step's injected result was mutated via --mutate


@dataclass
class ComparisonResult:
    steps: list[StepReport]
    first_divergence: StepReport | None
    attribution_boundary: int | None  # step number of the first unrecorded/unsourced call, or None
    verdict: str  # "PASS" or "FAIL" -- trajectory only; final-answer text is informational (see below)
    answer_matched: bool  # whether golden and candidate final answer text were byte-identical
    answer_diff: dict | None  # {path: (golden_value, candidate_value)} if both parsed as JSON and differed


def _tool_steps(events: list) -> list[dict]:
    """Ordered (execution order) tool-call events from an event list (golden trace or candidate trace)."""
    return [e for e in events if e["type"] == "tool"]


def _key(e: dict) -> tuple[str, str]:
    return (e["input"]["name"], json.dumps(e["input"].get("input", {}), sort_keys=True, separators=(",", ":")))


def _output_text(e: dict) -> str:
    content = e["output"].get("content") or []
    return " ".join(str(c.get("text", "")) for c in content if isinstance(c, dict))


def _arg_values(e: dict) -> list[str]:
    args = e["input"].get("input", {}) or {}
    return [v if isinstance(v, str) else json.dumps(v, sort_keys=True) for v in args.values() if v not in (None, "")]


def _source_token_sets(steps: list[dict]) -> list[set[str]]:
    """Per-call tokens eligible to anchor an edge: a call's output tokens, minus any token that is BOTH
    echoed from that call's own input AND already appeared in an earlier call's output this run. A value
    a call merely repeats back is not information that call produced -- unless this is the first time the
    value appears anywhere in the run, in which case it's the call's own primary subject (e.g. the id the
    caller supplies to look something up) rather than something borrowed from elsewhere, and may still
    anchor an edge. Fixes a false edge where check_vulnerabilities echoes its own name/version arguments
    and a later get_package_info call for the same package looked, wrongly, like it depended on them."""
    raw = [_tokens(_output_text(e)) for e in steps]
    seen_before: set[str] = set()
    sources = []
    for i, call in enumerate(steps):
        stale_echo = set(_arg_values(call)) & raw[i] & seen_before
        sources.append(raw[i] - stale_echo)
        seen_before |= raw[i]
    return sources


def _build_edges(steps: list[dict]) -> set[tuple[int, int]]:
    """Happens-before edges within one run's own execution order: (i, j) means step i happens-before step
    j because some argument value of call j exactly equals a token call i genuinely produced (i < j, only
    earlier calls can be a data source; see _source_token_sets for what "genuinely produced" excludes)."""
    source_sets = _source_token_sets(steps)
    edges = set()
    for j, call in enumerate(steps):
        for v in _arg_values(call):
            for i in range(j):
                if v in source_sets[i]:
                    edges.add((i, j))
    return edges


def _is_sourced(e: dict, earlier_candidate_steps: list[dict], context_text: str) -> bool:
    """True if every argument value of e exactly equals a token in context_text (the prompts actually
    given to the model for this run) or in an earlier candidate call's output. False (unsourced) means at
    least one argument value was not found anywhere it could legitimately have come from -- e.g. a
    fabricated version string."""
    values = _arg_values(e)
    if not values:
        return True
    context_tokens = _tokens(context_text)
    earlier_token_sets = [_tokens(_output_text(c)) for c in earlier_candidate_steps]
    for v in values:
        if v in context_tokens or any(v in t for t in earlier_token_sets):
            continue
        return False
    return True


def _try_json(text: str):
    try:
        return json.loads(text)
    except (json.JSONDecodeError, TypeError):
        return None


def _deep_diff(a, b, path: str = "") -> dict:
    """Generic structural diff between two JSON-compatible values. No domain field names anywhere here."""
    diffs: dict = {}
    if isinstance(a, dict) and isinstance(b, dict):
        for k in sorted(set(a) | set(b)):
            p = f"{path}.{k}" if path else str(k)
            if k not in a:
                diffs[p] = (None, b[k])
            elif k not in b:
                diffs[p] = (a[k], None)
            else:
                diffs.update(_deep_diff(a[k], b[k], p))
    elif isinstance(a, list) and isinstance(b, list):
        for i, (x, y) in enumerate(zip(a, b)):
            diffs.update(_deep_diff(x, y, f"{path}[{i}]"))
        if len(a) != len(b):
            diffs[f"{path}.<length>"] = (len(a), len(b))
    elif a != b:
        diffs[path or "<root>"] = (a, b)
    return diffs


def _compare_trajectory(golden_steps: list[dict], candidate_steps: list[dict], context_text: str, include_missing: bool) -> tuple[list[StepReport], StepReport | None, int | None]:
    """Shared core for compare() and compare_halted(). Builds the golden<->candidate correspondence the
    same way GateToolTap did at runtime (per-key FIFO), finds leftover golden calls (only reported as
    MISSING_STEP when include_missing -- a --strict halt never gets there, so it isn't "missing"), and
    checks happens-before edges among matched calls.
    """
    g_idx_by_key: dict[tuple, deque] = defaultdict(deque)
    for i, e in enumerate(golden_steps):
        g_idx_by_key[_key(e)].append(i)

    g_to_c: dict[int, int] = {}
    c_to_g: dict[int, int] = {}
    for j, e in enumerate(candidate_steps):
        if e.get("gate_status") == "recorded":
            q = g_idx_by_key.get(_key(e))
            if q:
                gi = q.popleft()
                g_to_c[gi], c_to_g[j] = j, gi

    golden_edges = _build_edges(golden_steps)
    attribution_boundary = next((e["gate_step"] for e in candidate_steps if e.get("gate_status") == "unrecorded"), None)

    def attribution_for(step_no: int) -> str:
        return "ATTRIBUTABLE" if attribution_boundary is None or step_no <= attribution_boundary else "UNATTRIBUTED"

    steps: list[StepReport] = []
    first_divergence: StepReport | None = None

    for j, e in enumerate(candidate_steps):
        step_no = e["gate_step"]
        candidate_call = {"tool": e["input"]["name"], "args": e["input"].get("input", {})}
        golden_call = None
        cause = None

        if e.get("gate_status") == "unrecorded":
            cause = "UNRECORDED" if _is_sourced(e, candidate_steps[:j], context_text) else "UNSOURCED_ARGUMENT"
        else:
            gi = c_to_g.get(j)
            if gi is not None:
                g = golden_steps[gi]
                golden_call = {"tool": g["input"]["name"], "args": g["input"].get("input", {})}
                for (a, b) in golden_edges:
                    if b == gi and g_to_c.get(a) is not None and g_to_c[a] > j:
                        cause = "ORDER_VIOLATION"
                        break

        report = StepReport(step=step_no, golden=golden_call, candidate=candidate_call, gate_status=e.get("gate_status", "n/a"), cause=cause, attribution=attribution_for(step_no), mutated=bool(e.get("gate_mutated")))
        steps.append(report)
        if cause is not None and first_divergence is None:
            first_divergence = report

    if include_missing:
        base = candidate_steps[-1]["gate_step"] if candidate_steps else 0
        leftover = [i for q in g_idx_by_key.values() for i in q]
        for offset, gi in enumerate(sorted(leftover), start=1):
            g = golden_steps[gi]
            report = StepReport(
                step=base + offset,
                golden={"tool": g["input"]["name"], "args": g["input"].get("input", {})},
                candidate=None, gate_status="n/a", cause="MISSING_STEP",
                attribution=attribution_for(base + offset),
            )
            steps.append(report)
            if first_divergence is None:
                first_divergence = report

    return steps, first_divergence, attribution_boundary


def compare(golden_events: list, candidate_events: list, golden_answer: str, candidate_answer: str, context_text: str = "", fail_on_answer: bool = False) -> ComparisonResult:
    """Compare a completed candidate run against golden. See module docstring for what is and isn't compared.

    context_text is the system + user prompt actually given to the candidate model this run -- used only
    to decide whether an unrecorded call's arguments were legitimately given to the model (sourced) or
    fabricated (UNSOURCED_ARGUMENT). Verdict is trajectory-only; final-answer text is informational unless
    fail_on_answer is set, in which case a text-only difference is promoted to FAIL.
    """
    golden_steps = _tool_steps(golden_events)
    candidate_steps = _tool_steps(candidate_events)

    steps, first_divergence, attribution_boundary = _compare_trajectory(golden_steps, candidate_steps, context_text, include_missing=True)

    answer_matched = golden_answer == candidate_answer
    answer_diff = None
    if not answer_matched:
        g_json, c_json = _try_json(golden_answer), _try_json(candidate_answer)
        if g_json is not None and c_json is not None:
            answer_diff = _deep_diff(g_json, c_json) or None

    if first_divergence is None and not answer_matched and fail_on_answer:
        # Trajectories matched exactly; only the final text differs, and the caller opted into strict
        # text matching. attribution_boundary is guaranteed None here -- an unrecorded call would
        # already have set a cause above -- so this step is always ATTRIBUTABLE.
        final_step = StepReport(
            step=(candidate_steps[-1]["gate_step"] if candidate_steps else 0) + 1,
            golden={"answer": golden_answer}, candidate={"answer": candidate_answer},
            gate_status="n/a", cause="DIFFERENT_ANSWER", attribution="ATTRIBUTABLE",
        )
        steps.append(final_step)
        first_divergence = final_step

    verdict = "FAIL" if first_divergence is not None else "PASS"
    return ComparisonResult(
        steps=steps, first_divergence=first_divergence, attribution_boundary=attribution_boundary,
        verdict=verdict, answer_matched=answer_matched, answer_diff=answer_diff,
    )


def compare_halted(golden_events: list, candidate_events: list, halt_step: int, context_text: str = "") -> ComparisonResult:
    """Compare the completed prefix of a run halted by --strict at halt_step. Steps beyond the halt were
    never attempted -- golden calls not yet consumed are not reported as MISSING_STEP, since the run was
    stopped by the harness rather than by the agent's own behaviour. Always FAIL: the halt itself (an
    unrecorded call under --strict) is a trajectory-level issue, never a text-only one.
    """
    golden_steps = _tool_steps(golden_events)
    candidate_steps = _tool_steps(candidate_events)
    steps, first_divergence, _ = _compare_trajectory(golden_steps, candidate_steps, context_text, include_missing=False)
    return ComparisonResult(
        steps=steps, first_divergence=first_divergence, attribution_boundary=halt_step,
        verdict="FAIL", answer_matched=False, answer_diff=None,
    )
