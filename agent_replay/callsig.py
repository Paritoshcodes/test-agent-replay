"""The human-readable call-signature format used in contract `requires`/`permits` lines:

    tool_name(arg=value, arg2=value2)

Chosen over nested YAML mappings because a reviewer reads it exactly like the function call it represents,
and a diff of two contracts reads like a diff of two call lists. The trade-off: values are simple scalars
only (str/int/float/bool), rendered unquoted and split on ", " (comma-space). Every tool argument in this
repo (urls, package names, version strings, order ids) is such a scalar and never contains a literal
", ", so this holds in practice; a value that did contain one would silently misparse. A value that is a
bare digit string (e.g. an id "1001") is also ambiguous with a YAML-ish integer -- see parse_call.
"""

from __future__ import annotations

import json

from . import paths

paths.ensure_spike_importable()
from agent import canonical  # noqa: E402 (spike/agent.py, unchanged; import after sys.path setup above)


def _render_value(v) -> str:
    if isinstance(v, bool):
        return "true" if v else "false"
    return str(v)


def render_call(tool: str, args: dict) -> str:
    parts = [f"{k}={_render_value(v)}" for k, v in args.items()]
    return f"{tool}({', '.join(parts)})"


def _parse_scalar(raw: str):
    low = raw.lower()
    if low == "true":
        return True
    if low == "false":
        return False
    # A purely-numeric argument value (e.g. a numeric-looking id) is indistinguishable here from an
    # actual number and will be parsed as one -- a known, documented limitation (see README.md), not
    # silently swallowed. None of this repo's own tool arguments are purely numeric strings.
    try:
        return int(raw)
    except ValueError:
        pass
    try:
        return float(raw)
    except ValueError:
        pass
    return raw


def parse_call(text: str) -> tuple[str, dict]:
    text = text.strip()
    tool, _, rest = text.partition("(")
    rest = rest.rstrip(")")
    args: dict = {}
    if rest.strip():
        for piece in rest.split(", "):
            k, _, v = piece.partition("=")
            args[k.strip()] = _parse_scalar(v.strip())
    return tool.strip(), args


def call_key(tool: str, args: dict) -> tuple[str, str]:
    """Exactly the same canonicalization gate.py/gate_compare.py use for (tool_name, args) equality, so a
    key built from a parsed contract line always compares equal to a key built from a live candidate call
    that has the same tool and arguments."""
    return (tool, canonical(args))
