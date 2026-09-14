"""Contract gate: run a scenario's agent live, tool outputs frozen from its reference recordings, then
check the candidate trajectory against the derived contract instead of against a single golden trace.

Reuses spike/gate.py's GateToolTap UNCHANGED for injection (it already matches purely on (tool_name,
args), so handing it the concatenated events of N reference runs instead of one just widens its per-key
FIFO queues -- no change to its logic). The attribution-boundary RULE is restated here rather than
imported, because spike/gate_compare.py's own implementation is entangled with its single-golden-trace
StepReport shape; the rule itself -- the gate_step of the first call GateToolTap could not match against
ANY reference recording -- is copied verbatim (see _attribution_for below) and is not a reinterpretation.
"""

from __future__ import annotations

import importlib
from dataclasses import dataclass, field

from . import forbids as forbids_mod
from . import paths
from . import portable
from .callsig import call_key
from .contract import Contract

paths.ensure_spike_importable()
from agent import COUNTS  # noqa: E402 (spike/agent.py's real-execution counters, unchanged)
from gate import GateToolTap, _parse_mutate_args, _token_totals  # noqa: E402
from gate_compare import CAUSES as _EXISTING_CAUSES  # noqa: E402
from gate_compare import _is_sourced  # noqa: E402

# FORBIDDEN is the one label this layer adds on top of gate_compare's five: none of MISSING_STEP /
# UNRECORDED / UNSOURCED_ARGUMENT / ORDER_VIOLATION / DIFFERENT_ANSWER represent a rule a human wrote by
# hand, as opposed to something inferred from comparing against one golden trace.
CAUSES = (*_EXISTING_CAUSES, "FORBIDDEN")


@dataclass
class ContractStep:
    step: int
    tool: str | None
    args: dict | None
    gate_status: str
    cause: str | None
    attribution: str
    detail: str = ""
    # spike/gate.py's GateToolTap sets gate_mutated on every candidate_trace item when --mutate touched
    # this step's injected result (unchanged code); dropped from this dataclass in the original contract
    # rewrite, silently -- a run made with --mutate showed no indication which step was altered, which a
    # human could misread as a real behavioral difference instead of the harness's own injected change.
    mutated: bool = False


@dataclass
class ContractResult:
    scenario: str
    steps: list[ContractStep]
    first_divergence: ContractStep | None
    attribution_boundary: int | None
    verdict: str
    candidate_answer: str
    n_model: int
    injected: int
    unrecorded: int
    tool_bodies: int  # real tool executions during this run -- must be 0; every result is injected
    input_tokens: int = 0
    output_tokens: int = 0


def merged_golden_events(reference_runs: list[dict]) -> list[dict]:
    """Flatten every reference run's events into one pool for GateToolTap. A candidate call matches if ANY
    reference run made that exact (tool, args) call -- GateToolTap keys purely on (tool_name, args), never
    on which run or position a stored result came from, so this is a drop-in widening, not a new rule."""
    events: list[dict] = []
    for run in reference_runs:
        events.extend(run["events"])
    return events


def run_and_evaluate(
    agent_module: str,
    prompt: str,
    contract: Contract,
    reference_runs: list[dict],
    *,
    model_id: str | None = None,
    system_prompt: str | None = None,
    mutations: dict[str, dict] | None = None,
    strict: bool = False,
) -> ContractResult:
    agent_mod = importlib.import_module(agent_module)
    # Reference recordings are stored PORTABLE (see agent_replay/portable.py); GateToolTap does exact
    # string equality against a live call's real arguments, so the pool it matches against must be
    # widened back to THIS machine's real repo root, or every path-bearing call would come back
    # "unrecorded" the moment the recording and the candidate run are on different machines/checkouts.
    golden_events = portable.absolute_events(merged_golden_events(reference_runs))
    tool_bodies_before = COUNTS["tool_bodies"]

    candidate_trace: list = []
    tap = GateToolTap(golden_events, candidate_trace, strict=strict, mutations=mutations or {})
    resolved_model_id = model_id or agent_mod.MODEL_ID
    resolved_system_prompt = system_prompt or agent_mod.SYSTEM_PROMPT
    agent, _model, tap = agent_mod.build_agent(
        candidate_trace, replay=False, model_id=resolved_model_id, system_prompt=resolved_system_prompt, tap=tap
    )

    # `prompt` (a scenario's `input`) is stored portable too; expand it to a real, fetchable path on THIS
    # machine before the live model actually reads anything.
    real_prompt = portable.to_absolute(prompt)
    candidate_answer = str(agent(real_prompt))
    candidate_steps = [e for e in candidate_trace if e["type"] == "tool"]
    context_text = f"{resolved_system_prompt} {real_prompt}"

    steps, first_divergence, attribution_boundary, verdict = _evaluate_steps(contract, candidate_steps, context_text)
    n_model = sum(e["type"] == "model" for e in candidate_trace)
    in_tok, out_tok = _token_totals(candidate_trace)  # spike/gate.py, unchanged
    return ContractResult(
        scenario=contract.scenario, steps=steps, first_divergence=first_divergence,
        attribution_boundary=attribution_boundary, verdict=verdict, candidate_answer=candidate_answer,
        n_model=n_model, injected=tap.injected, unrecorded=tap.unrecorded,
        tool_bodies=COUNTS["tool_bodies"] - tool_bodies_before,
        input_tokens=in_tok, output_tokens=out_tok,
    )


def _evaluate_steps(
    contract: Contract, candidate_steps: list[dict], context_text: str
) -> tuple[list[ContractStep], ContractStep | None, int | None, str]:
    require_keys = contract.require_keys()
    permit_keys = contract.permit_keys()

    # Attribution boundary: spike/gate_compare.py's rule, restated verbatim (see module docstring) -- the
    # gate_step of the first call the tap could not match against anything in the reference pool.
    attribution_boundary = next((e["gate_step"] for e in candidate_steps if e.get("gate_status") == "unrecorded"), None)

    def attribution_for(step_no: int) -> str:
        return "ATTRIBUTABLE" if attribution_boundary is None or step_no <= attribution_boundary else "UNATTRIBUTED"

    violations_by_step: dict[int, list] = {}
    for v in forbids_mod.evaluate(contract.forbids, candidate_steps):
        violations_by_step.setdefault(v.step, []).append(v)

    order_seen: set[str] = set()
    steps: list[ContractStep] = []
    first_divergence: ContractStep | None = None
    called_by_key: set[tuple[str, str]] = set()

    for idx, e in enumerate(candidate_steps):
        step_no = e["gate_step"]
        name = e["input"]["name"]
        args = e["input"].get("input", {}) or {}
        # The contract's own requires/permits keys are portable (loaded straight from the committed
        # file); `args` here is real/absolute (this run's actual, executable arguments). Collapse ONLY
        # for the membership check -- `report.args` below stays the real value, for honest reporting of
        # what actually happened on this run.
        key = call_key(name, portable.portable_value(args))
        called_by_key.add(key)
        cause = None
        detail = ""

        if key not in require_keys and key not in permit_keys:
            # Not declared at all. GateToolTap's injection pool IS require-union-permits, so this call was
            # necessarily "unrecorded" at runtime too -- reuse gate_compare's own UNRECORDED /
            # UNSOURCED_ARGUMENT split unchanged.
            cause = "UNRECORDED" if _is_sourced(e, candidate_steps[:idx], context_text) else "UNSOURCED_ARGUMENT"
            detail = f"{name} is not in requires or permits"
        elif step_no in violations_by_step:
            cause = "FORBIDDEN"
            detail = violations_by_step[step_no][0].detail
        else:
            for before, after in contract.order:
                if after == name and before not in order_seen:
                    cause = "ORDER_VIOLATION"
                    detail = f"no prior {before} call ({before} -> {after})"
                    break

        order_seen.add(name)
        report = ContractStep(step=step_no, tool=name, args=args, gate_status=e.get("gate_status", "n/a"), cause=cause, attribution=attribution_for(step_no), detail=detail, mutated=bool(e.get("gate_mutated")))
        steps.append(report)
        if cause is not None and first_divergence is None:
            first_divergence = report

    base = candidate_steps[-1]["gate_step"] if candidate_steps else 0
    offset = 0
    for tool, args in contract.requires:
        if call_key(tool, args) in called_by_key:
            continue
        offset += 1
        step_no = base + offset
        report = ContractStep(step=step_no, tool=tool, args=args, gate_status="n/a", cause="MISSING_STEP", attribution=attribution_for(step_no), detail="required but never called")
        steps.append(report)
        if first_divergence is None:
            first_divergence = report

    verdict = "FAIL" if first_divergence is not None else "PASS"
    return steps, first_divergence, attribution_boundary, verdict
