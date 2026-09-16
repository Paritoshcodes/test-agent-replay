"""Maps a ContractResult (agent_replay/evaluate.py's own shape) onto the GateRun/ComparisonResult shape
web/src/types/gate.ts already defines and web/src/engine/model.ts already renders -- so the dashboard's
Fork screen keeps working completely unchanged; only where its data comes from is new (see
docs/DECISIONS.md, Phase 2). No field is invented here that GateRun didn't already have.

The one real reconciliation this needs: the original shape pairs each step against ONE golden trace
(golden/candidate per StepReport). A contract has no single golden trace -- it has N reference runs and a
requires/permits SET. The mapping below is honest about what that set membership actually proves:
  - gate_status == "recorded" (this exact call matched something in the reference pool): golden AND
    candidate both point at the SAME call. It really did happen in a reference run; there is no more
    specific "the" golden call to distinguish it from.
  - cause == "MISSING_STEP" (a `requires` call never made): golden-only, candidate null -- exactly what
    the original shape already meant by that combination.
  - anything else (unrecorded / unsourced -- the call matched NOTHING in the pool): candidate-only, golden
    null -- exactly what the original shape already meant by "a candidate call with no golden counterpart".
"""

from __future__ import annotations

from .evaluate import ContractResult, ContractStep


def _call(step: ContractStep) -> dict | None:
    if step.tool is None:
        return None
    return {"tool": step.tool, "args": step.args or {}}


def _step_report(step: ContractStep) -> dict:
    call = _call(step)
    if step.cause == "MISSING_STEP":
        golden, candidate = call, None
    elif step.gate_status == "recorded":
        golden, candidate = call, call
    else:
        golden, candidate = None, call
    return {
        "step": step.step, "golden": golden, "candidate": candidate,
        "gate_status": step.gate_status, "cause": step.cause, "attribution": step.attribution, "mutated": step.mutated,
        "agent": step.agent, "membership": step.membership,
    }


def build_gate_run(
    *,
    result: ContractResult,
    run_id: str,
    scenario_agent: str,
    golden_prompt: str,
    golden_final_answer: str,
    golden_final_answer_sha256: str,
    model_id: str | None = None,
) -> dict:
    """`result` is what agent_replay/evaluate.py's run_and_evaluate() just computed. The golden_* args are
    the representative reference run picked for DISPLAY (the first of the scenario's N reference
    recordings, run_id `<scenario>--1`) -- real, recorded text, just not uniquely "the" golden anymore
    (see module docstring)."""
    steps = [_step_report(s) for s in result.steps]
    first_divergence = next((s for s in steps if result.first_divergence and s["step"] == result.first_divergence.step), None)
    answer_matched = result.candidate_answer == golden_final_answer

    return {
        "args": {
            "trace": None, "run_id": run_id, "storage": "aws",
            "prompt": None, "model_id": model_id, "strict": False, "fail_on_answer": False,
            "mutate": [], "agent_module": scenario_agent,
        },
        "golden": {
            "prompt": golden_prompt, "final_answer": golden_final_answer, "final_answer_sha256": golden_final_answer_sha256,
        },
        "candidate_answer": result.candidate_answer,
        "result": {
            "steps": steps, "first_divergence": first_divergence, "attribution_boundary": result.attribution_boundary,
            "pass_through_boundary": result.pass_through_boundary,
            "verdict": result.verdict, "answer_matched": answer_matched, "answer_diff": None,
        },
        "counters": {
            "n_model": result.n_model, "injected": result.injected, "unrecorded": result.unrecorded, "tool_bodies": result.tool_bodies,
        },
        "tokens": {"input_tokens": result.input_tokens, "output_tokens": result.output_tokens},
    }
