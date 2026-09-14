"""Dashboard read/accept API. API Gateway HTTP API (payload format 2.0) -> this one Lambda, routed by
method+path.

    GET  /runs/{run_id}        -> the GateRun-shaped comparison result agent_replay/cli.py persisted at
                                   test time (agent_replay/dashboard.py's shape). 404 if never persisted.
    GET  /commits/{sha}        -> every scenario's verdict for one commit, via CommitIndex
                                   (infra/template.yaml's GSI, Phase 5) -- a real Query, not a table Scan.
    GET  /scenarios             -> latest verdict per scenario. No GSI backs "by scenario" (Phase 5 built
                                   exactly one index, for exactly the commit-lookup need it was asked for),
                                   so this is a bounded Scan -- fine at this project's own documented CI
                                   scale (docs/LIMITATIONS.md, "Scaling boundaries"), not a design meant to
                                   scale past it, and not pretending otherwise.
    POST /runs/{run_id}/accept -> Phase 3's accept flow. Body {"accepted_by": str}. Records who and when
                                   in the run's own metadata item ONLY -- never touches a contract file;
                                   see README.md "How an accepted change reaches the repo" for why.

DELIBERATELY does not import spike/storage.py's AwsTraceStorage, unlike agent_replay/cli.py. That class's
own module needs `from agent import canonical, sha256` (spike/agent.py), which imports the full
strands-agents SDK at module load time -- fine for the CLI, which needs strands anyway to run a live
agent, but this Lambda never runs an agent: it only reads/updates DynamoDB items and reads S3 objects
someone else already wrote. Pulling in strands-agents (and its own dependency chain) here would mean a
Lambda Layer and a multi-MB deployment for four boto3 calls. The four calls this file actually makes
(S3 GetObject, DynamoDB Query/Scan/UpdateItem) are reimplemented directly against boto3 below instead --
small, deliberate duplication, not a second source of truth for anything agent_replay/spike/storage.py
does at RECORD time (this file never writes a trace or a comparison, only reads and annotates).

Table/bucket names: same env-var-or-describe_stacks resolution spike/storage.py uses, duplicated here for
the same reason as above. The deploy template sets AGENT_REPLAY_TABLE/AGENT_REPLAY_BUCKET directly as
Lambda environment variables (CloudFormation already knows both from the data stack's own parameters), so
describe_stacks is never actually called at runtime -- cheaper and one fewer IAM permission than the CLI's
own default path needs.
"""

from __future__ import annotations

import datetime
import json
import logging
import os

import boto3

_logger = logging.getLogger()
_logger.setLevel(logging.INFO)

_REGION = os.environ.get("AWS_REGION", "ap-south-1")
_TABLE_NAME = os.environ["AGENT_REPLAY_TABLE"]
_BUCKET_NAME = os.environ["AGENT_REPLAY_BUCKET"]

_ddb = boto3.resource("dynamodb", region_name=_REGION).Table(_TABLE_NAME)
_s3 = boto3.client("s3", region_name=_REGION)

_CORS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "content-type",
}


def _response(status: int, body) -> dict:
    return {"statusCode": status, "headers": {**_CORS, "Content-Type": "application/json"}, "body": json.dumps(body)}


def _param(event: dict, name: str) -> str | None:
    return (event.get("pathParameters") or {}).get(name)


def handle_get_run(event: dict) -> dict:
    run_id = _param(event, "run_id")
    if not run_id:
        return _response(400, {"error": "missing run_id"})
    try:
        obj = _s3.get_object(Bucket=_BUCKET_NAME, Key=f"comparisons/{run_id}.json")
    except _s3.exceptions.ClientError as e:
        if e.response["Error"]["Code"] in ("NoSuchKey", "404"):
            return _response(404, {"error": f"no comparison result for run_id {run_id!r} -- it may never have been recorded with --storage aws, or is a reference recording, not a candidate test run"})
        raise
    return _response(200, json.loads(obj["Body"].read().decode("utf-8")))


def handle_get_commit(event: dict) -> dict:
    sha = _param(event, "sha")
    if not sha:
        return _response(400, {"error": "missing sha"})
    items = _ddb.query(IndexName="CommitIndex", KeyConditionExpression="commit_sha = :sha", ExpressionAttributeValues={":sha": sha})["Items"]
    # CommitIndex is sparse by construction (agent_replay/cli.py only writes commit_sha under CI) and
    # carries both reference recordings AND candidate test runs for that commit -- only candidates have a
    # verdict, which is exactly what a triage view needs, so reference items are dropped here.
    runs = [
        {
            "run_id": i["run_id"], "scenario": i.get("scenario"), "verdict": i.get("verdict"),
            "agent_module": i.get("agent_module"), "branch": i.get("branch"), "pr_number": i.get("pr_number"),
            "triggered_by": i.get("triggered_by"), "created_at": i.get("created_at"),
            "accepted_by": i.get("accepted_by"), "accepted_at": i.get("accepted_at"),
        }
        for i in items
        if i.get("run_kind") == "candidate"
    ]
    return _response(200, {"commit_sha": sha, "runs": runs})


def handle_get_scenarios(event: dict) -> dict:
    latest: dict[str, dict] = {}
    kwargs: dict = {"FilterExpression": "item_type = :t AND run_kind = :k", "ExpressionAttributeValues": {":t": "run_metadata", ":k": "candidate"}}
    while True:
        page = _ddb.scan(**kwargs)
        for i in page["Items"]:
            name = i.get("scenario")
            if name and (name not in latest or i.get("created_at", "") > latest[name].get("created_at", "")):
                latest[name] = i
        if "LastEvaluatedKey" not in page:
            break
        kwargs["ExclusiveStartKey"] = page["LastEvaluatedKey"]
    scenarios = [
        {"scenario": name, "verdict": i.get("verdict"), "run_id": i["run_id"], "created_at": i.get("created_at"), "agent_module": i.get("agent_module"), "commit_sha": i.get("commit_sha")}
        for name, i in sorted(latest.items())
    ]
    return _response(200, {"scenarios": scenarios})


def handle_accept(event: dict) -> dict:
    run_id = _param(event, "run_id")
    if not run_id:
        return _response(400, {"error": "missing run_id"})
    try:
        body = json.loads(event.get("body") or "{}")
    except json.JSONDecodeError:
        return _response(400, {"error": "invalid JSON body"})
    accepted_by = (body.get("accepted_by") or "").strip()
    if not accepted_by:
        return _response(400, {"error": "accepted_by is required -- who is accepting this change"})
    accepted_at = datetime.datetime.now(datetime.timezone.utc).isoformat()
    _ddb.update_item(
        Key={"run_id": run_id, "sequence_number": 0},
        UpdateExpression="SET accepted_by = :who, accepted_at = :when",
        ExpressionAttributeValues={":who": accepted_by, ":when": accepted_at},
    )
    return _response(200, {"run_id": run_id, "accepted_by": accepted_by, "accepted_at": accepted_at})


_ROUTES = {
    ("GET", "/runs/{run_id}"): handle_get_run,
    ("GET", "/commits/{sha}"): handle_get_commit,
    ("GET", "/scenarios"): handle_get_scenarios,
    ("POST", "/runs/{run_id}/accept"): handle_accept,
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
        # Full exception (message, traceback, any AWS error detail incl. role/ARN names) goes to
        # CloudWatch only. The caller gets a generic message -- an IAM/permissions detail in a client
        # response is itself a leak, regardless of what the underlying bug turns out to be.
        _logger.exception("Unhandled error in %s %s", method, route_path)
        return _response(500, {"error": "internal server error"})
