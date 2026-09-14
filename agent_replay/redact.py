"""Regex redaction applied at capture time, before anything is written to disk or AWS.

A blunt instrument, not a guarantee: it string-substitutes matches inside every string leaf of a recorded
event tree (tool arguments, tool output text, model output text). It cannot redact a value no pattern
matches, and it will over-redact if a pattern is too broad. Review what a scenario actually records before
relying on `redact:` for anything genuinely sensitive -- see README.md.
"""

from __future__ import annotations

import re

from . import paths

paths.ensure_spike_importable()
from agent import sha256  # noqa: E402 (spike/agent.py, unchanged)

_MASK = "[REDACTED]"


def _redact_string(s: str, patterns: list[re.Pattern]) -> str:
    for p in patterns:
        s = p.sub(_MASK, s)
    return s


def _walk(obj, patterns: list[re.Pattern]):
    if isinstance(obj, str):
        return _redact_string(obj, patterns)
    if isinstance(obj, list):
        return [_walk(v, patterns) for v in obj]
    if isinstance(obj, dict):
        return {k: _walk(v, patterns) for k, v in obj.items()}
    return obj


def redact_trace(trace: list, raw_patterns: list[str]) -> None:
    """Mutates `trace` in place. Recomputes each event's output_sha256 afterward -- it is a hash of that
    event's own output, and redaction changes the output, so leaving the pre-redaction hash in place would
    make trace files describe content that was never actually written to them."""
    if not raw_patterns:
        return
    patterns = [re.compile(p) for p in raw_patterns]
    for event in trace:
        event["input"] = _walk(event["input"], patterns)
        event["output"] = _walk(event["output"], patterns)
        event["output_sha256"] = sha256(event["output"])


def redact_text(text: str, raw_patterns: list[str]) -> str:
    if not raw_patterns:
        return text
    return _redact_string(text, [re.compile(p) for p in raw_patterns])
