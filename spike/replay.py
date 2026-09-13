"""Replay traces/run-001.json by injecting recorded model and tool outputs: byte-identical replay by injection."""

import json
import pathlib
import sys

from agent import COUNTS, PROMPT, build_agent, real_execution_count, sha256

TRACE_PATH = pathlib.Path(__file__).resolve().parent.parent / "traces" / "run-001.json"


def main() -> int:
    data = json.loads(TRACE_PATH.read_text(encoding="utf-8"))
    trace = data["events"]
    if data["prompt"] != PROMPT:
        print("FAIL: trace prompt differs from agent PROMPT")
        return 1

    agent, model, tap = build_agent(trace, replay=True)
    answer = str(agent(PROMPT))
    answer_sha = sha256(answer)
    count = real_execution_count()
    n_model = sum(e["type"] == "model" for e in trace)
    n_tool = sum(e["type"] == "tool" for e in trace)

    print(f"final answer:\n{answer}")
    print(f"final answer sha256 (replayed): {answer_sha}")
    print(f"final answer sha256 (recorded): {data['final_answer_sha256']}")
    print(f"injected: model {model.replayed}/{n_model}, tool {tap.replayed}/{n_tool}")
    print(f"real executions: {count} (bedrock_http={COUNTS['bedrock_http']}, tool_bodies={COUNTS['tool_bodies']})")
    print(f"non-loopback socket ops observed: {COUNTS['socket_ops']} (loopback: {COUNTS['loopback_ops']})")

    all_consumed = model.replayed == n_model and tap.replayed == n_tool
    if count != 0 or COUNTS["socket_ops"] != 0:
        print("FAIL: real executions or network activity happened during replay")
        return 1
    if answer_sha != data["final_answer_sha256"] or not all_consumed:
        print("FAIL")
        return 1
    print("PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
