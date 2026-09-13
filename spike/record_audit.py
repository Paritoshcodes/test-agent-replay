"""Run the audit agent once for real (real Bedrock, real PyPI/OSV calls) and record every model call and
tool call to traces/audit-001.json. New file rather than a record.py flag: record.py stays untouched and
keeps working for the original toy agent and its trace.

    python spike/record_audit.py [--target PATH_OR_URL]

--target defaults to this repo's own requirements.txt (a local path). If pointed at a remote URL later,
it MUST be pinned to a commit SHA, not a branch -- a branch can change after the golden trace is recorded,
so a re-run against the same trace would silently be auditing a different manifest than golden was.
"""

import argparse
import json
import pathlib

from audit_agent import COUNTS, DEFAULT_TARGET, build_agent, build_prompt, real_execution_count
from agent import sha256

TRACE_PATH = pathlib.Path(__file__).resolve().parent.parent / "traces" / "audit-001.json"


def main() -> None:
    parser = argparse.ArgumentParser(description="Record a golden trace for the dependency audit agent.")
    parser.add_argument("--target", default=None, help="Manifest to audit: local path, file:// URL, or https:// URL (pin to a commit SHA, not a branch).")
    args = parser.parse_args()

    prompt = build_prompt(args.target or DEFAULT_TARGET)

    trace: list = []
    agent, _, _ = build_agent(trace)
    answer = str(agent(prompt))
    answer_sha = sha256(answer)

    TRACE_PATH.parent.mkdir(parents=True, exist_ok=True)
    TRACE_PATH.write_text(
        json.dumps({"prompt": prompt, "final_answer": answer, "final_answer_sha256": answer_sha, "events": trace}, indent=2, ensure_ascii=False),
        encoding="utf-8",
    )
    size_kb = TRACE_PATH.stat().st_size / 1024

    print(f"events recorded: {len(trace)} -> {TRACE_PATH}")
    for e in trace:
        print(f"  seq={e['seq']} type={e['type']} output_sha256={e['output_sha256']}")
    print(f"final answer:\n{answer}")
    print(f"final answer sha256: {answer_sha}")
    print(f"trace size: {size_kb:.1f} KB, {len(trace)} events")
    print(f"real executions: {real_execution_count()} (bedrock_http={COUNTS['bedrock_http']}, tool_bodies={COUNTS['tool_bodies']})")
    print(f"non-loopback socket ops observed: {COUNTS['socket_ops']} (loopback: {COUNTS['loopback_ops']})")


if __name__ == "__main__":
    main()
