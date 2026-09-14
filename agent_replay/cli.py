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

from . import contract as contract_mod
from . import evaluate as evaluate_mod
from . import paths
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


def _load_reference_runs(scenario_name: str, n_runs: int, storage) -> list[dict]:
    runs = []
    for i in range(1, n_runs + 1):
        run_id = paths.reference_run_id(scenario_name, i)
        try:
            runs.append(storage.load(run_id))
        except Exception as e:
            raise SystemExit(
                f"could not load reference recording {run_id!r} ({e}). "
                f"Expected {n_runs} recorded run(s) for {scenario_name!r} -- "
                f"run `agent-replay record {scenario_name} --runs {n_runs}` again."
            )
    return runs


def _print_human(r: evaluate_mod.ContractResult, file) -> None:
    print(f"=== {r.scenario}: {r.verdict} ===", file=file)
    if r.first_divergence:
        fd = r.first_divergence
        print(f"first divergence: step {fd.step}  {fd.cause}  {fd.tool}  [{fd.attribution}]", file=file)
        print(f"  {fd.detail}", file=file)
    else:
        print("no divergence: every call is required or permitted, in order, nothing forbidden fired", file=file)
    print(f"attribution boundary: {'none' if r.attribution_boundary is None else f'step {r.attribution_boundary}'}", file=file)
    print(f"model calls: {r.n_model}   injected: {r.injected}   unrecorded: {r.unrecorded}", file=file)
    print(f"{'step':>4}  {'cause':<16}  {'attribution':<12}  tool", file=file)
    for s in r.steps:
        print(f"{s.step:>4}  {(s.cause or 'MATCH'):<16}  {s.attribution:<12}  {s.tool}", file=file)
    print(f"final answer: {r.candidate_answer[:160]!r}", file=file)


# ---------------------------------------------------------------------------------------------- init

def cmd_init(args: argparse.Namespace) -> int:
    sp = paths.scenarios_path()
    existing, redact = load_scenarios_file(sp) if sp.exists() else ([], [])

    non_interactive = bool(args.name and args.input and args.agent)
    if non_interactive:
        scenario = Scenario(name=args.name, agent=args.agent, input=args.input, runs=args.runs or 1)
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
        prompt = input("Input prompt for this scenario: ").strip()
        print("More runs produce a contract that tolerates the model's natural variation between runs.")
        runs_raw = input("How many runs to record [1]: ").strip()
        runs = int(runs_raw) if runs_raw else 1
        scenario = Scenario(name=name, agent=agent_name, input=prompt, runs=runs)
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
    recorded_events: list[list[dict]] = []
    for i in range(1, runs + 1):
        run_id = paths.reference_run_id(scenario.name, i)
        trace: list = []
        agent, _model, _tap = agent_mod.build_agent(trace)
        answer = str(agent(scenario.input))
        redact_trace(trace, redact_patterns)
        answer = redact_text(answer, redact_patterns)
        meta = {
            "prompt": scenario.input, "final_answer": answer, "final_answer_sha256": sha256(answer),
            "agent_module": scenario.agent, "model_id": agent_mod.MODEL_ID, "system_prompt": agent_mod.SYSTEM_PROMPT,
            "run_kind": "golden",
        }
        stats = storage.save(run_id, meta, trace)
        print(f"[{i}/{runs}] {run_id}: {len(trace)} events -> {stats}")
        recorded_events.append(trace)

    c = contract_mod.derive(scenario.name, recorded_events)
    out = paths.contract_path(scenario.name)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(contract_mod.render_yaml(c), encoding="utf-8")
    print(f"\nWrote {out}")
    print(f"  requires: {len(c.requires)}   permits: {len(c.permits)}   order edges: {len(c.order)}")
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
    overall = 0
    for scenario in targets:
        cpath = paths.contract_path(scenario.name)
        if not cpath.exists():
            _err(f"no contract for {scenario.name!r}; run `agent-replay record {scenario.name}` first")
            overall = 1
            continue
        c = contract_mod.load(cpath)
        reference = _load_reference_runs(scenario.name, c.n_runs, storage)
        r = evaluate_mod.run_and_evaluate(scenario.agent, scenario.input, c, reference, model_id=args.model)
        results.append(r)
        if r.verdict == "FAIL":
            overall = 1
        _print_human(r, out)

    if args.json:
        print(json.dumps([report_mod.to_json(r) for r in results], indent=2))
    elif args.format == "junit":
        xml = report_mod.to_junit(results)
        if args.junit_out:
            Path(args.junit_out).write_text(xml, encoding="utf-8")
            print(f"wrote {args.junit_out}", file=sys.stdout)
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
    from agent import sha256
    from storage import get_storage

    storage = get_storage(args.storage)
    data = storage.load(run_id)
    agent, model, tap = agent_mod.build_agent(data["events"], replay=True)
    answer = str(agent(data["prompt"]))
    answer_sha = sha256(answer)

    n_model = sum(e["type"] == "model" for e in data["events"])
    n_tool = sum(e["type"] == "tool" for e in data["events"])
    ok = answer_sha == data["final_answer_sha256"] and model.replayed == n_model and tap.replayed == n_tool

    print(f"replayed {run_id}: model {model.replayed}/{n_model}   tool {tap.replayed}/{n_tool}")
    print(f"answer sha matched: {ok}")
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

    try:
        r = evaluate_mod.run_and_evaluate(
            scenario.agent, scenario.input, c, reference,
            model_id=args.model_id, system_prompt=args.prompt, mutations=mutations, strict=args.strict,
        )
    except EventLoopException as e:
        if not isinstance(e.original_exception, UnrecordedToolCallError):
            raise
        halt = e.original_exception
        _err(f"HALTED (--strict): step {halt.step}, {halt.tool_name}({json.dumps(halt.tool_args)}) matches nothing in requires or permits")
        return 1

    out = sys.stderr if args.json else sys.stdout
    _print_human(r, out)
    if args.json:
        print(json.dumps(report_mod.to_json(r), indent=2))
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
    fmt = p_test.add_mutually_exclusive_group()
    fmt.add_argument("--json", action="store_true", help="Emit machine-readable JSON on stdout; human report moves to stderr.")
    fmt.add_argument("--format", choices=["junit"], default=None, help="Emit a JUnit XML report instead of the human report.")
    p_test.add_argument("--junit-out", default=None, help="Write the JUnit report to this path instead of stdout (with --format junit).")
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
