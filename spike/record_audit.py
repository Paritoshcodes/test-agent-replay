"""Run the audit agent once for real (real Bedrock, real PyPI/OSV calls) and record every model call and
tool call to traces/audit-001.json. New file rather than a record.py flag: record.py stays untouched and
keeps working for the original toy agent and its trace.

    python spike/record_audit.py [--target PATH_OR_URL]

--target defaults to this repo's own requirements.txt (a local path). If pointed at a remote URL later,
it MUST be pinned to a commit SHA, not a branch -- a branch can change after the golden trace is recorded,
so a re-run against the same trace would silently be auditing a different manifest than golden was.
"""

import argparse
import time

from audit_agent import COUNTS, DEFAULT_TARGET, MODEL_ID, SYSTEM_PROMPT, build_agent, build_prompt, real_execution_count
from agent import sha256
from storage import get_storage


def main() -> None:
    parser = argparse.ArgumentParser(description="Record a golden trace for the dependency audit agent.")
    parser.add_argument("--target", default=None, help="Manifest to audit: local path, file:// URL, or https:// URL (pin to a commit SHA, not a branch).")
    parser.add_argument("--run-id", default="audit-001", help="Trace identifier (local: traces/<run-id>.json; aws: DynamoDB partition key).")
    parser.add_argument("--storage", choices=["local", "aws"], default="local", help="Where to persist the trace.")
    parser.add_argument("--golden", action="store_true", help="Mark this run golden: aws payloads go under S3's golden/ prefix, exempt from the runs/ lifecycle expiry.")
    args = parser.parse_args()

    prompt = build_prompt(args.target or DEFAULT_TARGET)

    trace: list = []
    agent, _, _ = build_agent(trace)
    answer = str(agent(prompt))
    answer_sha = sha256(answer)

    # Recording writes never block the agent loop: every event above was appended to `trace` purely in
    # memory as the run executed, and only NOW, after the run has fully completed, do we flush to storage.
    storage = get_storage(args.storage)
    meta = {
        "prompt": prompt, "final_answer": answer, "final_answer_sha256": answer_sha,
        "agent_module": "audit_agent", "model_id": MODEL_ID, "system_prompt": SYSTEM_PROMPT,
        "run_kind": "golden" if args.golden else "record",
    }
    t0 = time.perf_counter()
    stats = storage.save(args.run_id, meta, trace)
    write_ms = (time.perf_counter() - t0) * 1000

    print(f"events recorded: {len(trace)} -> {stats}")
    for e in trace:
        print(f"  seq={e['seq']} type={e['type']} output_sha256={e['output_sha256']}")
    print(f"final answer:\n{answer}")
    print(f"final answer sha256: {answer_sha}")
    print(f"storage write latency: {write_ms:.1f} ms ({args.storage})")
    print(f"real executions: {real_execution_count()} (bedrock_http={COUNTS['bedrock_http']}, tool_bodies={COUNTS['tool_bodies']})")
    print(f"non-loopback socket ops observed: {COUNTS['socket_ops']} (loopback: {COUNTS['loopback_ops']})")


if __name__ == "__main__":
    main()
