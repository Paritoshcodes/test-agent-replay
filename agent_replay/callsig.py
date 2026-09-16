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

from ._spike.agent import canonical


def _render_value(v) -> str:
    if isinstance(v, bool):
        return "true" if v else "false"
    return str(v)


def render_call(tool: str, args: dict, agent: str | None = None) -> str:
    """`agent` (Phase 3, docs/DECISIONS.md) is PURE DISPLAY -- it does not change what this line means for
    matching (call_key below still keys on (tool, args) alone; see contract.py's render_yaml for the "only
    qualify when more than one agent appears" policy). Prefixing here rather than folding agent into the
    key keeps every existing single-agent contract byte-for-byte unchanged and keeps matching behavior
    (and therefore every PASS/FAIL verdict) completely untouched by this addition."""
    prefix = f"{agent}." if agent else ""
    parts = [f"{k}={_render_value(v)}" for k, v in args.items()]
    return f"{prefix}{tool}({', '.join(parts)})"


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
    """Accepts both the unqualified `tool(args)` form (every contract before Phase 3, unchanged) and the
    agent-qualified `agent.tool(args)` form (render_call above) -- the agent prefix, if present, is
    stripped and discarded here, never returned: parsing intentionally throws it away because matching
    never used it (see render_call's docstring). No tool or agent name in this project contains a literal
    "." so `rpartition` on the part before "(" is unambiguous either way."""
    text = text.strip()
    tool, _, rest = text.partition("(")
    if "." in tool:
        _agent, _, tool = tool.rpartition(".")
    rest = rest.rstrip(")")
    args: dict = {}
    if rest.strip():
        for piece in rest.split(", "):
            k, _, v = piece.partition("=")
            args[k.strip()] = _parse_scalar(v.strip())
    return tool.strip(), args


# Phase 2.4 seam: matching is (tool_name, exact_args) everywhere today, and stays that way -- this dict
# exists so a FUTURE per-tool keying policy (e.g. a tool whose argument is free natural-language text
# rephrased by the model every call, which can then never match twice under exact equality -- see
# docs/LIMITATIONS.md, "Free-text tool arguments defeat exact-match keying", with real measured numbers
# from the Phase 0 sample-agent runs) is a lookup added here, not a rewrite of every call site that
# currently calls call_key(tool, args). Not wired to anything yet -- "exact" is the only registered
# strategy, and it is byte-identical to what call_key did before this seam existed.
_KEY_STRATEGIES: dict[str, callable] = {}


def register_key_strategy(name: str, fn) -> None:
    _KEY_STRATEGIES[name] = fn


def _exact_keying(args: dict) -> str:
    return canonical(args)


register_key_strategy("exact", _exact_keying)


def call_key(tool: str, args: dict, *, strategy: str = "exact") -> tuple[str, str]:
    """Exactly the same canonicalization gate.py/gate_compare.py use for (tool_name, args) equality, so a
    key built from a parsed contract line always compares equal to a key built from a live candidate call
    that has the same tool and arguments. `strategy` defaults to "exact" -- today's only behavior,
    unconditionally -- see the seam comment above."""
    fn = _KEY_STRATEGIES.get(strategy, _exact_keying)
    return (tool, fn(args))
