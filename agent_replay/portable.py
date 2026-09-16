"""Portability for anything derived from a real filesystem path under the repo checkout.

A recorded tool call can contain a path like `file:///D:/Project/agent_replay/requirements.txt` -- correct
on the machine that recorded it, wrong on any other drive letter, OS, or clone directory. Persisted
artifacts (traces, contracts) must store a portable placeholder instead of that; anything that needs a
REAL, fetchable path -- the prompt handed to a live agent call, or the reference pool handed to
spike/gate.py's GateToolTap (which exact-matches against a live call's real, absolute arguments) -- must
expand it back to THIS machine's actual repo root at the moment it's needed.

Chose to normalize at THREE points, not one, because they are not interchangeable:
  - CAPTURE (agent_replay/cli.py's cmd_record, right after a real run, before storage.save() and before
    contract.derive()): the only point where what gets PERSISTED is decided. Fixing only comparison or only
    derivation would leave every stored trace and every committed contract carrying whatever machine
    happened to record it -- exactly the bug this phase exists to fix.
  - EXPAND, at the two points a REAL absolute path is actually required for something to work: building
    the prompt for a live `agent(...)` call (spike/audit_agent.py's read_manifest tool does a real
    urllib fetch), and widening a portable reference recording back into GateToolTap's injection pool
    (GateToolTap does exact string equality, unchanged, so it must see THIS machine's real form to match a
    live call's real arguments -- normalizing only the contract file would leave injection itself broken,
    which breaks the entire run, not just the comparison).
  - COMPARISON (agent_replay/evaluate.py, only for the (tool, args) KEY used to check contract membership):
    a live candidate's tool_use arguments are real/absolute (matching the reference pool, so injection
    works); the contract's requires/permits are portable (as read from the committed file). The two must be
    reconciled at the one place they are actually compared, without mutating what actually ran.

Not portable: `agent-replay replay`'s byte-identical mode replays a recorded model CONVERSATION verbatim
(spike/agent.py's ReplayableBedrockModel rejects any input that doesn't canonical-match the trace exactly).
The original absolute path is embedded in that conversation's message history, which this module does not
rewrite -- doing so would mean parsing and rewriting Bedrock message content, not just tool call arguments,
which is out of scope here. See docs/LIMITATIONS.md.
"""

from __future__ import annotations

from . import paths

TOKEN = "{repo}"


def _repo_uri() -> str:
    return paths.project_root().as_uri()


def _repo_path_forms() -> list[str]:
    root = paths.project_root()
    return [str(root), root.as_posix()]


def to_portable(text):
    """Absolute -> portable. Applied to anything captured from a real run before it is persisted."""
    if not isinstance(text, str):
        return text
    text = text.replace(_repo_uri(), f"file://{TOKEN}")
    for form in _repo_path_forms():
        text = text.replace(form, TOKEN)
    return text


def to_absolute(text):
    """Portable -> absolute, resolved against THIS machine's own repo root. Applied right before a
    portable string is used for something real."""
    if not isinstance(text, str):
        return text
    text = text.replace(f"file://{TOKEN}", _repo_uri())
    return text.replace(TOKEN, str(paths.project_root()))


def _walk(obj, fn):
    if isinstance(obj, str):
        return fn(obj)
    if isinstance(obj, list):
        return [_walk(v, fn) for v in obj]
    if isinstance(obj, dict):
        return {k: _walk(v, fn) for k, v in obj.items()}
    return obj


def portable_value(obj):
    return _walk(obj, to_portable)


def absolute_value(obj):
    return _walk(obj, to_absolute)


def portable_trace(trace: list) -> None:
    """Mutates `trace` in place -- same shape as redact.redact_trace, and meant to run right after it
    (redact first, then make paths portable; order does not matter for correctness, only for which pass
    recomputes the final hash). Recomputes output_sha256 for the same reason redact_trace does: the hash
    must describe what was actually written."""
    from ._spike.agent import sha256

    for event in trace:
        event["input"] = portable_value(event["input"])
        event["output"] = portable_value(event["output"])
        event["output_sha256"] = sha256(event["output"])


def absolute_events(events: list) -> list:
    """A NEW list of events (does not mutate `events`) with every string leaf expanded to this machine's
    real repo root -- widens a portable reference recording back into something GateToolTap can
    exact-match against a live call's real (absolute) tool_use arguments."""
    out = []
    for e in events:
        e2 = dict(e)
        e2["input"] = absolute_value(e["input"])
        e2["output"] = absolute_value(e["output"])
        out.append(e2)
    return out
