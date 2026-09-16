"""Phase 2: instrumenting an agent this project did NOT construct.

agent_replay/_spike's build_agent(trace, ...) contract bakes hooks and the model into a fresh Agent at
construction time -- that only works for agent-replay's OWN bundled example agents, which is exactly the
"every adopter rewrites their agent for us" problem this phase exists to remove. An adopter's own
`module:callable` factory (scenarios.yaml's new agent form -- see scenarios.py) returns an already-built
Agent with its own model, tools and system prompt. This module attaches to THAT agent instead.

Verified against the installed strands-agents 1.55.1 source before writing anything here (see
docs/DECISIONS.md, Phase 2):
  - attach: `agent.hooks` (a strands.hooks.registry.HookRegistry) has a PUBLIC `add_hook(hook_provider)`
    method that just calls `hook_provider.register_hooks(self)` immediately -- exactly the same effect
    Agent.__init__ has when it iterates a `hooks=[...]` constructor argument. _spike.agent.ToolTap and
    _spike.gate.GateToolTap are ALREADY plain HookProvider objects (register_hooks() registers
    Before/AfterToolCallEvent callbacks) -- both are reused here UNCHANGED, via add_hook() instead of the
    constructor argument. No new hook-provider classes needed.
  - detach: HookRegistry has NO public remove/unregister/clear method (checked registry.py in full; only
    add_callback/add_hook/invoke_callbacks/has_callbacks/get_callbacks_for exist). A real limitation, not
    an oversight to route around by touching the SDK's private `_registered_callbacks` dict -- instead,
    ScopedInstrumentation.detach() disables OUR OWN callbacks via an `active` flag _AgentToolTap/GateToolTap
    check before doing anything, which is a complete FUNCTIONAL detach (the agent behaves exactly as if
    never instrumented) even though the SDK-side registration technically remains forever. agent.model is
    a plain attribute read fresh at call time (strands/event_loop/event_loop.py passes `model=agent.model`
    into the live invocation context on every turn, not a value captured once) -- restoring the ORIGINAL
    model object on detach is a complete, real reversal, no flag needed there.
  - model swap: a fresh ReplayableBedrockModel is NOT built from scratch (unlike _spike.agent.build_agent,
    which always uses REGION="ap-south-1" and a model_id the CALLER supplies) -- it is reconstructed to
    match the agent's OWN already-configured model, since we don't get to choose an adopter's model
    config. BedrockModel.config (a plain dict: model_id, temperature, guardrail_id/version/trace, etc.) is
    copied through as **kwargs; region is NOT in .config (it's a separate constructor argument consumed to
    build the boto3 client) so it is read back off the live client instead (`model.client.meta.region_name`
    -- a real boto3 client attribute, not a guess). This currently only supports BedrockModel-based agents
    (100% of what this project and the sample repo use) -- a generic strands.models.Model swap for a
    non-Bedrock provider is not attempted and not claimed.
"""

from __future__ import annotations

import importlib
from dataclasses import dataclass, field

from ._spike.agent import ReplayableBedrockModel


def is_ref(agent_ref: str) -> bool:
    """Disambiguates scenarios.yaml's two `agent:` forms (see agent_replay/scenarios.py): a colon means
    Phase 2's module:callable form; no colon is the pre-existing bare-module form, resolved by
    agent_replay.paths.import_agent_module instead. Neither form's syntax overlaps the other's -- a bare
    Python module name never legally contains a colon."""
    return ":" in agent_ref


def build_from_ref(agent_ref: str):
    """"module.path:factory_name" -> a freshly built Agent, by importing the module (ordinary Python
    import -- resolves against the ADOPTER's own project, exactly like any other import in their code) and
    calling factory_name() with NO arguments, per the scenarios.yaml contract (agent_replay/scenarios.py's
    docstring states this contract explicitly)."""
    module_path, _, factory_name = agent_ref.partition(":")
    mod = importlib.import_module(module_path)
    factory = getattr(mod, factory_name)
    return factory()


def model_id_of(agent) -> str | None:
    """Where the model id lives on a constructed agent -- verified against the installed SDK (see module
    docstring): agent.model.config["model_id"] for a BedrockModel, the same place strands' OWN
    agent.py:1893 reads it from internally (`self.model.config.get("model_id") if hasattr(self.model,
    "config") else None`) -- not guessed, matched to the SDK's own precedent."""
    model = agent.model
    if hasattr(model, "config"):
        return model.config.get("model_id")
    return None


def _region_of(model) -> str | None:
    client = getattr(model, "client", None)
    meta = getattr(client, "meta", None)
    return getattr(meta, "region_name", None)


def find_nested_agents(agent) -> dict[str, object]:
    """Phase 3: the agents-as-tools pattern (the sample repo's agents/supervisor.py) builds each specialist
    as its own Strands Agent ONCE, closed over inside an @tool function -- not stored as an attribute on
    the supervisor, not reachable through any documented API. Two mechanisms were investigated against the
    installed SDK source before writing this:

      - Patching strands.Agent.__init__ for the scoped instrumentation's duration (the OpenTelemetry
        auto-instrumentation pattern) does NOT work for this codebase: verified empirically that calling
        get_supervisor() twice in one process returns the SAME supervisor AND the same specialist objects
        (agents/supervisor.py's own singleton). No Agent() construction happens on the second and later
        calls at all, since build_supervisor() -- and with it, build_billing_agent()/etc. -- only ever runs
        once. An __init__ patch active only around agent(prompt) would see zero constructions to intercept
        on every run after the first, silently instrumenting nothing.
      - Closure introspection DOES work, verified for real: strands.tools.decorator.DecoratedFunctionTool
        (what @tool produces) stores the original decorated function on `._tool_func` (single-underscore,
        but functools.update_wrapper is applied to it specifically to preserve its identity -- not a
        throwaway). A plain Python function's closure (`__closure__` + `__code__.co_freevars`) is ordinary,
        fully public LANGUAGE-level introspection, not an SDK internal. Confirmed against the real sample
        repo: `sup.tool_registry.registry["billing_specialist"]._tool_func.__closure__` contains exactly
        one cell, and its `.cell_contents` IS a real strands.agent.agent.Agent instance.

    Returns {tool_name: Agent} -- keyed by the TOOL NAME the parent agent calls it through (this is what
    Phase 3.2's qualified contract names use), not the closure variable's own name, which this function
    never needs to know.
    """
    from strands import Agent as _Agent

    found: dict[str, object] = {}
    registry = getattr(getattr(agent, "tool_registry", None), "registry", None) or {}
    for tool_name, tool_obj in registry.items():
        func = getattr(tool_obj, "_tool_func", None)
        closure = getattr(func, "__closure__", None) if func is not None else None
        if not closure:
            continue
        for cell in closure:
            try:
                val = cell.cell_contents
            except ValueError:
                continue  # an unbound cell (freevar not yet assigned) -- skip, don't raise
            if isinstance(val, _Agent) and val is not agent:
                found[tool_name] = val
                break
    return found


def warn_uninstrumented_nested(agent, pass_through: set[str], scenario_name: str = "") -> None:
    """Phase 3 decision 1.3 (docs/DECISIONS.md): a tool whose closure contains a live Agent (see
    find_nested_agents) and that is NOT listed in the scenario's pass_through is about to be silently
    frozen -- everything inside it will be invisible to test/gate, with no error, no distinguishing mark
    on the run. That silence is exactly how the earlier vacuous forbids "pass" happened. Never auto-add a
    discovered tool to pass_through (a silent behavioral default is the same mistake in a different
    shape) -- surface it loudly instead and let a human decide."""
    import sys

    nested = find_nested_agents(agent)
    for tool_name in nested:
        if tool_name not in pass_through:
            prefix = f"{scenario_name}: " if scenario_name else ""
            print(
                f"WARNING: {prefix}tool {tool_name!r} is a sub-agent (detected via closure introspection) "
                "but is not listed in this scenario's pass_through -- during test/gate it will be frozen "
                "like any other tool, which means everything it does internally is invisible and "
                "unverified. Add it to pass_through in scenarios.yaml if you need to see inside it.",
                file=sys.stderr,
            )


@dataclass
class ScopedInstrumentation:
    """A handle, not a one-way mutation: attach() wires a tool-tap hook provider and a recording model
    wrapper onto an agent this project did not construct; detach() reverses both. Context-manager
    compatible (`with ScopedInstrumentation(agent, trace) as trace: ...`). This shape -- not a bare
    attach() function with no way back -- is deliberate: nested-agent support (instrumenting a specialist
    agent created INSIDE a supervisor's own tool call, mid-run) needs to attach, run, and detach around
    exactly one nested call, which needs a handle, not global state.
    """

    agent: object
    trace: list
    tap: object  # a HookProvider with a settable `active` flag -- _spike.agent.ToolTap or _spike.gate.GateToolTap
    model_id_override: str | None = None  # not exercised by Phase 2's own VERIFY steps -- see evaluate.py
    # Phase 3: Callable[[str], HookProvider] -- given a discovered nested agent's TOOL NAME, builds ITS OWN
    # tap instance (same class as `tap`, e.g. a GateToolTap sharing the parent's golden events and a
    # SHARED step counter -- see _spike/gate.py's step_counter parameter). None (default) means "do not
    # look for nested agents at all", which is what a nested instrumentation passes for ITSELF, so this
    # only ever recurses one level -- exactly as deep as the sample repo's own agents-as-tools topology
    # actually goes (supervisor -> specialists; specialists do not call further nested agents).
    tap_factory: object = None
    # Phase 3 decision 1: gates recursion for GATE/TEST mode. None (default, what RECORD mode passes --
    # ToolTap never freezes anything, so there is no reason to gate discovery there at all) means "recurse
    # into every discovered nested agent, unconditionally" -- Phase 3's original behavior. A set (even
    # empty) means "only recurse into a discovered agent whose tool name is IN this set" -- anything found
    # but not listed stays frozen (today's GateToolTap default), exactly as if find_nested_agents had never
    # been called for it. Opt-in, never auto-populated -- see adapter.warn_uninstrumented_nested.
    pass_through: set | None = None
    _original_model: object = None
    _attached: bool = False
    _nested: list = field(default_factory=list)

    def attach(self) -> "ScopedInstrumentation":
        if self._attached:
            return self
        # A factory like the sample repo's get_supervisor() (scenarios.yaml's own documented example) is a
        # process-wide singleton -- verified for real, not assumed: calling it twice in one process returns
        # the SAME Agent object, and Agent.messages (a plain list, strands/agent/agent.py) accumulates
        # across calls (6 messages after one turn, 12 after two, on the identical object). Without this
        # reset, N "independent" recorded runs of one scenario would actually be one growing N-turn
        # conversation, not N single-turn samples -- silently invalidating every run after the first.
        # Harmless on a freshly-built (non-singleton) agent, which already starts at [].
        # The SAME bug applies to a specialist agent closed over by the supervisor's @tool functions (also
        # a long-lived, reused object across supervisor turns -- verified for real, see find_nested_agents'
        # docstring) -- this reset applies to nested agents too, since attach() is called recursively on
        # each one below.
        self.agent.messages = []
        self._original_model = self.agent.model
        region = _region_of(self._original_model)
        original_config = dict(getattr(self._original_model, "config", {}))
        if self.model_id_override:
            original_config["model_id"] = self.model_id_override
        replacement = ReplayableBedrockModel(self.trace, replay=False, region_name=region, **original_config)
        self.tap.active = True
        self.agent.hooks.add_hook(self.tap)
        self.agent.model = replacement
        if self.tap_factory is not None:
            for name, nested_agent in find_nested_agents(self.agent).items():
                if self.pass_through is not None and name not in self.pass_through:
                    continue  # not opted in -- stays frozen at the top level, warned about separately
                nested_inst = ScopedInstrumentation(agent=nested_agent, trace=self.trace, tap=self.tap_factory(name))
                nested_inst.attach()
                self._nested.append(nested_inst)
        self._attached = True
        return self

    def detach(self) -> None:
        if not self._attached:
            return
        for nested_inst in self._nested:
            nested_inst.detach()
        self._nested = []
        self.tap.active = False
        self.agent.model = self._original_model
        self._attached = False

    def __enter__(self) -> "ScopedInstrumentation":
        return self.attach()

    def __exit__(self, *exc_info) -> None:
        self.detach()
