"""agent-replay CLI. Install with `pip install -e .`, then `agent-replay --help`.

Your agent writes its own behavioral contract by running. You review it in a pull request like code. The
build fails when your agent breaks it.

--storage local is the default and everything works with zero AWS beyond Bedrock itself: init, record,
test, replay and gate all take --storage aws only as an opt-in for CI / the deployed dashboard stack.
"""

from __future__ import annotations

import argparse
import importlib
import json
import sys
from pathlib import Path

from . import ci as ci_mod
from . import contract as contract_mod
from . import dashboard as dashboard_mod
from . import evaluate as evaluate_mod
from . import paths
from . import portable
from . import report as report_mod
from .redact import redact_text, redact_trace
from .scenarios import Scenario, load_scenarios_file, render_scenarios_yaml

paths.ensure_spike_importable()

_NON_AGENT_MODULES = {"gate", "gate_compare", "storage", "record", "replay", "record_audit", "replay_audit", "__init__"}


def _err(*a: object) -> None:
    print(*a, file=sys.stderr)


def _detect_agents() -> list[str]:
    """Every spike/*.py module exposing the build_agent(trace, ...) + MODEL_ID contract that
    spike/agent.py and spike/audit_agent.py both already implement -- generic, not name-matched."""
    found = []
    for f in sorted(paths.SPIKE_DIR.glob("*.py")):
        name = f.stem
        if name in _NON_AGENT_MODULES:
            continue
        try:
            mod = importlib.import_module(name)
        except Exception:
            continue
        if hasattr(mod, "build_agent") and hasattr(mod, "MODEL_ID"):
            found.append(name)
    return found


def _load_scenario(name: str) -> Scenario | None:
    scenarios, _ = load_scenarios_file(paths.scenarios_path())
    return next((s for s in scenarios if s.name == name), None)


# Exception type/message fragments observed (or documented by AWS) as transient Bedrock service hiccups,
# not a real behavioral difference in the agent: retrying once is the right response, not reporting FAIL.
# Observed for real this session: modelStreamErrorException, "Model produced invalid sequence as part of
# ToolUse" -- a live Nova hiccup mid-stream, unrelated to anything the agent or the contract did.
_TRANSIENT_MARKERS = (
    "modelStreamErrorException", "ModelTimeoutException", "ModelErrorException",
    "ThrottlingException", "ServiceUnavailableException", "InternalServerException", "EventStreamError",
)


def _is_transient(e: BaseException) -> bool:
    text = f"{type(e).__name__}: {e}"
    return any(marker in text for marker in _TRANSIENT_MARKERS)


def _run_scenario(scenario: Scenario, c, reference: list[dict], **kwargs) -> tuple[evaluate_mod.ContractResult | None, str | None, bool]:
    """Runs a scenario's live gate/test once, retrying ONCE if the failure looks like a transient Bedrock
    hiccup rather than a real behavioral difference (see _TRANSIENT_MARKERS). Returns
    (result, error_message, was_transient) -- result is None on failure, in which case error_message is
    always set. `was_transient` is True only when the retry ALSO failed and the failure still looks
    transient -- a scenario that succeeds on retry never surfaces as an error at all, which is the point."""
    try:
        return evaluate_mod.run_and_evaluate(scenario.agent, scenario.input, c, reference, **kwargs), None, False
    except Exception as e:
        if not _is_transient(e):
            return None, f"{type(e).__name__}: {e}", False
        _err(f"scenario {scenario.name!r} hit a transient error ({type(e).__name__}), retrying once...")
        try:
            return evaluate_mod.run_and_evaluate(scenario.agent, scenario.input, c, reference, **kwargs), None, False
        except Exception as e2:
            return None, f"{type(e2).__name__}: {e2}", _is_transient(e2)


class ReferenceLoadError(RuntimeError):
    """A scenario's reference recording(s) could not be loaded from the selected storage backend. NOT a
    SystemExit: `cmd_test` running every configured scenario must be able to catch this for ONE scenario
    and keep going -- one scenario missing its AWS recording must not discard every OTHER scenario's
    already-computed result (see docs/DECISIONS.md; this replaced a SystemExit that did exactly that,
    silently, the first time `agent-replay test` ran against a partially-migrated --storage aws fleet).
    cmd_gate and the single-scenario form of cmd_test still surface this cleanly: uncaught, it reaches
    main()'s own top-level `except Exception` handler, which prints it and exits 1 -- no bare traceback."""


def _load_reference_runs(scenario_name: str, n_runs: int, storage) -> list[dict]:
    runs = []
    for i in range(1, n_runs + 1):
        run_id = paths.reference_run_id(scenario_name, i)
        try:
            runs.append(storage.load(run_id))
        except Exception as e:
            raise ReferenceLoadError(
                f"could not load reference recording {run_id!r} ({e}). "
                f"Expected {n_runs} recorded run(s) for {scenario_name!r} -- "
                f"run `agent-replay record {scenario_name} --runs {n_runs} --storage <backend>`."
            ) from e
    return runs


def _print_error(scenario: str, message: str, transient: bool, file) -> None:
    """Mirrors _print_human's `=== name: VERDICT ===` header so ERROR reads as its own distinct state in
    a terminal scan, not a FAIL and not silence. transient gets its own visible tag -- a live-model hiccup
    that survived one retry is real, if rare, live-model unreliability, not a behavioral regression."""
    tag = " (TRANSIENT -- Bedrock hiccup, retried once, still failed; likely not a real regression)" if transient else ""
    print(f"=== {scenario}: ERROR{tag} ===", file=file)
    print(f"  {message}", file=file)


def _persist_for_dashboard(scenario: Scenario, c, cpath: Path, r: evaluate_mod.ContractResult, reference: list[dict], model_id: str | None) -> None:
    """Best-effort: a candidate TEST run has never been persisted anywhere before Phase 2 (only reference
    recordings were) -- the dashboard has nothing to read for "the run behind this PR" without this.
    Failure here must never fail the gate itself (dashboard visibility is a nice-to-have on top of the
    actual PASS/FAIL signal, not a precondition for it), so it's caught and merely warned about."""
    try:
        ci = ci_mod.ci_metadata()
        run_uid = (ci.get("commit_sha") or "")[:7] or f"local-{int(__import__('time').time())}"
        run_id = f"{scenario.name}--candidate--{run_uid}"
        contract_hash = sha256_text(cpath.read_text(encoding="utf-8"))
        # reference[0]'s prompt is stored PORTABLE ({repo} token); the candidate's own step args are
        # already real/absolute (this run's actual values -- see evaluate.py). A dashboard viewer (a
        # browser, potentially nowhere near any checkout) has no "this machine" to expand {repo} against
        # later, so expand it NOW, against the machine that actually ran this test, before persisting --
        # the result is at least a real, readable path instead of a literal, meaningless token.
        ref = reference[0]  # representative reference run for display -- see agent_replay/dashboard.py
        gate_run = dashboard_mod.build_gate_run(
            result=r, run_id=run_id, scenario_agent=scenario.agent,
            golden_prompt=portable.to_absolute(ref["prompt"]), golden_final_answer=portable.to_absolute(ref["final_answer"]),
            golden_final_answer_sha256=ref["final_answer_sha256"], model_id=model_id,
        )
        from storage import AwsTraceStorage

        AwsTraceStorage().save_test_run(
            run_id,
            {"agent_module": scenario.agent, "model_id": model_id, "scenario": scenario.name, "contract_hash": contract_hash, "verdict": r.verdict, **ci},
            gate_run,
        )
        # stderr, NOT stdout: under --json, stdout carries ONLY the machine-readable result document.
        # This line used to be a bare print(), which prepended "  dashboard: saved <id>" to the JSON and
        # broke every CI consumer with "JSONDecodeError: Expecting value: line 1 column 3". The failure
        # branch below already used _err() -- this is the same channel, applied consistently.
        _err(f"  dashboard: saved {run_id}")
    except Exception as e:
        _err(f"warning: could not persist dashboard data for {scenario.name!r} ({type(e).__name__}: {e}) -- gate result above is unaffected")


def sha256_text(text: str) -> str:
    import hashlib

    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _print_human(r: evaluate_mod.ContractResult, file) -> None:
    print(f"=== {r.scenario}: {r.verdict} ===", file=file)
    if r.first_divergence:
        fd = r.first_divergence
        print(f"first divergence: step {fd.step}  {fd.cause}  {fd.tool}  [{fd.attribution}]", file=file)
        print(f"  {fd.detail}", file=file)
    else:
        print("no divergence: every call is required or permitted, in order, nothing forbidden fired", file=file)
    print(f"attribution boundary: {'none' if r.attribution_boundary is None else f'step {r.attribution_boundary}'}", file=file)
    print(f"model calls: {r.n_model}   injected: {r.injected}   unrecorded: {r.unrecorded}   real tool executions: {r.tool_bodies}", file=file)
    print(f"{'step':>4}  {'cause':<16}  {'attribution':<12}  {'note':<9}  tool", file=file)
    for s in r.steps:
        note = "MUTATED" if s.mutated else ""
        print(f"{s.step:>4}  {(s.cause or 'MATCH'):<16}  {s.attribution:<12}  {note:<9}  {s.tool}", file=file)
    print(f"final answer: {r.candidate_answer[:160]!r}", file=file)


# ---------------------------------------------------------------------------------------------- init

def cmd_init(args: argparse.Namespace) -> int:
    sp = paths.scenarios_path()
    existing, redact = load_scenarios_file(sp) if sp.exists() else ([], [])

    non_interactive = bool(args.name and args.input and args.agent)
    if non_interactive:
        scenario = Scenario(name=args.name, agent=args.agent, input=portable.to_portable(args.input), runs=args.runs or 1)
        do_record = bool(args.record)
    else:
        detected = _detect_agents()
        if not detected:
            _err("No Strands agent modules detected in spike/ (need build_agent + MODEL_ID). Pass --agent explicitly.")
            return 1
        print("Detected agent modules in spike/:")
        for i, m in enumerate(detected, 1):
            print(f"  {i}. {m}")
        raw = input(f"Pick one [1-{len(detected)}, default 1]: ").strip()
        agent_name = detected[int(raw) - 1] if raw else detected[0]
        name = input("Scenario name: ").strip()
        print(f"Input prompt for this scenario. If it names a file in this repo, write it as {portable.TOKEN}/relative/path")
        print(f"(e.g. file://{portable.TOKEN}/requirements.txt) instead of a real absolute path -- that is what")
        print("makes the recording and its contract portable to another machine or a CI checkout.")
        prompt = input("Input prompt: ").strip()
        print("More runs produce a contract that tolerates the model's natural variation between runs.")
        runs_raw = input("How many runs to record [1]: ").strip()
        runs = int(runs_raw) if runs_raw else 1
        # A user may still type a real absolute path out of habit -- collapse it automatically if it
        # happens to point inside this checkout, same as the non-interactive branch above.
        scenario = Scenario(name=name, agent=agent_name, input=portable.to_portable(prompt), runs=runs)
        do_record = input(f"Record '{scenario.name}' now? [Y/n] ").strip().lower() not in ("n", "no")

    existing = [s for s in existing if s.name != scenario.name] + [scenario]
    sp.parent.mkdir(parents=True, exist_ok=True)
    sp.write_text(render_scenarios_yaml(existing, redact), encoding="utf-8")
    print(f"Wrote {sp}")

    if do_record:
        rc = cmd_record(argparse.Namespace(scenario=scenario.name, runs=None, storage=args.storage))
        if rc != 0:
            return rc

    print()
    print("Next steps:")
    print(f"  agent-replay record {scenario.name}              # capture {scenario.runs} run(s), derive a contract")
    print(f"  cat agent-replay/contracts/{scenario.name}.yaml   # read what it inferred")
    print(f"  agent-replay test {scenario.name}                 # gate a fresh live run against it")
    print(f"  agent-replay record {scenario.name} --storage aws # persist to the deployed AWS stack instead")
    print("  agent-replay test --json --format junit           # wire into CI once you trust it")
    return 0


# ---------------------------------------------------------------------------------------------- record

def cmd_record(args: argparse.Namespace) -> int:
    scenario = _load_scenario(args.scenario)
    if scenario is None:
        _err(f"unknown scenario {args.scenario!r}; run `agent-replay init` first")
        return 1
    runs = args.runs or scenario.runs

    _, redact_patterns = load_scenarios_file(paths.scenarios_path())
    agent_mod = importlib.import_module(scenario.agent)
    from agent import sha256  # spike/agent.py, unchanged
    from storage import get_storage

    storage = get_storage(args.storage)
    ci = ci_mod.ci_metadata()

    # Phase 1: make every live run first, entirely in memory. Nothing is persisted yet, because
    # contract_hash (below) needs the DERIVED contract, and the contract needs every run's events --
    # storage.save() for run i cannot know the hash of a contract that does not exist until run N is done.
    runs_data: list[tuple[str, list[dict], str]] = []  # (run_id, trace, answer)
    for i in range(1, runs + 1):
        run_id = paths.reference_run_id(scenario.name, i)
        trace: list = []
        agent, _model, _tap = agent_mod.build_agent(trace)
        # scenario.input is stored PORTABLE (see agent_replay/portable.py); expand it to a real,
        # fetchable path on THIS machine for the actual run, then collapse the resulting trace back to
        # portable form before anything is persisted or derived from.
        answer = str(agent(portable.to_absolute(scenario.input)))
        redact_trace(trace, redact_patterns)
        portable.portable_trace(trace)
        answer = redact_text(answer, redact_patterns)
        answer = portable.to_portable(answer)
        print(f"[{i}/{runs}] {run_id}: {len(trace)} events recorded")
        runs_data.append((run_id, trace, answer))

    # Phase 2: derive the contract (preserving any hand-authored forbids already on disk) and hash it --
    # this IS the contract every one of the N runs below will be tagged with.
    out = paths.contract_path(scenario.name)
    existing_forbids: list[str] = []
    if out.exists():
        try:
            existing_forbids = contract_mod.load(out).forbids
        except Exception as e:
            _err(f"warning: could not read existing contract at {out} to preserve its forbids rules ({e}); starting with none")

    recorded_events = [trace for _run_id, trace, _answer in runs_data]
    c = contract_mod.derive(scenario.name, recorded_events, existing_forbids=existing_forbids)
    for w in contract_mod.forbids_warnings(c.forbids, recorded_events):
        print(f"warning: {w}")
    contract_text = contract_mod.render_yaml(c)
    contract_hash = sha256(contract_text)

    # Phase 3: now persist every run, tagged with the contract it produced and whatever CI told us about
    # this invocation (agent_replay/ci.py -- None for every field when run locally).
    for run_id, trace, answer in runs_data:
        meta = {
            "prompt": scenario.input, "final_answer": answer, "final_answer_sha256": sha256(answer),
            "agent_module": scenario.agent, "model_id": agent_mod.MODEL_ID, "system_prompt": agent_mod.SYSTEM_PROMPT,
            "run_kind": "golden", "scenario": scenario.name, "contract_hash": contract_hash, **ci,
        }
        stats = storage.save(run_id, meta, trace)
        print(f"  saved {run_id} -> {stats}")

    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(contract_text, encoding="utf-8")
    print(f"\nWrote {out}  (contract_hash {contract_hash[:16]}...)")
    print(f"  requires: {len(c.requires)}   permits: {len(c.permits)}   order edges: {len(c.order)}   forbids: {len(c.forbids)}")
    return 0


# ---------------------------------------------------------------------------------------------- test

def cmd_test(args: argparse.Namespace) -> int:
    all_scenarios, _ = load_scenarios_file(paths.scenarios_path())
    if args.scenario:
        scenario = _load_scenario(args.scenario)
        if scenario is None:
            _err(f"unknown scenario {args.scenario!r}")
            return 1
        targets = [scenario]
    else:
        targets = all_scenarios
        if not targets:
            _err("no scenarios configured; run `agent-replay init` first")
            return 1

    from storage import get_storage
    storage = get_storage(args.storage)

    out = sys.stderr if args.json else sys.stdout
    results: list[evaluate_mod.ContractResult] = []
    errors: list[tuple[str, str, bool]] = []  # (scenario, message, transient) -- never got a ContractResult
    overall = 0
    for scenario in targets:
        cpath = paths.contract_path(scenario.name)
        if not cpath.exists():
            msg = f"no contract for {scenario.name!r}; run `agent-replay record {scenario.name}` first"
            _print_error(scenario.name, msg, False, out)
            errors.append((scenario.name, msg, False))
            overall = 1
            continue
        c = contract_mod.load(cpath)
        try:
            reference = _load_reference_runs(scenario.name, c.n_runs, storage)
        except ReferenceLoadError as e:
            _print_error(scenario.name, str(e), False, out)
            errors.append((scenario.name, str(e), False))
            overall = 1
            continue
        # One scenario's live-run failure must not discard every OTHER scenario's already-computed
        # result (the same class of bug ReferenceLoadError was fixed for, above). _run_scenario also
        # retries once if the failure looks like a transient Bedrock hiccup rather than a real
        # behavioral difference, so a passing rerun never shows up as an error at all.
        r, msg, transient = _run_scenario(scenario, c, reference, model_id=args.model)
        if r is None:
            _print_error(scenario.name, msg, transient, out)
            errors.append((scenario.name, msg, transient))
            overall = 1
            continue
        results.append(r)
        if r.verdict == "FAIL":
            overall = 1
        _print_human(r, out)
        if args.storage == "aws":
            _persist_for_dashboard(scenario, c, cpath, r, reference, args.model)

    if args.json:
        payload = [report_mod.to_json(r) for r in results] + [report_mod.error_dict(name, msg, transient) for name, msg, transient in errors]
        print(json.dumps(payload, indent=2))
    if args.format == "junit":
        xml = report_mod.to_junit(results, errors)
        # Both flags can share one invocation (the CI workflow does exactly this: one live run, one JSON
        # payload for the PR comment, one XML file for the artifact). stdout belongs to JSON the moment
        # --json is set, so JUnit falls back to a real file in that case even without --junit-out.
        target = args.junit_out or ("agent-replay-report.xml" if args.json else None)
        if target:
            Path(target).write_text(xml, encoding="utf-8")
            print(f"wrote {target}", file=sys.stderr if args.json else sys.stdout)
        else:
            print(xml)

    return overall


# ---------------------------------------------------------------------------------------------- replay

def cmd_replay(args: argparse.Namespace) -> int:
    scenario = _load_scenario(args.scenario)
    if scenario is None:
        _err(f"unknown scenario {args.scenario!r}")
        return 1
    run_id = args.run_id or paths.reference_run_id(scenario.name, 1)

    agent_mod = importlib.import_module(scenario.agent)
    from agent import COUNTS, sha256
    from storage import get_storage

    storage = get_storage(args.storage)
    # --- LOAD PHASE: --storage aws genuinely uses the network here; the zero-network proof below only
    # covers what happens AFTER this point (spike/replay.py's own load/run boundary, reused verbatim).
    data = storage.load(run_id)
    socket_before = COUNTS["socket_ops"]
    bedrock_before = COUNTS["bedrock_http"]
    tool_bodies_before = COUNTS["tool_bodies"]
    # --- END LOAD PHASE ---

    # --- RUN PHASE ---
    # Stored traces are portable ({repo} token); byte-identical replay needs the REAL absolute form that
    # was actually sent to Bedrock/the tools on record, or spike/agent.py's exact canonical-equality
    # checks (ReplayableBedrockModel.stream, ToolTap._inject -- both unchanged) reject every call as
    # diverged. Expanding against THIS machine's own repo root reproduces the original exactly when
    # replaying on the same checkout; see agent_replay/portable.py's docstring for why this is NOT claimed
    # to make replay itself portable across machines.
    events = portable.absolute_events(data["events"])
    prompt = portable.to_absolute(data["prompt"])
    agent, model, tap = agent_mod.build_agent(events, replay=True)
    answer = str(agent(prompt))
    answer_sha = sha256(answer)
    # --- END RUN PHASE ---

    run_socket = COUNTS["socket_ops"] - socket_before
    run_bedrock = COUNTS["bedrock_http"] - bedrock_before
    run_tool_bodies = COUNTS["tool_bodies"] - tool_bodies_before

    n_model = sum(e["type"] == "model" for e in events)
    n_tool = sum(e["type"] == "tool" for e in events)
    consumed = model.replayed == n_model and tap.replayed == n_tool
    zero_network = run_socket == 0 and run_bedrock == 0 and run_tool_bodies == 0
    ok = answer_sha == data["final_answer_sha256"] and consumed and zero_network

    print(f"replayed {run_id}: model {model.replayed}/{n_model}   tool {tap.replayed}/{n_tool}")
    print(f"answer sha matched: {answer_sha == data['final_answer_sha256']}")
    print(f"real tool executions during run phase: {run_tool_bodies} (must be 0)")
    print(f"bedrock HTTP sends during run phase: {run_bedrock} (must be 0)")
    print(f"non-loopback socket ops during run phase: {run_socket} (must be 0)")
    if not zero_network:
        _err(f"PROOF FAILED: real execution or network activity happened during the run phase")
    print("PASS" if ok else "FAIL")
    return 0 if ok else 1


# ---------------------------------------------------------------------------------------------- gate

def cmd_gate(args: argparse.Namespace) -> int:
    scenario = _load_scenario(args.scenario)
    if scenario is None:
        _err(f"unknown scenario {args.scenario!r}")
        return 1
    cpath = paths.contract_path(scenario.name)
    if not cpath.exists():
        _err(f"no contract for {scenario.name!r}; run `agent-replay record {scenario.name}` first")
        return 1
    c = contract_mod.load(cpath)

    from gate import _parse_mutate_args
    from gate import UnrecordedToolCallError
    from storage import get_storage
    from strands.types.exceptions import EventLoopException

    storage = get_storage(args.storage)
    reference = _load_reference_runs(scenario.name, c.n_runs, storage)
    golden_events_flat = evaluate_mod.merged_golden_events(reference)
    mutations = _parse_mutate_args(args.mutate, golden_events_flat)

    kwargs = dict(model_id=args.model_id, system_prompt=args.prompt, mutations=mutations, strict=args.strict)
    try:
        r = evaluate_mod.run_and_evaluate(scenario.agent, scenario.input, c, reference, **kwargs)
    except EventLoopException as e:
        # A deliberate --strict halt is a signal the user asked for, not a failure to retry.
        if not isinstance(e.original_exception, UnrecordedToolCallError):
            raise
        halt = e.original_exception
        _err(f"HALTED (--strict): step {halt.step}, {halt.tool_name}({json.dumps(halt.tool_args)}) matches nothing in requires or permits")
        return 1
    except Exception as e:
        if not _is_transient(e):
            _err(f"scenario {scenario.name!r} failed during its live run: {type(e).__name__}: {e}")
            return 1
        _err(f"scenario {scenario.name!r} hit a transient error ({type(e).__name__}), retrying once...")
        try:
            r = evaluate_mod.run_and_evaluate(scenario.agent, scenario.input, c, reference, **kwargs)
        except Exception as e2:
            transient = _is_transient(e2)
            _err(f"scenario {scenario.name!r} failed{' (transient, after one retry)' if transient else ''}: {type(e2).__name__}: {e2}")
            if args.json:
                print(json.dumps(report_mod.error_dict(scenario.name, f"{type(e2).__name__}: {e2}", transient), indent=2))
            return 1

    out = sys.stderr if args.json else sys.stdout
    _print_human(r, out)
    if args.json:
        print(json.dumps(report_mod.to_json(r), indent=2))
    if args.storage == "aws":
        _persist_for_dashboard(scenario, c, cpath, r, reference, args.model_id)
    return 1 if r.verdict == "FAIL" else 0


# ---------------------------------------------------------------------------------------------- argparse

def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="agent-replay", description=__doc__.split("\n\n")[0])
    sub = p.add_subparsers(dest="command", required=True)

    p_init = sub.add_parser("init", help="Set up scenarios.yaml for this project (interactive by default).")
    p_init.add_argument("--agent", default=None, help="Agent module name (non-interactive).")
    p_init.add_argument("--name", default=None, help="Scenario name (non-interactive).")
    p_init.add_argument("--input", default=None, help="Input prompt for the scenario (non-interactive).")
    p_init.add_argument("--runs", type=int, default=None, help="Run count to record (default 1).")
    p_init.add_argument("--record", action="store_true", help="Non-interactive mode: record immediately after writing scenarios.yaml.")
    p_init.add_argument("--storage", choices=["local", "aws"], default="local")
    p_init.set_defaults(func=cmd_init)

    p_record = sub.add_parser("record", help="Record N runs of a scenario and derive its contract.")
    p_record.add_argument("scenario")
    p_record.add_argument("--runs", type=int, default=None, help="Override the scenario's configured run count.")
    p_record.add_argument("--storage", choices=["local", "aws"], default="local")
    p_record.set_defaults(func=cmd_record)

    p_test = sub.add_parser("test", help="Gate a live run against a scenario's derived contract. Exit 0 PASS, 1 FAIL.")
    p_test.add_argument("scenario", nargs="?", default=None, help="Omit to test every configured scenario.")
    p_test.add_argument("--model", default=None, help="Replacement Bedrock model ID.")
    p_test.add_argument("--storage", choices=["local", "aws"], default="local")
    p_test.add_argument("--json", action="store_true", help="Emit machine-readable JSON on stdout; human report moves to stderr.")
    p_test.add_argument("--format", choices=["junit"], default=None, help="Also emit a JUnit XML report (combinable with --json).")
    p_test.add_argument("--junit-out", default=None, help="Write the JUnit report to this path. With --format junit alone (no --json) omitting this prints XML to stdout instead; combined with --json it defaults to ./agent-replay-report.xml, since stdout is already JSON.")
    p_test.set_defaults(func=cmd_test)

    p_replay = sub.add_parser("replay", help="Full byte-identical replay of one recorded run: zero real model or tool calls.")
    p_replay.add_argument("scenario")
    p_replay.add_argument("--run-id", default=None, help=f"Defaults to <scenario>--1.")
    p_replay.add_argument("--storage", choices=["local", "aws"], default="local")
    p_replay.set_defaults(func=cmd_replay)

    p_gate = sub.add_parser("gate", help="Ad hoc: gate one live run against a contract with a prompt/mutation override.")
    p_gate.add_argument("scenario")
    p_gate.add_argument("--prompt", default=None, help="Replacement SYSTEM prompt for this run only (the scenario's own input message is unchanged).")
    p_gate.add_argument("--model-id", default=None, help="Replacement Bedrock model ID for this run only.")
    p_gate.add_argument("--mutate", action="append", default=[], metavar="TOOL:JSON", help="Shallow-merge JSON into a tool's injected result before the run. Repeatable.")
    p_gate.add_argument("--strict", action="store_true", help="Halt at the first call the contract cannot match at all, instead of injecting a synthetic error.")
    p_gate.add_argument("--json", action="store_true", help="Also emit machine-readable JSON on stdout.")
    p_gate.add_argument("--storage", choices=["local", "aws"], default="local")
    p_gate.set_defaults(func=cmd_gate)

    return p


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        return args.func(args)
    except SystemExit:
        raise
    except Exception as e:
        _err(f"agent-replay: {e}")
        return 1


if __name__ == "__main__":
    sys.exit(main())
