"""Run the spike agent once against real Bedrock and record every model call and tool call to traces/run-001.json."""

import json
import pathlib

from agent import COUNTS, PROMPT, build_agent, real_execution_count, sha256

TRACE_PATH = pathlib.Path(__file__).resolve().parent.parent / "traces" / "run-001.json"


def main() -> None:
    trace: list = []
    agent, _, _ = build_agent(trace)
    answer = str(agent(PROMPT))
    answer_sha = sha256(answer)

    TRACE_PATH.parent.mkdir(parents=True, exist_ok=True)
    TRACE_PATH.write_text(
        json.dumps(
            {"prompt": PROMPT, "final_answer": answer, "final_answer_sha256": answer_sha, "events": trace},
            indent=2,
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )

    print(f"events recorded: {len(trace)} -> {TRACE_PATH}")
    for e in trace:
        print(f"  seq={e['seq']} type={e['type']} output_sha256={e['output_sha256']}")
    print(f"final answer:\n{answer}")
    print(f"final answer sha256: {answer_sha}")
    print(f"real executions: {real_execution_count()} (bedrock_http={COUNTS['bedrock_http']}, tool_bodies={COUNTS['tool_bodies']})")
    print(f"non-loopback socket ops observed: {COUNTS['socket_ops']} (loopback: {COUNTS['loopback_ops']})")


if __name__ == "__main__":
    main()
