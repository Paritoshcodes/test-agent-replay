"""Machine-readable output: --json (a plain dict, one per scenario) and --format junit (stdlib
xml.etree.ElementTree only -- no junit-xml dependency needed for output this simple)."""

from __future__ import annotations

import xml.etree.ElementTree as ET

from .evaluate import ContractResult, ContractStep


def _step_dict(s: ContractStep) -> dict:
    return {"step": s.step, "tool": s.tool, "args": s.args, "gate_status": s.gate_status, "cause": s.cause, "attribution": s.attribution, "detail": s.detail}


def to_json(r: ContractResult) -> dict:
    return {
        "scenario": r.scenario,
        "verdict": r.verdict,
        "attribution_boundary": r.attribution_boundary,
        "first_divergence": _step_dict(r.first_divergence) if r.first_divergence else None,
        "steps": [_step_dict(s) for s in r.steps],
        "counters": {"model_calls": r.n_model, "injected": r.injected, "unrecorded": r.unrecorded},
        "candidate_answer": r.candidate_answer,
    }


def to_junit(results: list[ContractResult]) -> str:
    failures = sum(r.verdict == "FAIL" for r in results)
    suite = ET.Element("testsuite", name="agent-replay", tests=str(len(results)), failures=str(failures))
    for r in results:
        case = ET.SubElement(suite, "testcase", classname="agent-replay.contract", name=r.scenario)
        if r.verdict == "FAIL":
            fd = r.first_divergence
            message = f"{fd.cause} at step {fd.step} ({fd.tool})" if fd else "contract violation"
            failure = ET.SubElement(case, "failure", message=message, type=(fd.cause if fd else "FAIL"))
            failure.text = fd.detail if fd else ""
    return '<?xml version="1.0" encoding="UTF-8"?>\n' + ET.tostring(suite, encoding="unicode")
