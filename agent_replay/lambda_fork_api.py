"""Phase 2.1 (docs/DECISIONS.md): the fork API -- fast, synchronous, deliberately strands-agents-free (see
agent_replay/fork.py's own module docstring for why: this Lambda never runs an agent, only validates a
request and either kicks off the async worker or reports what it has written so far).

    POST /forks              validate (2.1.1), invoke agent_replay/lambda_fork_worker.py asynchronously
                              (InvocationType="Event"), return 202 + {fork_id, poll_url}
    GET  /forks/{fork_id}    events with sequence_number > ?after=<n>, plus status
    GET  /forks/preview/{scenario}/{tool}
                              Phase 2.2: {"fields": {name: recorded_value, ...}} for one tool's recorded
                              output -- the mutation editor (RunInspector's "Fork from here") needs the
                              actual recorded VALUES to prefill each row, not just the field NAMES the
                              400-response's "known_fields" already carried; this is the one thing 2.1's
                              own validation logic didn't need but 2.2's UI cannot honestly work without.

A Lambda cannot return early and keep running -- a fork takes 20-40s and API Gateway kills a synchronous
integration at 29s, so this is TWO functions, this one fast and synchronous, the other
(lambda_fork_worker.py) invoked async and left to run up to its own 300s timeout. See docs/DECISIONS.md's
Phase 2.1 entry for the full reasoning.

DELIBERATELY does not import agent_replay.contract / agent_replay.callsig / agent_replay._spike.storage --
all three pull in the full strands-agents SDK transitively via agent_replay._spike.agent's top-level
`from strands import ...`. Validating a contract's tool/field names is done here by reading the YAML text
directly with plain PyYAML and a small regex mirroring callsig.render_call's own `tool(arg=value)` format,
and DynamoDB/S3 are read/written with raw boto3 -- small, deliberate duplication of the exact shape
agent_replay/lambda_handler.py already uses for the read API, not a second source of truth for anything
record/test/gate themselves do.
"""

from __future__ import annotations

import json
import logging
import os
import time
import uuid
from decimal import Decimal

import boto3
import yaml

_logger = logging.getLogger()
_logger.setLevel(logging.INFO)

_REGION = os.environ.get("AWS_REGION", "ap-south-1")
_TABLE_NAME = os.environ["AGENT_REPLAY_TABLE"]
_BUCKET_NAME = os.environ["AGENT_REPLAY_BUCKET"]
_WORKER_FUNCTION = os.environ["FORK_WORKER_FUNCTION_NAME"]
# Matches agent_replay/paths.py's own project_root() convention (agent-replay/scenarios.yaml, next to the
# contracts it backs) -- bundled as static files in this Lambda's own deployment package (they are a few
# KB of text, not something worth a network round trip to fetch), at exactly the relative layout
# agent_replay/paths.py expects, so the SAME files work unmodified if this ever imports that module.
_PROJECT_ROOT = os.environ.get("AGENT_REPLAY_ROOT", "/var/task")
# 2.1.5 orphan handling: enforced HERE, on every GET, not by the frontend -- this Lambda already has
# started_at and "running" sitting right there, so no client-side timer or clock-skew guess is needed, and
# every poller (even one that starts mid-run) sees the identical answer.
_ORPHAN_CEILING_SECONDS = 180

_ddb = boto3.resource("dynamodb", region_name=_REGION).Table(_TABLE_NAME)
_s3 = boto3.client("s3", region_name=_REGION)
_lambda = boto3.client("lambda", region_name=_REGION)

_CORS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "content-type",
}


class _DdbJsonEncoder(json.JSONEncoder):
    def default(self, o):
        if isinstance(o, Decimal):
            return int(o) if o == o.to_integral_value() else float(o)
        return super().default(o)


def _response(status: int, body) -> dict:
    return {"statusCode": status, "headers": {**_CORS, "Content-Type": "application/json"}, "body": json.dumps(body, cls=_DdbJsonEncoder)}


# ------------------------------------------------------------------ strands-free scenario/contract reads


def _tool_name(rendered_call_line: str) -> str:
    """"agent.tool(arg=value, ...)" or "tool(arg=value, ...)" -> "tool" -- callsig.render_call's own
    format, parsed with a plain string op instead of importing agent_replay.callsig (see module docstring:
    that import pulls in the full strands-agents SDK transitively)."""
    tool_part = rendered_call_line.strip().lstrip("-").strip().partition("(")[0]
    return tool_part.rpartition(".")[2] if "." in tool_part else tool_part


def _load_scenario(name: str) -> dict | None:
    path = os.path.join(_PROJECT_ROOT, "agent-replay", "scenarios.yaml")
    with open(path, encoding="utf-8") as f:
        data = yaml.safe_load(f) or {}
    for s in data.get("scenarios") or []:
        if s.get("name") == name:
            return {
                "name": s["name"], "agent": s["agent"], "input": s["input"],
                "runs": int(s.get("runs", 1)), "pass_through": list(s.get("pass_through") or []),
            }
    return None


def _load_contract(scenario_name: str) -> tuple[set[str], int]:
    """Returns (every tool name appearing in requires+permits, n_runs) -- everything POST /forks needs to
    validate a mutation's `tool` without agent_replay.contract."""
    path = os.path.join(_PROJECT_ROOT, "agent-replay", "contracts", f"{scenario_name}.yaml")
    with open(path, encoding="utf-8") as f:
        raw = yaml.safe_load(f) or {}
    lines = [str(s) for s in (raw.get("requires") or [])] + [str(s) for s in (raw.get("permits") or [])]
    return {_tool_name(s) for s in lines}, int(raw.get("runs", 1))


def _parse_output_values(text: str) -> dict:
    """Mirrors agent_replay/_spike/gate.py's own _try_json/_parse_kv field extraction (JSON object first,
    falling back to "k=v; k=v") without importing that module -- see this file's own docstring for why.
    Returns the actual VALUES, not just the field names -- values a plain 'k=v' tool emits are always
    strings (spike/agent.py's own toy tools), matching what _apply_mutation would merge back in either
    representation."""
    try:
        parsed = json.loads(text)
        if isinstance(parsed, dict):
            return parsed
    except json.JSONDecodeError:
        pass
    return dict(pair.split("=", 1) for pair in text.split("; ") if "=" in pair)


def _iter_golden_tool_outputs(scenario_name: str, tool: str, n_runs: int):
    """Yields the parsed output dict for every recorded call to `tool` across the scenario's N reference
    runs, read directly off DynamoDB (event index) + S3 (golden/<hash>.json payload) -- the same two calls
    agent_replay/lambda_handler.py already makes elsewhere in this project, reimplemented here rather than
    imported for the same reason (see module docstring)."""
    for i in range(1, n_runs + 1):
        run_id = f"{scenario_name}--{i}"
        items = _ddb.query(KeyConditionExpression="run_id = :r", ExpressionAttributeValues={":r": run_id})["Items"]
        for it in items:
            if it.get("item_type") != "event" or it.get("event_type") != "tool" or it.get("actor") != tool:
                continue
            try:
                obj = _s3.get_object(Bucket=_BUCKET_NAME, Key=f"golden/{it['output_hash']}.json")
            except _s3.exceptions.ClientError:
                continue
            payload = json.loads(obj["Body"].read().decode("utf-8"))
            content = payload.get("content") or []
            if content and "text" in content[0]:
                yield _parse_output_values(content[0]["text"])


def _golden_output_fields(scenario_name: str, tool: str, n_runs: int) -> set[str]:
    fields: set[str] = set()
    for values in _iter_golden_tool_outputs(scenario_name, tool, n_runs):
        fields |= values.keys()
    return fields


def _golden_output_values(scenario_name: str, tool: str, n_runs: int) -> dict:
    """One representative value per field -- the FIRST recorded call to `tool` (across the N reference
    runs, in order) that carries it. Reference runs already document natural variance (docs/LIMITATIONS.md)
    but this is a PREFILL for a human to then edit, not a claim about which run is canonical."""
    values: dict = {}
    for run_values in _iter_golden_tool_outputs(scenario_name, tool, n_runs):
        for k, v in run_values.items():
            values.setdefault(k, v)
    return values


# ------------------------------------------------------------------ POST /forks


def handle_post_fork(event: dict) -> dict:
    try:
        body = json.loads(event.get("body") or "{}")
    except json.JSONDecodeError:
        return _response(400, {"error": "invalid JSON body"})

    scenario_name = body.get("scenario")
    if not scenario_name:
        return _response(400, {"error": "scenario is required"})
    scenario = _load_scenario(scenario_name)
    if scenario is None:
        return _response(400, {"error": f"unknown scenario {scenario_name!r}"})

    try:
        known_tools, n_runs = _load_contract(scenario_name)
    except FileNotFoundError:
        return _response(400, {"error": f"no contract for {scenario_name!r}; run `agent-replay record {scenario_name}` first"})

    mutations = body.get("mutations") or []
    if len(mutations) != 1:
        return _response(400, {"error": f"exactly one mutation is supported in v1, got {len(mutations)}"})
    m = mutations[0]
    tool, field, value = m.get("tool"), m.get("field"), m.get("value")
    if not tool or field is None:
        return _response(400, {"error": "each mutation needs 'tool' and 'field'"})
    if tool not in known_tools:
        return _response(400, {"error": f"tool {tool!r} does not appear in the {scenario_name!r} golden trace", "known_tools": sorted(known_tools)})

    known_fields = _golden_output_fields(scenario_name, tool, n_runs)
    if field not in known_fields:
        return _response(400, {"error": f"field {field!r} does not exist on {tool!r}'s recorded output", "known_fields": sorted(known_fields)})

    fork_id = uuid.uuid4().hex[:12]
    run_id = f"fork#{fork_id}"
    _ddb.put_item(Item={
        "run_id": run_id, "sequence_number": 0, "item_type": "fork_metadata",
        "scenario": scenario_name, "mutations_json": json.dumps(mutations), "status": "running",
        "started_at": Decimal(str(time.time())), "client_run_id": body.get("run_id"),
    })
    # 1. ASYNC INVOKE: returns immediately, the worker keeps running detached from this request/response.
    _lambda.invoke(
        FunctionName=_WORKER_FUNCTION, InvocationType="Event",
        Payload=json.dumps({"fork_id": fork_id, "scenario": scenario_name, "tool": tool, "field": field, "value": value}).encode("utf-8"),
    )
    # 6: the 202 body includes fork_id AND the poll URL -- the frontend never constructs it itself.
    return _response(202, {"fork_id": fork_id, "poll_url": f"/forks/{fork_id}"})


# ------------------------------------------------------------------ GET /forks/preview/{scenario}/{tool}


def handle_get_preview(event: dict) -> dict:
    params = event.get("pathParameters") or {}
    scenario_name, tool = params.get("scenario"), params.get("tool")
    if not scenario_name or not tool:
        return _response(400, {"error": "missing scenario or tool"})
    scenario = _load_scenario(scenario_name)
    if scenario is None:
        return _response(400, {"error": f"unknown scenario {scenario_name!r}"})
    try:
        known_tools, n_runs = _load_contract(scenario_name)
    except FileNotFoundError:
        return _response(400, {"error": f"no contract for {scenario_name!r}"})
    if tool not in known_tools:
        return _response(400, {"error": f"tool {tool!r} does not appear in the {scenario_name!r} golden trace", "known_tools": sorted(known_tools)})
    values = _golden_output_values(scenario_name, tool, n_runs)
    return _response(200, {"scenario": scenario_name, "tool": tool, "fields": values})


# ------------------------------------------------------------------ GET /forks/{fork_id}


def handle_get_fork(event: dict) -> dict:
    fork_id = (event.get("pathParameters") or {}).get("fork_id")
    if not fork_id:
        return _response(400, {"error": "missing fork_id"})
    after = int((event.get("queryStringParameters") or {}).get("after") or 0)
    run_id = f"fork#{fork_id}"

    items = _ddb.query(KeyConditionExpression="run_id = :r", ExpressionAttributeValues={":r": run_id})["Items"]
    if not items:
        return _response(404, {"error": f"no fork {fork_id!r}"})
    meta = next(i for i in items if int(i["sequence_number"]) == 0)
    new_events = sorted((i for i in items if int(i["sequence_number"]) > after), key=lambda i: int(i["sequence_number"]))
    events = [json.loads(i["event"]) for i in new_events]
    cursor = max((int(i["sequence_number"]) for i in items), default=after)

    status = meta.get("status", "running")
    started_at = float(meta.get("started_at", 0))
    # 5. ORPHAN HANDLING: if the worker died without ever writing a terminal event, a poller must not hang
    # forever -- surfaced here (the API), not left to the frontend, so every poller agrees regardless of
    # when it started watching.
    if status == "running" and time.time() - started_at > _ORPHAN_CEILING_SECONDS:
        status = "failed"
        cursor += 1
        events = events + [{
            "type": "error", "transient": False,
            "message": f"fork {fork_id} produced no terminal event within {_ORPHAN_CEILING_SECONDS}s -- the worker likely crashed or timed out without reporting",
        }]
    return _response(200, {"fork_id": fork_id, "status": status, "cursor": cursor, "events": events})


_ROUTES = {
    ("POST", "/forks"): handle_post_fork,
    ("GET", "/forks/preview/{scenario}/{tool}"): handle_get_preview,
    ("GET", "/forks/{fork_id}"): handle_get_fork,
}


def handler(event: dict, context) -> dict:
    method = event.get("requestContext", {}).get("http", {}).get("method", "GET")
    if method == "OPTIONS":
        return _response(200, {})
    route_key = event.get("routeKey", "")
    _, _, route_path = route_key.partition(" ")
    fn = _ROUTES.get((method, route_path))
    if fn is None:
        return _response(404, {"error": f"no route for {method} {route_path}"})
    try:
        return fn(event)
    except Exception:
        # Full detail to CloudWatch only -- see agent_replay/lambda_handler.py's own precedent and reasoning.
        _logger.exception("Unhandled error in %s %s", method, route_path)
        return _response(500, {"error": "internal server error"})
