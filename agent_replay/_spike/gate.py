"""Gate replay: tool outputs frozen from a golden trace, model LIVE with an optionally changed prompt or
model ID. Freezing tool outputs while letting the model run live means exactly one variable changes, so
any behavioural difference up to the first unrecorded tool call is attributable to that change and
nothing else. Byte-identical replay by injection is not attempted here on purpose -- this mode makes real
model calls; see spike/replay.py for the zero-network full replay proof.
"""

import argparse
import copy
import importlib
import json
import sys
from collections import deque

from .agent import COUNTS, StoredResultTool, append_event, canonical
from .gate_compare import StepReport, compare, compare_halted
from .storage import AwsTraceStorage, LocalTraceStorage
from strands.hooks import AfterToolCallEvent, BeforeToolCallEvent, HookProvider, HookRegistry
from strands.types.exceptions import EventLoopException


def _stringify(v) -> str:
    return "true" if v is True else "false" if v is False else str(v)


def _try_json(text: str):
    try:
        return json.loads(text)
    except (json.JSONDecodeError, TypeError):
        return None


def _parse_kv(text: str) -> dict:
    """Parse the spike tools' 'key=value; key=value' output format into a dict of strings."""
    return dict(p.split("=", 1) for p in text.split("; ") if "=" in p)


def _render_kv(fields: dict) -> str:
    return "; ".join(f"{k}={v}" for k, v in fields.items())


def _apply_mutation(result: dict, mutation: dict) -> dict:
    """Shallow-merge mutation fields into a tool result's embedded text before injection. The text may be
    the toy agent's 'key=value; key=value' format or a tool's raw JSON string (e.g. audit_agent's tools);
    detected by trying JSON first, since a mutation must land on whichever shape the tool actually emits."""
    result = copy.deepcopy(result)
    content = result.get("content") or []
    if content and "text" in content[0]:
        parsed = _try_json(content[0]["text"])
        if isinstance(parsed, dict):
            parsed.update(mutation)
            content[0]["text"] = json.dumps(parsed, separators=(",", ":"))
        else:
            fields = _parse_kv(content[0]["text"])
            fields.update({k: _stringify(v) for k, v in mutation.items()})
            content[0]["text"] = _render_kv(fields)
    return result


def _golden_field_value(golden_events: list, tool_name: str, field: str):
    for e in golden_events:
        if e["type"] == "tool" and e["input"]["name"] == tool_name:
            content = e["output"].get("content") or []
            if content and "text" in content[0]:
                parsed = _try_json(content[0]["text"])
                if isinstance(parsed, dict):
                    return parsed.get(field)
                return _parse_kv(content[0]["text"]).get(field)
    return None


def _parse_mutate_args(raw: list[str], golden_events: list) -> dict[str, dict]:
    """Parse --mutate 'tool:{json}' flags into {tool_name: merged_fields}. Errors out clearly, before
    anything runs, if a named tool doesn't appear in the golden trace or the JSON doesn't parse."""
    golden_tool_names = {e["input"]["name"] for e in golden_events if e["type"] == "tool"}
    mutations: dict[str, dict] = {}
    for entry in raw:
        tool_name, sep, json_str = entry.partition(":")
        if not sep:
            sys.exit(f"--mutate must be TOOL:JSON, got: {entry!r}")
        if tool_name not in golden_tool_names:
            sys.exit(f"--mutate names tool {tool_name!r}, which does not appear in the golden trace (has: {sorted(golden_tool_names)})")
        try:
            obj = json.loads(json_str)
        except json.JSONDecodeError as e:
            sys.exit(f"--mutate {tool_name!r}: invalid JSON object {json_str!r}: {e}")
        if not isinstance(obj, dict):
            sys.exit(f"--mutate {tool_name!r}: expected a JSON object, got {json_str!r}")
        mutations.setdefault(tool_name, {}).update(obj)
    return mutations


class UnrecordedToolCallError(RuntimeError):
    """Raised in --strict mode when the candidate calls a tool with no matching result in the golden trace."""

    def __init__(self, step: int, tool_name: str, tool_args: dict):
        self.step = step
        self.tool_name = tool_name
        self.tool_args = tool_args  # NOT self.args: BaseException.__init__ below would silently overwrite it
        super().__init__(f"unrecorded tool call at step {step}: {tool_name}({tool_args})")


class GateToolTap(HookProvider):
    """Injects tool results from the golden trace, matched by tool name + arguments (order-independent,
    not by sequence number -- concurrent tool batches don't have a stable sequence, per spike/agent.py).

    A candidate call with no matching golden entry is the expected outcome of a real regression, not an
    edge case: by default it gets a synthetic error result and the run continues (see module docstring on
    the attribution boundary); with strict=True it halts the run instead.
    """

    def __init__(self, golden_events: list, candidate_trace: list, strict: bool = False, mutations: dict[str, dict] | None = None, agent_name: str | None = None, step_counter: list[int] | None = None, pass_through: set[str] | None = None):
        self.candidate_trace = candidate_trace
        self.strict = strict
        self.mutations = mutations or {}
        # A one-element list, not a plain int: Phase 3's nested capture attaches one GateToolTap per
        # discovered agent (supervisor, each specialist), all writing into the SAME shared candidate_trace
        # -- an independent `self.step = 0` per instance would hand out DUPLICATE step numbers to
        # different agents' calls that happen to occur at the same ordinal within their own tap, which
        # would corrupt the step table and MISSING_STEP's step numbering the moment more than one tap is
        # active. Defaults to a private counter, so a lone top-level tap (every pre-Phase-3 caller) is
        # unaffected -- byte-identical to plain `self.step = 0` before this parameter existed.
        self._step_counter = step_counter if step_counter is not None else [0]
        self.injected = 0
        self.unrecorded = 0
        self.first_unrecorded_step: int | None = None
        self._pending: dict[str, dict] = {}  # toolUseId -> {"step": int, "status": str, "mutated": bool}
        self._queues: dict[tuple, deque] = {}
        for e in golden_events:
            if e["type"] != "tool":
                continue
            key = (e["input"]["name"], canonical(e["input"].get("input", {})))
            self._queues.setdefault(key, deque()).append(e["output"])
        # Defaults True: every existing caller never sets this, so behavior is byte-identical to before
        # this flag existed. See _spike/agent.py's ToolTap.active for why (Phase 2's adapter.py
        # ScopedInstrumentation, docs/DECISIONS.md) -- same reasoning, same shape.
        self.active = True
        # See _spike/agent.py's ToolTap.agent_name for why (Phase 3, nested capture) -- same shape: None
        # preserves the pre-existing post-hoc stamping behavior exactly.
        self.agent_name = agent_name
        # Phase 3 decision 1 (docs/DECISIONS.md): tool names that must NOT be frozen -- a tool that is
        # itself a live sub-agent (agents-as-tools) has to actually run for anything inside it to ever be
        # observed; freezing it (this class's ENTIRE reason for existing, for every other tool) means the
        # sub-agent's real function body never executes, unconditionally, regardless of match outcome --
        # this was Phase 3's stop condition. Empty set (default) is byte-identical to before this
        # parameter existed: no tool is ever exempted from freezing.
        self.pass_through = pass_through or set()

    def register_hooks(self, registry: HookRegistry, **kwargs) -> None:
        registry.add_callback(BeforeToolCallEvent, self._before)
        registry.add_callback(AfterToolCallEvent, self._after)

    @property
    def step(self) -> int:
        return self._step_counter[0]

    def _before(self, event: BeforeToolCallEvent) -> None:
        if not self.active:
            return
        self._step_counter[0] += 1
        tool_name = event.tool_use["name"]
        args = event.tool_use.get("input", {})

        if tool_name in self.pass_through:
            # Do NOT touch event.selected_tool: the real tool -- the live sub-agent -- runs, unmodified.
            # Its OWN nested tool calls are injected from golden exactly as any other call, by whichever
            # GateToolTap instance is attached to that nested agent (see agent_replay/adapter.py's
            # ScopedInstrumentation and evaluate.py's pass_through wiring). Not counted as injected/
            # unrecorded -- it is neither; gate_status="pass_through" is its own third category, read by
            # evaluate.py to compute the weakened-attribution boundary (see docs/DECISIONS.md).
            self._pending[event.tool_use["toolUseId"]] = {"step": self.step, "status": "pass_through", "mutated": False}
            return

        key = (tool_name, canonical(args))
        queue = self._queues.get(key)

        mutated = False
        if queue:
            self.injected += 1
            status = "recorded"
            # The live model mints a fresh toolUseId every run; Bedrock requires the injected
            # toolResult's id to match this call's toolUse id, not the one recorded in golden.
            result = dict(queue.popleft())
            result["toolUseId"] = event.tool_use["toolUseId"]
            if tool_name in self.mutations:
                result = _apply_mutation(result, self.mutations[tool_name])
                mutated = True
            event.selected_tool = StoredResultTool(event.selected_tool, result)
        else:
            self.unrecorded += 1
            if self.first_unrecorded_step is None:
                self.first_unrecorded_step = self.step
            if self.strict:
                raise UnrecordedToolCallError(self.step, tool_name, args)
            status = "unrecorded"
            synthetic = {
                "toolUseId": event.tool_use["toolUseId"],
                "status": "error",
                "content": [{"text": json.dumps({"error": "unrecorded_tool_call", "tool": tool_name, "args": args})}],
            }
            event.selected_tool = StoredResultTool(event.selected_tool, synthetic)

        self._pending[event.tool_use["toolUseId"]] = {"step": self.step, "status": status, "mutated": mutated}

    def _after(self, event: AfterToolCallEvent) -> None:
        if not self.active:
            return
        info = self._pending.pop(event.tool_use["toolUseId"])
        append_event(self.candidate_trace, "tool", event.tool_use, event.result)
        self.candidate_trace[-1]["gate_step"] = info["step"]
        self.candidate_trace[-1]["gate_status"] = info["status"]
        self.candidate_trace[-1]["gate_mutated"] = info["mutated"]
        if self.agent_name is not None:
            self.candidate_trace[-1]["agent"] = self.agent_name


def _token_totals(candidate_trace: list) -> tuple[int, int]:
    input_tokens = output_tokens = 0
    for e in candidate_trace:
        if e["type"] != "model":
            continue
        for chunk in e["output"]:
            usage = chunk.get("metadata", {}).get("usage")
            if usage:
                input_tokens += usage.get("inputTokens", 0)
                output_tokens += usage.get("outputTokens", 0)
    return input_tokens, output_tokens


def _fmt_call(call: dict | None, width: int) -> str:
    if call is None:
        text = "(none)"
    elif "answer" in call:
        text = json.dumps(call["answer"])
    else:
        text = f"{call['tool']}({json.dumps(call['args'])})"
    return text[: width - 3] + "..." if len(text) > width else text


def _print_step_table(steps: list[StepReport]) -> None:
    w = 28
    print(f"{'step':>4}  {'label':<15}  {'attribution':<12}  {'note':<9}  {'candidate':<{w}}  {'golden':<{w}}")
    for s in steps:
        label = s.cause or "MATCH"
        note = "MUTATED" if s.mutated else ""
        print(f"{s.step:>4}  {label:<15}  {s.attribution:<12}  {note:<9}  {_fmt_call(s.candidate, w):<{w}}  {_fmt_call(s.golden, w):<{w}}")


def _print_what_changed(args: argparse.Namespace, mutations: dict[str, dict], golden_events: list) -> None:
    print("=" * 70)
    print("1. What changed")
    changed = False
    if args.prompt is not None:
        print("   system prompt: CHANGED")
        changed = True
    if args.model_id is not None:
        print(f"   model id: CHANGED -> {args.model_id}")
        changed = True
    for tool_name, fields in mutations.items():
        changed = True
        for field, mutated_value in fields.items():
            golden_value = _golden_field_value(golden_events, tool_name, field)
            print(f"   mutated: {tool_name}.{field}: {golden_value!r} -> {_stringify(mutated_value)!r}")
    if not changed:
        print("   nothing -- gate replay against an unchanged configuration (sanity check)")


def main() -> int:
    parser = argparse.ArgumentParser(description="Gate replay: live model, tool outputs frozen from a golden trace.")
    parser.add_argument("--trace", default=None, help="Path to the golden trace JSON (local storage only; from record.py).")
    parser.add_argument("--run-id", default=None, help="Golden trace identifier (aws storage only; DynamoDB partition key).")
    parser.add_argument("--storage", choices=["local", "aws"], default="local", help="Where to load the golden trace from. --trace for local, --run-id for aws.")
    parser.add_argument("--prompt", default=None, help="Replacement system prompt for the candidate run.")
    parser.add_argument("--model-id", default=None, help="Replacement Bedrock model ID for the candidate run.")
    parser.add_argument("--strict", action="store_true", help="Halt at the first unrecorded tool call instead of injecting a synthetic error.")
    parser.add_argument("--fail-on-answer", action="store_true", help="Promote a final-answer-only difference to FAIL (default: informational only).")
    parser.add_argument("--mutate", action="append", default=[], metavar="TOOL:JSON", help="Shallow-merge JSON into a tool's recorded result before injection, e.g. --mutate 'lookup_order:{\"refund_eligible\": false}'. Repeatable.")
    parser.add_argument("--agent-module", default="agent", help="Module (in spike/) providing PROMPT, SYSTEM_PROMPT, MODEL_ID, build_agent -- lets gate replay target a different agent, e.g. audit_agent.")
    args = parser.parse_args()

    agent_mod = importlib.import_module(args.agent_module)

    if args.storage == "local":
        if args.trace is None:
            sys.exit("--trace is required with --storage local")
        golden = LocalTraceStorage.load_path(args.trace)
    else:
        if args.run_id is None:
            sys.exit("--run-id is required with --storage aws")
        golden = AwsTraceStorage().load(args.run_id)  # LOAD PHASE: fully in memory before the agent runs
    golden_events = golden["events"]
    mutations = _parse_mutate_args(args.mutate, golden_events)

    candidate_trace: list = []
    tap = GateToolTap(golden_events, candidate_trace, strict=args.strict, mutations=mutations)
    model_id = args.model_id or agent_mod.MODEL_ID
    system_prompt = args.prompt or agent_mod.SYSTEM_PROMPT
    agent, model, tap = agent_mod.build_agent(candidate_trace, replay=False, model_id=model_id, system_prompt=system_prompt, tap=tap)

    _print_what_changed(args, mutations, golden_events)

    try:
        candidate_answer = str(agent(agent_mod.PROMPT))
    except EventLoopException as e:
        if not isinstance(e.original_exception, UnrecordedToolCallError):
            raise
        halt = e.original_exception
        result = compare_halted(golden_events, candidate_trace, halt.step, context_text=f"{system_prompt} {agent_mod.PROMPT}")
        print("2. HALTED (--strict)")
        print(f"   first unrecorded tool call at step {halt.step}: {halt.tool_name}({json.dumps(halt.tool_args)})")
        print("   no golden result exists for this call; halted before running it for real")
        print()
        print("4. Attribution boundary")
        print(f"   step {halt.step - 1 if halt.step > 1 else 0} (everything before the halt is attributable; nothing after it ran)" if halt.step > 1 else "   step 0 (halted on the very first tool call; nothing is attributable yet)")
        print()
        print("5. Step-by-step table (proven prefix only)")
        _print_step_table(result.steps)
        print()
        print("6. Counters")
        n_model = sum(e["type"] == "model" for e in candidate_trace)
        print(f"   live model calls:       {n_model}")
        print(f"   tool results injected:  {tap.injected}")
        print(f"   unrecorded tool calls:  {tap.unrecorded}")
        print(f"   real tool executions:   {COUNTS['tool_bodies']}  (must be 0)")
        in_tok, out_tok = _token_totals(candidate_trace)
        print("7. Cost (live model calls)")
        print(f"   input tokens:  {in_tok}")
        print(f"   output tokens: {out_tok}")
        if COUNTS["tool_bodies"] != 0:
            print(f"PROOF FAILED: {COUNTS['tool_bodies']} real tool execution(s) happened during gate replay")
        print("=" * 70)
        return 1

    result = compare(golden_events, candidate_trace, golden["final_answer"], candidate_answer, context_text=f"{system_prompt} {agent_mod.PROMPT}", fail_on_answer=args.fail_on_answer)

    print(f"2. {result.verdict}")
    print()
    if result.first_divergence is not None:
        fd = result.first_divergence
        print("3. First divergence")
        print(f"   step {fd.step}: {fd.cause}  [{fd.attribution}]")
        print(f"   golden:    {_fmt_call(fd.golden, 200)}")
        print(f"   candidate: {_fmt_call(fd.candidate, 200)}")
        print()
    print("Final answer (informational only, does not affect verdict unless --fail-on-answer):")
    print(f"   Golden verdict:    {golden['final_answer'][:200]!r}")
    print(f"   Candidate verdict: {candidate_answer[:200]!r}")
    print(f"   Text matched:      {result.answer_matched}")
    if not result.answer_matched and result.answer_diff:
        print("   structural JSON diff (differing fields):")
        for path, (gv, cv) in result.answer_diff.items():
            print(f"     {path}: golden={gv!r} candidate={cv!r}")
    print()
    print("4. Attribution boundary")
    if result.attribution_boundary is None:
        print("   none, full run attributable")
    else:
        print(f"   step {result.attribution_boundary} (first unrecorded tool call)")
    print()
    print("5. Step-by-step table")
    _print_step_table(result.steps)
    print()
    print("6. Counters")
    n_model = sum(e["type"] == "model" for e in candidate_trace)
    print(f"   live model calls:       {n_model}")
    print(f"   tool results injected:  {tap.injected}")
    print(f"   unrecorded tool calls:  {tap.unrecorded}")
    print(f"   real tool executions:   {COUNTS['tool_bodies']}  (must be 0)")
    in_tok, out_tok = _token_totals(candidate_trace)
    print("7. Cost (live model calls)")
    print(f"   input tokens:  {in_tok}")
    print(f"   output tokens: {out_tok}")
    if COUNTS["tool_bodies"] != 0:
        print(f"PROOF FAILED: {COUNTS['tool_bodies']} real tool execution(s) happened during gate replay")
        print("=" * 70)
        return 1
    print("=" * 70)

    return 1 if result.verdict == "FAIL" else 0


if __name__ == "__main__":
    sys.exit(main())
