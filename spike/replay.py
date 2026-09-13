"""Replay a recorded toy-agent trace by injecting recorded model and tool outputs: byte-identical replay
by injection.

    python spike/replay.py [--run-id run-001] [--storage local|aws]
"""

import argparse
import sys
import time

from agent import COUNTS, PROMPT, build_agent, real_execution_count, sha256
from storage import get_storage


def main() -> int:
    parser = argparse.ArgumentParser(description="Full replay of a recorded toy-agent trace.")
    parser.add_argument("--run-id", default="run-001", help="Trace identifier (local: traces/<run-id>.json; aws: DynamoDB partition key).")
    parser.add_argument("--storage", choices=["local", "aws"], default="local", help="Where to load the trace from.")
    args = parser.parse_args()

    # --- LOAD PHASE ---------------------------------------------------------------------------------
    # The zero-network proof below only covers the RUN phase. Loading from S3/DynamoDB necessarily uses
    # the network; the trace must be pulled ENTIRELY into memory first, so the agent that runs afterward
    # never touches storage mid-run. This boundary is why the proof still means something with --storage
    # aws: the counters are snapshotted the instant loading finishes, before build_agent/agent() exist.
    storage = get_storage(args.storage)
    t0 = time.perf_counter()
    data = storage.load(args.run_id)
    load_ms = (time.perf_counter() - t0) * 1000
    trace = data["events"]
    if data["prompt"] != PROMPT:
        print("FAIL: trace prompt differs from agent PROMPT")
        return 1
    socket_ops_after_load = COUNTS["socket_ops"]
    bedrock_after_load = COUNTS["bedrock_http"]
    tool_bodies_after_load = COUNTS["tool_bodies"]
    # --- END LOAD PHASE ------------------------------------------------------------------------------

    # --- RUN PHASE: replay only, no further storage access from here on --------------------------------
    agent, model, tap = build_agent(trace, replay=True)
    answer = str(agent(PROMPT))
    # --- END RUN PHASE ---------------------------------------------------------------------------------

    answer_sha = sha256(answer)
    run_real_executions = real_execution_count() - (bedrock_after_load + tool_bodies_after_load)
    run_socket_ops = COUNTS["socket_ops"] - socket_ops_after_load
    n_model = sum(e["type"] == "model" for e in trace)
    n_tool = sum(e["type"] == "tool" for e in trace)

    print(f"loaded {len(trace)} events via --storage {args.storage} in {load_ms:.1f} ms")
    print(f"final answer:\n{answer}")
    print(f"final answer sha256 (replayed): {answer_sha}")
    print(f"final answer sha256 (recorded): {data['final_answer_sha256']}")
    print(f"injected: model {model.replayed}/{n_model}, tool {tap.replayed}/{n_tool}")
    print(f"real executions during RUN phase: {run_real_executions} (bedrock_http={COUNTS['bedrock_http'] - bedrock_after_load}, tool_bodies={COUNTS['tool_bodies'] - tool_bodies_after_load})")
    print(f"non-loopback socket ops during RUN phase: {run_socket_ops} (loopback: {COUNTS['loopback_ops']})")
    print(f"(load phase alone used {socket_ops_after_load} non-loopback socket op(s) -- expected for --storage aws, excluded from the proof above by design)")

    all_consumed = model.replayed == n_model and tap.replayed == n_tool
    if run_real_executions != 0 or run_socket_ops != 0:
        print("FAIL: real executions or network activity happened during the RUN phase")
        return 1
    if answer_sha != data["final_answer_sha256"] or not all_consumed:
        print("FAIL")
        return 1
    print("PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
