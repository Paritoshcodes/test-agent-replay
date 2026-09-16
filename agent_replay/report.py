"""Machine-readable output: --json (a plain dict, one per scenario) and --format junit (stdlib
xml.etree.ElementTree only -- no junit-xml dependency needed for output this simple)."""

from __future__ import annotations

import xml.etree.ElementTree as ET

from .evaluate import ContractResult, ContractStep


def _step_dict(s: ContractStep) -> dict:
    return {
        "step": s.step, "tool": s.tool, "args": s.args, "gate_status": s.gate_status, "cause": s.cause,
        "attribution": s.attribution, "detail": s.detail, "mutated": s.mutated, "agent": s.agent, "membership": s.membership,
    }


def to_json(r: ContractResult) -> dict:
    return {
        "scenario": r.scenario,
        "verdict": r.verdict,
        "attribution_boundary": r.attribution_boundary,
        "pass_through_boundary": r.pass_through_boundary,
        "first_divergence": _step_dict(r.first_divergence) if r.first_divergence else None,
        "steps": [_step_dict(s) for s in r.steps],
        "counters": {"model_calls": r.n_model, "injected": r.injected, "unrecorded": r.unrecorded, "tool_bodies": r.tool_bodies},
        "candidate_answer": r.candidate_answer,
    }


def error_dict(scenario: str, message: str, transient: bool = False) -> dict:
    """Same JSON shape as to_json(), for a scenario that never produced a ContractResult at all. Distinct
    from verdict "FAIL" (a live run that violated its contract): "ERROR" is "we never got to find out".
    Both must read as NOT a pass -- see render_pr_comment.py and the bug this fixed (docs/DECISIONS.md): a
    scenario missing from --storage aws used to be silently dropped, and an otherwise-all-PASS remainder
    would then render as an overall pass despite `agent-replay test` itself having exited 1.

    `transient`: True only when the failure looks like a Bedrock service hiccup (agent_replay/cli.py's
    _is_transient) that ALSO failed on a same-input retry -- a real, if rare, live-model unreliability, not
    a behavioral regression and not a data-availability problem. Kept visually and structurally distinct
    everywhere this reaches a human: the CLI, this JSON, the JUnit report, and the PR comment."""
    return {
        "scenario": scenario, "verdict": "ERROR", "attribution_boundary": None, "first_divergence": None,
        "steps": [], "counters": {"model_calls": 0, "injected": 0, "unrecorded": 0, "tool_bodies": 0},
        "candidate_answer": "", "error": message, "transient": transient,
    }


def to_junit(results: list[ContractResult], errors: list[tuple[str, str, bool]] | None = None) -> str:
    errors = errors or []
    failures = sum(r.verdict == "FAIL" for r in results)
    suite = ET.Element("testsuite", name="agent-replay", tests=str(len(results) + len(errors)), failures=str(failures), errors=str(len(errors)))
    for r in results:
        case = ET.SubElement(suite, "testcase", classname="agent-replay.contract", name=r.scenario)
        if r.verdict == "FAIL":
            fd = r.first_divergence
            message = f"{fd.cause} at step {fd.step} ({fd.tool})" if fd else "contract violation"
            failure = ET.SubElement(case, "failure", message=message, type=(fd.cause if fd else "FAIL"))
            failure.text = fd.detail if fd else ""
    for scenario, message, transient in errors:
        case = ET.SubElement(suite, "testcase", classname="agent-replay.contract", name=scenario)
        error_type = "TransientError" if transient else "ReferenceLoadError"
        error = ET.SubElement(case, "error", message=("transient Bedrock error, retried once, still failed" if transient else "could not evaluate"), type=error_type)
        error.text = message
    return '<?xml version="1.0" encoding="UTF-8"?>\n' + ET.tostring(suite, encoding="unicode")
