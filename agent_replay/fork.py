"""Phase 2.1 (docs/DECISIONS.md): a fork is gate replay with exactly one mutation, its steps emitted one at
a time as the live run actually produces them, instead of printed as a finished report. This is the SAME
execution path `agent-replay gate <scenario> --mutate TOOL:JSON` already takes -- agent_replay.evaluate.
run_and_evaluate, agent_replay._spike.gate.GateToolTap._apply_mutation, agent_replay.cli's own
transient-retry rule -- reused here, not reimplemented a second time.

Deliberately heavy (imports agent_replay.contract / agent_replay.evaluate, which pull in the full
strands-agents SDK transitively via agent_replay._spike.agent -- see that module's own docstring). This is
the WORKER side only: request validation (agent_replay/fork_api.py) runs in a separate, lightweight Lambda
that never imports this module, precisely so a fork's fast synchronous POST/GET endpoints never pay for
strands-agents at all. See docs/DECISIONS.md's Phase 2.1 entry for the two-Lambda split and why.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass

from . import evaluate as evaluate_mod
from . import paths
from .cli import _is_transient
from .contract import Contract
from .scenarios import Scenario


@dataclass
class ForkSpec:
    """Everything run_fork needs to actually run -- already validated (agent_replay/fork_api.py's job, not
    this module's) by the time it reaches here. tool/field/value describe the ONE mutation v1 supports
    (2.2.1: "Only ONE field may be mutated at a time in v1")."""

    scenario: Scenario
    contract: Contract
    tool: str
    field: str
    value: object


def load_reference_runs(scenario: Scenario, contract: Contract) -> list[dict]:
    """--storage aws only: a fork always runs somewhere with no access to this project's local traces/
    directory (a Lambda), unlike `agent-replay test`/`gate`'s own --storage local default."""
    from ._spike.storage import AwsTraceStorage

    storage = AwsTraceStorage()
    return [storage.load(paths.reference_run_id(scenario.name, i)) for i in range(1, contract.n_runs + 1)]


def run_fork(spec: ForkSpec, on_event: Callable[[dict], None]) -> evaluate_mod.ContractResult | None:
    """Runs exactly one fork, calling `on_event` with each NDJSON-shaped dict from the event protocol
    (docs/DECISIONS.md's Phase 2.1.2) as it becomes known. Field names inside a "step" event are exactly
    ContractStep's own field names (step/agent/tool/args/cause/attribution/mutated/membership) -- no
    parallel shape invented for this. ALWAYS ends by calling on_event with exactly one terminal event,
    "done" or "error" -- never returns having emitted neither (2.1.4). Returns the ContractResult on success
    (None on failure) so the caller (agent_replay/lambda_fork_worker.py) can persist it via save_test_run
    (2.1.5) -- this function itself does no persistence, it only runs and streams."""
    reference = load_reference_runs(spec.scenario, spec.contract)
    mutations = {spec.tool: {spec.field: spec.value}}

    def on_step(step: evaluate_mod.ContractStep) -> None:
        on_event({
            "type": "step", "step": step.step, "agent": step.agent, "tool": step.tool, "args": step.args,
            "cause": step.cause, "attribution": step.attribution, "mutated": step.mutated, "membership": step.membership,
        })

    def attempt() -> evaluate_mod.ContractResult:
        return evaluate_mod.run_and_evaluate(
            spec.scenario.agent, spec.scenario.input, spec.contract, reference,
            mutations=mutations, pass_through=spec.scenario.pass_through, on_step=on_step,
        )

    # Retry-once-on-transient, matching agent_replay/cli.py's _run_scenario/cmd_gate exactly (same
    # _is_transient marker list, same "retry once, only the retry's own outcome is ever reported"
    # semantics) -- imported from there rather than re-copied, so the two can never drift apart. Any step
    # events the FIRST attempt already emitted (real, live, via on_step above) stay emitted -- this module
    # does not attempt to hide or unwind them from the stream if a retry follows; see docs/DECISIONS.md for
    # why that's a disclosed v1 limitation, not a silent gap.
    try:
        result = attempt()
    except Exception as e:
        if not _is_transient(e):
            on_event({"type": "error", "transient": False, "message": f"{type(e).__name__}: {e}"})
            return None
        try:
            result = attempt()
        except Exception as e2:
            on_event({"type": "error", "transient": _is_transient(e2), "message": f"{type(e2).__name__}: {e2}"})
            return None

    on_event({"type": "answer", "text": result.candidate_answer, "sha256": _sha256(result.candidate_answer)})
    on_event({
        "type": "done", "verdict": result.verdict, "exit_code": 0 if result.verdict == "PASS" else 1,
        "counters": {
            "model_calls": result.n_model, "injected": result.injected, "unrecorded": result.unrecorded,
            "tool_bodies": result.tool_bodies,
        },
    })
    return result


def _sha256(text: str) -> str:
    from ._spike.agent import sha256

    return sha256(text)
