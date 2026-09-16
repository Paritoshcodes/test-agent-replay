"""Phase 2.1 (docs/DECISIONS.md): the fork worker -- the slow (up to ~40s), asynchronous half of the fork
endpoint. Invoked with InvocationType="Event" by agent_replay/lambda_fork_api.py's POST /forks handler, so
it runs detached from any API Gateway request/timeout; writes each event agent_replay.fork.run_fork
produces to DynamoDB the instant it happens, so a poller sees them arrive one at a time over the run's real
duration, not all at once at the end.

Heavy on purpose: imports agent_replay.contract/fork, which transitively pull in the full strands-agents
SDK (agent_replay/_spike/agent.py's own top-level `from strands import ...`) -- this Lambda's deployment
package bundles it; the sibling API Lambda (agent_replay/lambda_fork_api.py) deliberately does not, so its
fast synchronous POST/GET endpoints never pay for that import at all. See docs/DECISIONS.md's Phase 2.1
entry for the two-Lambda split and the packaging this requires.
"""

from __future__ import annotations

import json
import logging
import os
import time
from decimal import Decimal

import boto3

from . import fork as fork_mod
from . import paths
from .contract import load as load_contract
from .scenarios import load_scenarios_file

_logger = logging.getLogger()
_logger.setLevel(logging.INFO)

_REGION = os.environ.get("AWS_REGION", "ap-south-1")
_TABLE_NAME = os.environ["AGENT_REPLAY_TABLE"]
_ddb = boto3.resource("dynamodb", region_name=_REGION).Table(_TABLE_NAME)


def _persist_dashboard(fork_id: str, spec: fork_mod.ForkSpec, result) -> str:
    """2.1.5: persists the fork's own comparison result via the EXISTING save_test_run path, run_kind
    "fork", under its OWN run_id (`<scenario>--fork--<fork_id>`) -- deliberately NOT the polling key
    (`fork#<fork_id>`, sequence_number 0 of which is this worker's own status/started_at item) since
    save_test_run's own run_metadata item would otherwise silently clobber that polling record the moment a
    fork completes. This is a real, permanent run: agent_replay/lambda_handler.py's existing GET
    /runs/{run_id} can load it afterwards with zero changes, exactly as 2.1.5 asks."""
    from . import dashboard as dashboard_mod
    from ._spike.storage import AwsTraceStorage

    reference = fork_mod.load_reference_runs(spec.scenario, spec.contract)
    ref = reference[0]
    dashboard_run_id = f"{spec.scenario.name}--fork--{fork_id}"
    gate_run = dashboard_mod.build_gate_run(
        result=result, run_id=dashboard_run_id, scenario_agent=spec.scenario.agent,
        golden_prompt=ref["prompt"], golden_final_answer=ref["final_answer"],
        golden_final_answer_sha256=ref["final_answer_sha256"], model_id=None,
    )
    AwsTraceStorage().save_test_run(
        dashboard_run_id,
        {"agent_module": spec.scenario.agent, "scenario": spec.scenario.name, "verdict": result.verdict, "run_kind": "fork"},
        gate_run,
    )
    return dashboard_run_id


def handler(payload: dict, context) -> None:
    """`payload` is exactly what lambda_fork_api.py's handle_post_fork Payload=json.dumps(...)'d:
    {"fork_id", "scenario", "tool", "field", "value"}. Returns nothing -- this is an async (Event) invoke,
    nobody is waiting on a return value; every outcome (each step, the final answer, done/error) is
    communicated by writing to DynamoDB, which is the only channel a poller can see."""
    fork_id = payload["fork_id"]
    run_id = f"fork#{fork_id}"
    seq = [0]  # sequence_number 0 is the metadata item lambda_fork_api.py already wrote; events start at 1

    def persist(event: dict) -> None:
        seq[0] += 1
        _ddb.put_item(Item={
            "run_id": run_id, "sequence_number": seq[0], "item_type": "fork_event",
            "event": json.dumps(event), "written_at": Decimal(str(time.time())),
        })
        if event["type"] in ("done", "error"):
            _ddb.update_item(
                Key={"run_id": run_id, "sequence_number": 0},
                UpdateExpression="SET #s = :s",
                ExpressionAttributeNames={"#s": "status"},
                ExpressionAttributeValues={":s": "complete" if event["type"] == "done" else "failed"},
            )

    try:
        scenarios, _ = load_scenarios_file(paths.scenarios_path())
        scenario = next((s for s in scenarios if s.name == payload["scenario"]), None)
        if scenario is None:
            persist({"type": "error", "transient": False, "message": f"unknown scenario {payload['scenario']!r} (worker's own bundled scenarios.yaml)"})
            return
        contract = load_contract(paths.contract_path(scenario.name))
        spec = fork_mod.ForkSpec(scenario=scenario, contract=contract, tool=payload["tool"], field=payload["field"], value=payload["value"])
    except Exception as e:
        _logger.exception("fork %s failed before run_fork even started", fork_id)
        persist({"type": "error", "transient": False, "message": f"{type(e).__name__}: {e}"})
        return

    result = fork_mod.run_fork(spec, on_event=persist)
    if result is not None:
        try:
            _persist_dashboard(fork_id, spec, result)
        except Exception:
            # 2.1.5's dashboard persistence is a nice-to-have on top of the actual fork result the frontend
            # already has via polling (same tolerance agent_replay/cli.py's _persist_for_dashboard already
            # applies to the CLI's own candidate-run persistence) -- never turn a real, already-completed,
            # already-streamed fork into a reported failure just because this extra write didn't land.
            _logger.exception("fork %s completed but dashboard persistence failed", fork_id)
