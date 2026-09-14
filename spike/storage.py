"""Storage backend abstraction for traces: local JSON files (default, unchanged from before this module
existed) or AWS (DynamoDB index + S3 content-addressed payloads). Selected by --storage local|aws on
record/replay/gate.

AWS layout (infra/template.yaml):
  S3       <bucket>/events/<sha256-of-content>.json  -- one object per distinct payload (a tool_use dict,
           a tool result, or a list of model stream events). Content-addressed, so identical payloads
           across events or even across runs dedup automatically -- the same hashes replay already uses
           to prove integrity, reused here rather than sitting beside them.
  DynamoDB table "agent-replay", pk=run_id (S), sk=sequence_number (N).
           sequence_number=0 is the run metadata item (agent_module, model_id, system_prompt_hash,
           created_at, event_count, total_bytes, final_answer_hash, run_kind, plus prompt/final_answer
           text so load() can reconstruct the full trace dict without a second lookup).
           sequence_number=1.. are event items: event_type, actor, input_hash, output_hash, token_usage,
           latency_ms, timestamp. Payload bodies never touch DynamoDB -- a 40-event trace already exceeds
           its 400KB item limit; S3 holds every byte, DynamoDB holds only small fields the comparator or a
           future dashboard needs to query on.

Every event body ever traded with S3 is JSON: the same shape append_event() already put in the local
file, so LocalTraceStorage and AwsTraceStorage return byte-identical trace dicts to their caller.
"""

import abc
import concurrent.futures
import datetime
import json
import os
import pathlib

from agent import canonical, sha256

TRACES_DIR = pathlib.Path(__file__).resolve().parent.parent / "traces"
REGION = "ap-south-1"
STACK_NAME = os.environ.get("AGENT_REPLAY_STACK", "agent-replay-dev")


class TraceStorage(abc.ABC):
    @abc.abstractmethod
    def save(self, run_id: str, meta: dict, events: list) -> dict:
        """Persist a completed run (called AFTER the run finishes -- see module docstring in record_*.py
        for why writes are buffered rather than made mid-run). Returns backend stats for reporting."""

    @abc.abstractmethod
    def load(self, run_id: str) -> dict:
        """Load a run fully into memory before any agent code runs. Returns {"prompt", "final_answer",
        "final_answer_sha256", "events": [...]} -- identical shape regardless of backend."""


class LocalTraceStorage(TraceStorage):
    """Behaviour-preserving wrapper around the plain JSON file record.py/replay.py always used."""

    def __init__(self, traces_dir: pathlib.Path = TRACES_DIR):
        self.traces_dir = traces_dir

    def _path(self, run_id: str) -> pathlib.Path:
        return self.traces_dir / f"{run_id}.json"

    def save(self, run_id: str, meta: dict, events: list) -> dict:
        self.traces_dir.mkdir(parents=True, exist_ok=True)
        path = self._path(run_id)
        path.write_text(json.dumps({**meta, "events": events}, indent=2, ensure_ascii=False), encoding="utf-8")
        return {"backend": "local", "path": str(path), "bytes": path.stat().st_size}

    def load(self, run_id: str) -> dict:
        return self.load_path(self._path(run_id))

    @staticmethod
    def load_path(path) -> dict:
        """gate.py's --trace already names a literal path (not a bare run_id); load it directly."""
        return json.loads(pathlib.Path(path).read_text(encoding="utf-8"))


class AwsTraceStorage(TraceStorage):
    """DynamoDB index + S3 content-addressed payloads. boto3 only, no new dependency.

    Table and bucket names are never hardcoded or reconstructed here: the bucket in particular is
    CloudFormation-auto-named (infra/template.yaml), specifically so no account-ID-shaped string needs to
    exist in app code or docs in this public repo. Both names are resolved from the deployed stack's
    Outputs, with env var overrides for anyone not using the stack name default."""

    def __init__(self, region: str = REGION, table_name: str | None = None, bucket_name: str | None = None):
        import boto3  # local import: keeps boto3 optional for anyone only ever using --storage local

        self.region = region
        table_name = table_name or os.environ.get("AGENT_REPLAY_TABLE")
        bucket_name = bucket_name or os.environ.get("AGENT_REPLAY_BUCKET")
        if table_name is None or bucket_name is None:
            resolved_table, resolved_bucket = self._stack_outputs(region)
            table_name = table_name or resolved_table
            bucket_name = bucket_name or resolved_bucket
        self.table_name = table_name
        self.bucket_name = bucket_name
        self._ddb = boto3.resource("dynamodb", region_name=region).Table(table_name)
        self._s3 = boto3.client("s3", region_name=region)

    @staticmethod
    def _stack_outputs(region: str) -> tuple[str, str]:
        import boto3

        cfn = boto3.client("cloudformation", region_name=region)
        outputs = cfn.describe_stacks(StackName=STACK_NAME)["Stacks"][0]["Outputs"]
        by_key = {o["OutputKey"]: o["OutputValue"] for o in outputs}
        return by_key["TableName"], by_key["BucketName"]

    def _put_payload(self, payload, golden: bool) -> tuple[str, int, bool]:
        """Uploads payload (JSON-serialized) content-addressed by its own hash under golden/ or runs/ --
        golden/ is exempt from the runs/-scoped lifecycle rule (infra/template.yaml), so a golden trace's
        payloads never expire out from under a DynamoDB item that still lists them. Returns
        (hash, byte_size, deduped) -- deduped True if the object already existed under that prefix."""
        body = canonical(payload).encode("utf-8")
        digest = sha256(payload)
        key = f"{'golden' if golden else 'runs'}/{digest}.json"
        try:
            self._s3.head_object(Bucket=self.bucket_name, Key=key)
            return digest, len(body), True
        except self._s3.exceptions.ClientError as e:
            if e.response["Error"]["Code"] != "404":
                raise  # anything but "doesn't exist yet" is a real problem, not a dedup signal
        self._s3.put_object(Bucket=self.bucket_name, Key=key, Body=body, ContentType="application/json")
        return digest, len(body), False

    def save_test_run(self, run_id: str, meta: dict, gate_run: dict) -> None:
        """Persists a candidate TEST/GATE run for the dashboard (Phase 2, docs/DECISIONS.md): a
        lightweight DynamoDB summary item -- no per-event items, a candidate run is read back as a
        comparison result, never replayed -- plus the full comparison result in S3 via save_comparison().
        Distinct from save(), which persists a REFERENCE recording with full per-event fidelity because
        THAT does need replaying (spike/gate.py's GateToolTap matches against its individual events).
        meta fields mirror save()'s: scenario/contract_hash/branch/pr_number/triggered_by/commit_sha (CI
        provenance, None locally, commit_sha omitted rather than NULL -- see save()'s own comment for why)
        plus verdict (PASS/FAIL/ERROR, this run's own outcome)."""
        now = datetime.datetime.now(datetime.timezone.utc).isoformat()
        item = {
            "run_id": run_id, "sequence_number": 0, "item_type": "run_metadata", "run_kind": "candidate",
            "agent_module": meta.get("agent_module", ""), "model_id": meta.get("model_id") or "",
            "created_at": now, "scenario": meta.get("scenario"), "contract_hash": meta.get("contract_hash"),
            "branch": meta.get("branch"), "pr_number": meta.get("pr_number"), "triggered_by": meta.get("triggered_by"),
            "verdict": meta.get("verdict"), "accepted_by": None, "accepted_at": None,
        }
        if meta.get("commit_sha") is not None:
            item["commit_sha"] = meta["commit_sha"]
        self._ddb.put_item(Item=item)
        self.save_comparison(run_id, gate_run)

    def record_acceptance(self, run_id: str, accepted_by: str, accepted_at: str) -> None:
        """Phase 3's accept flow: who accepted a run's diverging behaviour as the new baseline, and when.
        A targeted UpdateItem on the run_metadata item only -- does not touch the contract itself (see
        agent_replay/dashboard.py and README.md's "How an accepted change reaches the repo" for why this
        dashboard never writes to git directly)."""
        self._ddb.update_item(
            Key={"run_id": run_id, "sequence_number": 0},
            UpdateExpression="SET accepted_by = :who, accepted_at = :when",
            ExpressionAttributeValues={":who": accepted_by, ":when": accepted_at},
        )

    def save_comparison(self, run_id: str, gate_run: dict) -> None:
        """The dashboard's read API (agent_replay/lambda_handler.py, added Phase 2) needs somewhere to
        read a run's full comparison result from -- nothing before this method persisted one at all; a
        comparison only ever existed in memory for the duration of one `agent-replay test`/`gate` call.
        Keyed by run_id directly (not content-addressed like every other payload here): a given run_id's
        comparison is unique and immutable once written, so there is nothing to deduplicate against, and a
        direct key lets the read side build Key=f"comparisons/{run_id}.json" with no DynamoDB lookup at
        all. `gate_run` is the GateRun-shaped dict from agent_replay/dashboard.py's build_gate_run()."""
        body = canonical(gate_run).encode("utf-8")
        self._s3.put_object(Bucket=self.bucket_name, Key=f"comparisons/{run_id}.json", Body=body, ContentType="application/json")

    def load_comparison(self, run_id: str) -> dict | None:
        try:
            obj = self._s3.get_object(Bucket=self.bucket_name, Key=f"comparisons/{run_id}.json")
        except self._s3.exceptions.ClientError as e:
            if e.response["Error"]["Code"] in ("NoSuchKey", "404"):
                return None
            raise
        return json.loads(obj["Body"].read().decode("utf-8"))

    def _get_payload(self, digest: str, golden: bool):
        prefix = "golden" if golden else "runs"
        obj = self._s3.get_object(Bucket=self.bucket_name, Key=f"{prefix}/{digest}.json")
        return json.loads(obj["Body"].read().decode("utf-8"))

    @staticmethod
    def _token_usage(event: dict) -> int:
        if event["type"] != "model":
            return 0
        total = 0
        for chunk in event["output"]:
            usage = chunk.get("metadata", {}).get("usage")
            if usage:
                total += usage.get("inputTokens", 0) + usage.get("outputTokens", 0)
        return total

    @staticmethod
    def _latency_ms(event: dict) -> int:
        if event["type"] != "model":
            return 0
        for chunk in event["output"]:
            metrics = chunk.get("metadata", {}).get("metrics")
            if metrics:
                return metrics.get("latencyMs", 0)
        return 0

    def save(self, run_id: str, meta: dict, events: list) -> dict:
        now = datetime.datetime.now(datetime.timezone.utc).isoformat()
        golden = meta.get("run_kind") == "golden"

        # S3 head+put round trips dominate write latency (measured ~3.2s for a 12-event trace, sequential);
        # a bounded pool is enough to hide that behind network latency without over-engineering it.
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
            work = {(e["seq"], "in"): pool.submit(self._put_payload, e["input"], golden) for e in events}
            work.update({(e["seq"], "out"): pool.submit(self._put_payload, e["output"], golden) for e in events})
            work["prompt"] = pool.submit(self._put_payload, meta["prompt"], golden)
            work["answer"] = pool.submit(self._put_payload, meta["final_answer"], golden)
            results = {k: f.result() for k, f in work.items()}

        total_bytes = uploaded = deduped = 0
        with self._ddb.batch_writer() as batch:
            for e in events:
                in_hash, in_bytes, in_dedup = results[(e["seq"], "in")]
                out_hash, out_bytes, out_dedup = results[(e["seq"], "out")]
                total_bytes += in_bytes + out_bytes
                uploaded += (not in_dedup) + (not out_dedup)
                deduped += in_dedup + out_dedup
                actor = "model" if e["type"] == "model" else e["input"]["name"]
                batch.put_item(Item={
                    "run_id": run_id, "sequence_number": e["seq"], "item_type": "event",
                    "event_type": e["type"], "actor": actor,
                    "input_hash": in_hash, "output_hash": out_hash,
                    "token_usage": self._token_usage(e), "latency_ms": self._latency_ms(e),
                    "timestamp": now,
                })
            prompt_hash, prompt_bytes, prompt_dedup = results["prompt"]
            answer_hash, answer_bytes, answer_dedup = results["answer"]
            total_bytes += prompt_bytes + answer_bytes
            uploaded += (not prompt_dedup) + (not answer_dedup)
            deduped += prompt_dedup + answer_dedup
            # prompt/final_answer are content-addressed like every other payload -- only hashes live here,
            # consistent with the rest of the design and keeping this item far under DynamoDB's 400KB cap.
            #
            # commit_sha/branch/pr_number/triggered_by/scenario/contract_hash: CI provenance, read by the
            # caller from GitHub Actions' own environment (agent_replay/ci.py) and always present as KEYS
            # in `meta`, None when run locally -- boto3's Table resource serializes a Python None to a
            # real DynamoDB NULL, not an absent attribute, so a dashboard can tell "ran locally" apart
            # from "a bug forgot to set this". commit_sha is the ONE deliberate exception: it backs
            # CommitIndex (a GSI added in infra/template.yaml, Phase 5), and a GSI key attribute must be a
            # scalar type -- NULL cannot fill that role, and DynamoDB's own sparse-index behavior (an
            # item missing a GSI key attribute is simply excluded from that index, not an error) is the
            # well-documented, safe way to keep local/non-CI runs out of a commit-keyed index. So
            # commit_sha is omitted from the Item entirely when absent, everything else stays an explicit
            # NULL.
            item = {
                "run_id": run_id, "sequence_number": 0, "item_type": "run_metadata",
                "agent_module": meta.get("agent_module", ""), "model_id": meta.get("model_id", ""),
                "system_prompt_hash": sha256(meta.get("system_prompt", "")),
                "created_at": now, "event_count": len(events), "total_bytes": total_bytes,
                "prompt_hash": prompt_hash, "final_answer_hash": answer_hash,
                "scenario": meta.get("scenario"), "contract_hash": meta.get("contract_hash"),
                "branch": meta.get("branch"), "pr_number": meta.get("pr_number"),
                "triggered_by": meta.get("triggered_by"),
                "run_kind": meta.get("run_kind", "record"),
            }
            if meta.get("commit_sha") is not None:
                item["commit_sha"] = meta["commit_sha"]
            batch.put_item(Item=item)
        return {
            "backend": "aws", "table": self.table_name, "bucket": self.bucket_name,
            "ddb_items": len(events) + 1, "s3_objects_uploaded": uploaded, "s3_objects_deduped": deduped,
            "bytes": total_bytes,
        }

    def load(self, run_id: str) -> dict:
        items = self._ddb.query(KeyConditionExpression="run_id = :r", ExpressionAttributeValues={":r": run_id})["Items"]
        meta = next(i for i in items if int(i["sequence_number"]) == 0)
        golden = meta.get("run_kind") == "golden"
        events = []
        for i in sorted((i for i in items if int(i["sequence_number"]) != 0), key=lambda i: int(i["sequence_number"])):
            events.append({
                "seq": int(i["sequence_number"]), "type": i["event_type"],
                "input": self._get_payload(i["input_hash"], golden), "output": self._get_payload(i["output_hash"], golden),
                "output_sha256": i["output_hash"],
            })
        prompt = self._get_payload(meta["prompt_hash"], golden)
        final_answer = self._get_payload(meta["final_answer_hash"], golden)
        return {"prompt": prompt, "final_answer": final_answer, "final_answer_sha256": meta["final_answer_hash"], "events": events}


def get_storage(kind: str) -> TraceStorage:
    if kind == "local":
        return LocalTraceStorage()
    if kind == "aws":
        return AwsTraceStorage()
    raise ValueError(f"unknown --storage {kind!r}, expected 'local' or 'aws'")
