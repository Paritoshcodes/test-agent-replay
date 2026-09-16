"""Contract gate: run a scenario's agent live, tool outputs frozen from its reference recordings, then
check the candidate trajectory against the derived contract instead of against a single golden trace.

Reuses spike/gate.py's GateToolTap UNCHANGED for injection (it already matches purely on (tool_name,
args), so handing it the concatenated events of N reference runs instead of one just widens its per-key
FIFO queues -- no change to its logic). The attribution-boundary RULE is restated here rather than
imported, because spike/gate_compare.py's own implementation is entangled with its single-golden-trace
StepReport shape; the rule itself -- the gate_step of the first call GateToolTap could not match against
ANY reference recording -- is copied verbatim (see _attribution_for below) and is not a reinterpretation.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field

from . import adapter
from . import forbids as forbids_mod
from . import paths
from . import portable
from .callsig import call_key
from .contract import Contract
from ._spike.agent import COUNTS
from ._spike.gate import GateToolTap, _parse_mutate_args, _token_totals
from ._spike.gate_compare import CAUSES as _EXISTING_CAUSES
from ._spike.gate_compare import _is_sourced

# FORBIDDEN is the one label this layer adds on top of gate_compare's five: none of MISSING_STEP /
# UNRECORDED / UNSOURCED_ARGUMENT / ORDER_VIOLATION / DIFFERENT_ANSWER represent a rule a human wrote by
# hand, as opposed to something inferred from comparing against one golden trace.
CAUSES = (*_EXISTING_CAUSES, "FORBIDDEN")


@dataclass
class ContractStep:
    step: int
    tool: str | None
    args: dict | None
    gate_status: str
    cause: str | None
    attribution: str
    detail: str = ""
    # spike/gate.py's GateToolTap sets gate_mutated on every candidate_trace item when --mutate touched
    # this step's injected result (unchanged code); dropped from this dataclass in the original contract
    # rewrite, silently -- a run made with --mutate showed no indication which step was altered, which a
    # human could misread as a real behavioral difference instead of the harness's own injected change.
    mutated: bool = False
    # Phase 1 (UI, docs/DECISIONS.md): which agent made this call -- "supervisor" for the top-level agent,
    # the specialist's own name for a nested pass-through call (see adapter.py's find_nested_agents). Every
    # candidate_trace event already carries this (evaluate.py stamps it via e.setdefault("agent", ...));
    # this field is the only thing that was missing to let the web UI draw one swimlane per agent instead
    # of flattening every call into a single track.
    agent: str | None = None
    # requires/permits membership for this exact (tool, args) key, or None when the call matched neither
    # (UNRECORDED/UNSOURCED_ARGUMENT) -- lets a viewer see at a glance whether a call was mandatory or
    # merely allowed, which is the whole story of a scenario like schedule-meter-reading (docs/LIMITATIONS.md,
    # "A contract can only be as strict as the agent is consistent").
    membership: str | None = None


@dataclass
class ContractResult:
    scenario: str
    steps: list[ContractStep]
    first_divergence: ContractStep | None
    attribution_boundary: int | None
    verdict: str
    candidate_answer: str
    n_model: int
    injected: int
    unrecorded: int
    tool_bodies: int  # real tool executions during this run -- must be 0; every result is injected
    input_tokens: int = 0
    output_tokens: int = 0
    # Phase 3 decision 1.2 (docs/DECISIONS.md): gate_step of the earliest pass-through call, or None if
    # this run made none. None means every step's attribution is a plain ATTRIBUTABLE/UNATTRIBUTED call as
    # before this field existed. See _StepStream._attribution_for for what WEAKLY_ATTRIBUTABLE means.
    pass_through_boundary: int | None = None


def merged_golden_events(reference_runs: list[dict]) -> list[dict]:
    """Flatten every reference run's events into one pool for GateToolTap. A candidate call matches if ANY
    reference run made that exact (tool, args) call -- GateToolTap keys purely on (tool_name, args), never
    on which run or position a stored result came from, so this is a drop-in widening, not a new rule."""
    events: list[dict] = []
    for run in reference_runs:
        events.extend(run["events"])
    return events


class _StepStream:
    """Incrementally turns each raw candidate-trace tool event into its ContractStep the moment the event
    is known, instead of scanning a completed candidate_steps list after the run returns -- Phase 2.1
    (docs/DECISIONS.md): "reuse run_and_evaluate, do not write a second execution path." Fed one event at a
    time, in true execution order, by _LiveTap below as a live run actually produces them -- which is what
    makes a fork's steps appear one at a time over a real 20-40s run instead of only after it returns.

    Every value this produces is provably identical to the prior implementation's single end-of-run scan,
    because every rule it evaluates is itself a function of EXECUTION-ORDER PREFIXES, never of what comes
    later:
      - attribution_boundary/pass_through_boundary are each "the gate_step of the first occurrence of X, in
        execution order" -- setting them the first time X is seen while walking forward is the same value a
        full-list next()/min() scan would find, just discovered earlier rather than later.
      - forbids_mod.evaluate() is itself already a single forward pass (call_count/per_arg_count/history
        are all built strictly left to right; see forbids.py) -- re-running it on the prefix ending at THIS
        step and keeping only violations tagged with this step's own gate_step gives the identical result a
        single evaluate() call over the full list would have produced for that same step.
      - order_seen/called_by_key are running sets built the same way either path visits events.
    """

    def __init__(self, contract: Contract, context_text: str):
        self.contract = contract
        self.context_text = context_text
        self.require_keys = contract.require_keys()
        self.permit_keys = contract.permit_keys()
        self.order_seen: set[str] = set()
        self.called_by_key: set[tuple[str, str]] = set()
        self.attribution_boundary: int | None = None
        self.pass_through_boundary: int | None = None
        self.candidate_steps: list[dict] = []  # the prefix seen so far -- _is_sourced/forbids need history
        self.steps: list[ContractStep] = []
        self.first_divergence: ContractStep | None = None

    def _attribution_for(self, step_no: int) -> str:
        if self.attribution_boundary is not None and step_no > self.attribution_boundary:
            return "UNATTRIBUTED"
        if self.pass_through_boundary is not None and step_no >= self.pass_through_boundary:
            # WEAKLY_ATTRIBUTABLE, not ATTRIBUTABLE: a pass-through call means a live sub-agent ran with
            # its OWN model making its OWN live decisions -- from here on, TWO things can make this step
            # differ from golden, not one (the change under test, AND the sub-agent's own live
            # non-determinism/discretion), even though every LEAF tool result underneath it was still
            # frozen exactly as everywhere else. Distinct from UNATTRIBUTED: that label means the harness's
            # own synthetic error has already contaminated everything downstream (a real divergence); this
            # one means nothing has diverged, but the one-variable-changed guarantee no longer holds.
            return "WEAKLY_ATTRIBUTABLE"
        return "ATTRIBUTABLE"

    def feed(self, e: dict) -> ContractStep:
        idx = len(self.candidate_steps)
        self.candidate_steps.append(e)
        step_no = e["gate_step"]
        if self.attribution_boundary is None and e.get("gate_status") == "unrecorded":
            self.attribution_boundary = step_no
        if self.pass_through_boundary is None and e.get("gate_status") == "pass_through":
            self.pass_through_boundary = step_no

        name = e["input"]["name"]
        args = e["input"].get("input", {}) or {}
        # The contract's own requires/permits keys are portable (loaded straight from the committed
        # file); `args` here is real/absolute (this run's actual, executable arguments). Collapse ONLY
        # for the membership check -- `report.args` below stays the real value, for honest reporting of
        # what actually happened on this run.
        key = call_key(name, portable.portable_value(args))
        self.called_by_key.add(key)
        cause = None
        detail = ""
        membership = "requires" if key in self.require_keys else "permits" if key in self.permit_keys else None

        if key not in self.require_keys and key not in self.permit_keys:
            # Not declared at all. GateToolTap's injection pool IS require-union-permits, so this call was
            # necessarily "unrecorded" at runtime too -- reuse gate_compare's own UNRECORDED /
            # UNSOURCED_ARGUMENT split unchanged.
            cause = "UNRECORDED" if _is_sourced(e, self.candidate_steps[:idx], self.context_text) else "UNSOURCED_ARGUMENT"
            detail = f"{name} is not in requires or permits"
        else:
            step_violations = [v for v in forbids_mod.evaluate(self.contract.forbids, self.candidate_steps) if v.step == step_no]
            if step_violations:
                cause = "FORBIDDEN"
                detail = step_violations[0].detail
            else:
                for before, after in self.contract.order:
                    if after == name and before not in self.order_seen:
                        cause = "ORDER_VIOLATION"
                        detail = f"no prior {before} call ({before} -> {after})"
                        break

        self.order_seen.add(name)
        report = ContractStep(
            step=step_no, tool=name, args=args, gate_status=e.get("gate_status", "n/a"), cause=cause,
            attribution=self._attribution_for(step_no), detail=detail, mutated=bool(e.get("gate_mutated")),
            agent=e.get("agent"), membership=membership,
        )
        self.steps.append(report)
        if cause is not None and self.first_divergence is None:
            self.first_divergence = report
        return report

    def finish(self) -> tuple[list[ContractStep], ContractStep | None, int | None, int | None, str]:
        """Appends the trailing MISSING_STEP entries -- only knowable once the run is fully over (a
        `requires` call either happened somewhere in the whole run or it didn't) -- and returns the same
        5-tuple the prior single-shot _evaluate_steps always returned."""
        base = self.candidate_steps[-1]["gate_step"] if self.candidate_steps else 0
        offset = 0
        for tool, args in self.contract.requires:
            key = call_key(tool, args)
            if key in self.called_by_key:
                continue
            offset += 1
            step_no = base + offset
            report = ContractStep(
                step=step_no, tool=tool, args=args, gate_status="n/a", cause="MISSING_STEP",
                attribution=self._attribution_for(step_no), detail="required but never called",
                agent=self.contract.agent_by_key.get(key), membership="requires",
            )
            self.steps.append(report)
            if self.first_divergence is None:
                self.first_divergence = report

        verdict = "FAIL" if self.first_divergence is not None else "PASS"
        return self.steps, self.first_divergence, self.attribution_boundary, self.pass_through_boundary, verdict


class _LiveTap(GateToolTap):
    """GateToolTap, UNCHANGED (see this module's own docstring on why it stays that way) plus exactly one
    hook: the moment `_after` finishes populating a candidate_trace entry (gate_step/gate_status/
    gate_mutated/agent all set), feed that SAME dict straight into the shared `_StepStream` and, if the
    caller asked for one, its `on_step` callback -- both are given the report the instant the underlying
    tool call actually completes, which is what makes a fork's steps appear one at a time as a live 20-40s
    run actually produces them (Phase 2.1, docs/DECISIONS.md), rather than only after the whole run
    returns. Every pre-existing caller built a plain GateToolTap; this subclass is constructed ONLY inside
    run_and_evaluate below (including for nested/pass-through taps), so nothing outside this module needs
    to know it exists, and its behavior is identical to GateToolTap's own for anyone not reading
    self._stream/self._on_step off of it."""

    def __init__(self, *args, _stream: "_StepStream", _on_step: Callable[[ContractStep], None] | None, _default_agent: str | None = None, **kwargs):
        super().__init__(*args, **kwargs)
        self._stream = _stream
        self._on_step = _on_step
        # The TOP-LEVEL tap's calls only ever get their "agent" field filled in AFTER agent(prompt)
        # returns, in run_and_evaluate's own `e.setdefault("agent", ...)` loop below (a nested/pass-through
        # tap already sets it immediately via GateToolTap's own agent_name mechanism). Feeding the stream
        # DURING the run, before that loop has ever run, would otherwise hand every top-level ContractStep
        # a permanently-missing agent -- so this applies the exact same default eagerly, at feed time, for
        # a tap constructed with one; the post-run loop is then a no-op for anything already set here, kept
        # anyway as a harmless, zero-risk safety net for anything not covered by this path.
        self._default_agent = _default_agent

    def _after(self, event) -> None:
        super()._after(event)
        e = self.candidate_trace[-1]
        if self._default_agent is not None:
            e.setdefault("agent", self._default_agent)
        report = self._stream.feed(e)
        if self._on_step is not None:
            self._on_step(report)


def run_and_evaluate(
    agent_module: str,
    prompt: str,
    contract: Contract,
    reference_runs: list[dict],
    *,
    model_id: str | None = None,
    system_prompt: str | None = None,
    mutations: dict[str, dict] | None = None,
    strict: bool = False,
    pass_through: list[str] | None = None,
    # Phase 2.1 (docs/DECISIONS.md): optional, defaults to None so every existing caller (agent_replay/
    # cli.py's cmd_test/cmd_gate) is byte-identical -- see _StepStream's own docstring for exactly what
    # changed internally and why the result is provably the same either way regardless of this parameter.
    # When given, invoked with each ContractStep the moment it is known, DURING the live run rather than
    # after it returns -- agent_replay/fork.py is the only caller that passes one.
    on_step: Callable[[ContractStep], None] | None = None,
) -> ContractResult:
    # Reference recordings are stored PORTABLE (see agent_replay/portable.py); GateToolTap does exact
    # string equality against a live call's real arguments, so the pool it matches against must be
    # widened back to THIS machine's real repo root, or every path-bearing call would come back
    # "unrecorded" the moment the recording and the candidate run are on different machines/checkouts.
    golden_events = portable.absolute_events(merged_golden_events(reference_runs))
    tool_bodies_before = COUNTS["tool_bodies"]

    candidate_trace: list = []
    # Phase 3: a SHARED step counter across the top-level tap and every nested (specialist) tap -- each
    # instance gets its own independent `self.step = 0` otherwise, handing out duplicate step numbers to
    # different agents' calls (see _spike/gate.py's step_counter parameter docstring). Only matters once
    # tap_factory below actually creates more than one tap; harmless (identical to today) for the
    # bare-module path, which never uses a factory at all.
    shared_step_counter: list[int] = [0]
    pass_through_set = set(pass_through or [])

    if adapter.is_ref(agent_module):
        # Phase 2 module:callable form -- an agent this project did not construct. See agent_replay/
        # adapter.py's module docstring for what was verified against the installed SDK before writing
        # this branch. model_id/system_prompt overrides are accepted (same as the bare-module path) but
        # NOT exercised by this phase's own VERIFY steps -- Phase 3's regression is introduced via the
        # adopter's own env-var configuration, not one of these overrides, since the rules forbid touching
        # the sample repo's agent code or prompts at all, including indirectly re-authoring its prompt
        # through this parameter.
        agent = adapter.build_from_ref(agent_module)
        if system_prompt is not None:
            agent.system_prompt = system_prompt
        resolved_system_prompt = system_prompt if system_prompt is not None else agent.system_prompt
        resolved_model_id = model_id or adapter.model_id_of(agent)
        # `resolved_system_prompt`/the real prompt are both known before the agent ever runs in this
        # branch -- moved up from after the run (Phase 2.1) so context_text/the _StepStream can be built
        # BEFORE the tap that feeds it is constructed, which is what lets a step stream live during the
        # run instead of only being computable once it is over.
        real_prompt = portable.to_absolute(prompt)
        context_text = f"{resolved_system_prompt} {real_prompt}"
        stream = _StepStream(contract, context_text)

        tap = _LiveTap(
            golden_events, candidate_trace, strict=strict, mutations=mutations or {},
            step_counter=shared_step_counter, pass_through=pass_through_set, _stream=stream, _on_step=on_step,
            _default_agent="supervisor",
        )

        def _nested_tap_factory(name: str, _golden=golden_events, _trace=candidate_trace, _mut=mutations, _strict=strict, _ctr=shared_step_counter, _pt=pass_through_set, _stream=stream, _on_step=on_step):
            return _LiveTap(_golden, _trace, strict=_strict, mutations=_mut or {}, agent_name=name, step_counter=_ctr, pass_through=_pt, _stream=_stream, _on_step=_on_step)

        adapter.warn_uninstrumented_nested(agent, pass_through_set, scenario_name=contract.scenario)
        inst = adapter.ScopedInstrumentation(
            agent=agent, trace=candidate_trace, tap=tap, model_id_override=model_id,
            tap_factory=_nested_tap_factory, pass_through=pass_through_set,
        )
        inst.attach()
        try:
            candidate_answer = str(agent(real_prompt))
        finally:
            inst.detach()
        for e in candidate_trace:
            e.setdefault("agent", "supervisor")
    else:
        agent_mod = paths.import_agent_module(agent_module)
        resolved_model_id = model_id or agent_mod.MODEL_ID
        resolved_system_prompt = system_prompt or agent_mod.SYSTEM_PROMPT
        real_prompt = portable.to_absolute(prompt)
        context_text = f"{resolved_system_prompt} {real_prompt}"
        stream = _StepStream(contract, context_text)
        tap = _LiveTap(
            golden_events, candidate_trace, strict=strict, mutations=mutations or {},
            step_counter=shared_step_counter, pass_through=pass_through_set, _stream=stream, _on_step=on_step,
            _default_agent=agent_module,
        )
        agent, _model, tap = agent_mod.build_agent(
            candidate_trace, replay=False, model_id=resolved_model_id, system_prompt=resolved_system_prompt, tap=tap
        )
        # `prompt` (a scenario's `input`) is stored portable too; expand it to a real, fetchable path on
        # THIS machine before the live model actually reads anything.
        candidate_answer = str(agent(real_prompt))
        for e in candidate_trace:
            e.setdefault("agent", agent_module)

    steps, first_divergence, attribution_boundary, pass_through_boundary, verdict = stream.finish()
    n_model = sum(e["type"] == "model" for e in candidate_trace)
    in_tok, out_tok = _token_totals(candidate_trace)  # spike/gate.py, unchanged
    return ContractResult(
        scenario=contract.scenario, steps=steps, first_divergence=first_divergence,
        attribution_boundary=attribution_boundary, verdict=verdict, candidate_answer=candidate_answer,
        n_model=n_model, injected=tap.injected, unrecorded=tap.unrecorded,
        tool_bodies=COUNTS["tool_bodies"] - tool_bodies_before,
        input_tokens=in_tok, output_tokens=out_tok, pass_through_boundary=pass_through_boundary,
    )
