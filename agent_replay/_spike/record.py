"""Run the spike agent once against real Bedrock and record every model call and tool call to agent-replay/traces/run-001.json."""

import argparse
import time

from .agent import COUNTS, MODEL_ID, PROMPT, SYSTEM_PROMPT, build_agent, real_execution_count, sha256
from .storage import get_storage


def main() -> None:
    parser = argparse.ArgumentParser(description="Record a golden trace for the toy support agent.")
    parser.add_argument("--run-id", default="run-001", help="Trace identifier (local: agent-replay/traces/<run-id>.json; aws: DynamoDB partition key).")
    parser.add_argument("--storage", choices=["local", "aws"], default="local", help="Where to persist the trace.")
    args = parser.parse_args()

    trace: list = []
    agent, _, _ = build_agent(trace)
    answer = str(agent(PROMPT))
    answer_sha = sha256(answer)

    # Recording writes never block the agent loop: `trace` was built purely in memory as the run
    # executed above; only now, after the run has fully completed, do we flush to storage.
    storage = get_storage(args.storage)
    meta = {
        "prompt": PROMPT, "final_answer": answer, "final_answer_sha256": answer_sha,
        "agent_module": "agent", "model_id": MODEL_ID, "system_prompt": SYSTEM_PROMPT, "run_kind": "record",
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
