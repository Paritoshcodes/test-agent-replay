"""Spike agent: every model call and tool call can be recorded, or replayed by injecting stored outputs.

Replay is byte-identical replay by injection. It does not make the model deterministic.
"""

import copy
import hashlib
import json
import sys

from strands import Agent, tool
from strands.hooks import AfterToolCallEvent, BeforeToolCallEvent, HookProvider, HookRegistry
from strands.models import BedrockModel
from strands.types.tools import AgentTool

REGION = "ap-south-1"
MODEL_ID = "apac.amazon.nova-lite-v1:0"  # cross-region inference profile ID, not a typo
PROMPT = "Customer says order A-1001 never arrived. Look it up and decide what to do."
SYSTEM_PROMPT = (
    "You are a customer support agent. Before deciding anything about an order, you must call "
    "lookup_order with its order ID. Base your decision only on the returned record. If the record "
    "shows the order was not delivered and is refund eligible, call issue_refund. Then give a short "
    "final answer stating what you found and what you did."
)

# Real-execution counters.
#   bedrock_http: HTTP requests botocore is about to send to Bedrock (boto3 before-send event).
#   tool_bodies:  entries into a real tool function body.
#   socket_ops:   socket.getaddrinfo or non-loopback socket.connect anywhere in this process (Python audit hook).
#   loopback_ops: socket.connect to 127.0.0.1/::1. On Windows, asyncio's proactor loop opens a loopback
#                 socketpair for its self-pipe on every asyncio.run, so this is expected to be non-zero.
COUNTS = {"bedrock_http": 0, "tool_bodies": 0, "socket_ops": 0, "loopback_ops": 0}


def _audit(event: str, args: tuple) -> None:
    if event == "socket.getaddrinfo":
        COUNTS["socket_ops"] += 1
    elif event == "socket.connect":
        addr = args[1]
        loopback = isinstance(addr, tuple) and addr[0] in ("127.0.0.1", "::1")
        COUNTS["loopback_ops" if loopback else "socket_ops"] += 1


sys.addaudithook(_audit)


def real_execution_count() -> int:
    return COUNTS["bedrock_http"] + COUNTS["tool_bodies"]


def canonical(obj) -> str:
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def sha256(obj) -> str:
    data = obj if isinstance(obj, str) else canonical(obj)
    return hashlib.sha256(data.encode("utf-8")).hexdigest()


def append_event(trace: list, kind: str, call_input, output) -> None:
    trace.append({
        "seq": len(trace) + 1,
        "type": kind,
        "input": json.loads(canonical(call_input)),
        "output": json.loads(canonical(output)),
        "output_sha256": sha256(output),
    })


@tool
def lookup_order(order_id: str) -> str:
    """Look up an order by its ID and return the order record."""
    COUNTS["tool_bodies"] += 1
    return (
        f"order_id={order_id}; status=shipped; carrier=BlueDart; tracking=BD123456789IN; "
        "last_scan=2026-09-01 in transit, no delivery scan since; amount=INR 2499; refund_eligible=true"
    )


@tool
def issue_refund(order_id: str) -> str:
    """Issue a full refund for an order."""
    COUNTS["tool_bodies"] += 1
    return f"refund issued for order {order_id}; refund_id=RF-5521; amount=INR 2499"


class ReplayableBedrockModel(BedrockModel):
    """BedrockModel that records each call, or in replay mode yields the stored stream events instead of calling Bedrock."""

    def __init__(self, trace: list, replay: bool = False, **kwargs):
        super().__init__(**kwargs)
        self.trace = trace
        self.replay = replay
        self._recorded = [e for e in trace if e["type"] == "model"] if replay else []
        self.replayed = 0
        self.client.meta.events.register("before-send.bedrock-runtime.*", self._count_send)

    @staticmethod
    def _count_send(**_) -> None:
        COUNTS["bedrock_http"] += 1

    async def stream(self, messages, tool_specs=None, system_prompt=None, **kwargs):
        call_input = json.loads(canonical({"messages": messages, "tool_specs": tool_specs, "system_prompt": system_prompt}))
        if self.replay:
            if self.replayed >= len(self._recorded):
                raise RuntimeError("replay diverged: agent made more model calls than the trace holds")
            recorded = self._recorded[self.replayed]
            if canonical(recorded["input"]) != canonical(call_input):
                raise RuntimeError(f"replay diverged: model input differs from trace at seq {recorded['seq']}")
            self.replayed += 1
            for event in copy.deepcopy(recorded["output"]):
                yield event
            return
        output = []
        async for event in super().stream(messages, tool_specs, system_prompt, **kwargs):
            output.append(event)
            yield event
        append_event(self.trace, "model", call_input, output)


class StoredResultTool(AgentTool):
    """Stands in for a real tool during replay and yields the recorded ToolResult without running the tool body."""

    def __init__(self, real: AgentTool, result: dict):
        super().__init__()
        self._real = real
        self._result = result

    @property
    def tool_name(self) -> str:
        return self._real.tool_name

    @property
    def tool_spec(self):
        return self._real.tool_spec

    @property
    def tool_type(self) -> str:
        return "replay"

    async def stream(self, tool_use, invocation_state, **kwargs):
        yield copy.deepcopy(self._result)


class ToolTap(HookProvider):
    """Records tool calls via AfterToolCallEvent, or swaps in StoredResultTool via BeforeToolCallEvent.selected_tool."""

    def __init__(self, trace: list, replay: bool = False, agent_name: str | None = None):
        self.trace = trace
        self.replay = replay
        self._recorded = {e["input"]["toolUseId"]: e for e in trace if e["type"] == "tool"} if replay else {}
        self.replayed = 0
        # Defaults True: every existing caller (build_agent()'s own hooks=[tap] construction) never sets
        # this, so behavior is byte-identical to before this flag existed. Added for agent_replay/
        # adapter.py's ScopedInstrumentation (Phase 2, docs/DECISIONS.md) -- attaching this hook to an
        # agent this project did not construct, via HookRegistry.add_hook(), which has no public
        # unregister method (verified against the installed SDK source); detach() sets this False instead
        # of trying to remove the SDK-side registration.
        self.active = True
        # None (default): behavior unchanged from before this parameter existed -- the caller stamps
        # `agent` on the trace itself afterward (agent_replay/evaluate.py's post-hoc setdefault). Set to a
        # real name for Phase 3's nested capture: one ToolTap instance per discovered agent (supervisor,
        # each specialist), attached only to THAT agent's own hooks, so it only ever sees that agent's own
        # tool calls -- stamping immediately, at capture time, is then unambiguous, no need to inspect
        # which agent a shared hook instance's event came from.
        self.agent_name = agent_name

    def register_hooks(self, registry: HookRegistry, **kwargs) -> None:
        if self.replay:
            registry.add_callback(BeforeToolCallEvent, self._inject)
        else:
            registry.add_callback(AfterToolCallEvent, self._capture)

    def _capture(self, event: AfterToolCallEvent) -> None:
        if not self.active:
            return
        append_event(self.trace, "tool", event.tool_use, event.result)
        if self.agent_name is not None:
            self.trace[-1]["agent"] = self.agent_name

    def _inject(self, event: BeforeToolCallEvent) -> None:
        if not self.active:
            return
        recorded = self._recorded.get(event.tool_use["toolUseId"])
        if recorded is None or canonical(recorded["input"]) != canonical(event.tool_use):
            raise RuntimeError(f"replay diverged: tool call {event.tool_use['toolUseId']} not in trace")
        self.replayed += 1
        event.selected_tool = StoredResultTool(event.selected_tool, recorded["output"])


def build_agent(
    trace: list,
    replay: bool = False,
    *,
    model_id: str = MODEL_ID,
    system_prompt: str = SYSTEM_PROMPT,
    tap: HookProvider | None = None,
) -> tuple[Agent, ReplayableBedrockModel, HookProvider]:
    """Build the spike agent. model_id/system_prompt/tap are overridable so gate.py can run a live model
    against a changed prompt or model ID while reusing ReplayableBedrockModel's recording behaviour."""
    model = ReplayableBedrockModel(trace, replay, model_id=model_id, region_name=REGION)
    if tap is None:
        tap = ToolTap(trace, replay)
    agent = Agent(
        model=model,
        tools=[lookup_order, issue_refund],
        system_prompt=system_prompt,
        hooks=[tap],
        callback_handler=None,
    )
    return agent, model, tap
