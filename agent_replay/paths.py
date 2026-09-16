"""Where things live.

Phase 1 (package refactor): spike/ moved INTO the package as agent_replay/_spike/ -- the sys.path
insertion this module used to do (ensure_spike_importable) is gone. Every former `from agent import ...` /
`from gate import ...` / `from storage import ...` inside agent_replay/*.py is now a proper
`from ._spike.agent import ...`-style package import, and agent_replay/_spike/*.py's own former
sibling-relative imports are now `from .agent import ...` etc. -- ordinary intra-package imports, resolved
by the normal Python import system, needing no sys.path manipulation at all. This is what makes
`pip install git+https://...` (a non-editable install, agent_replay living under site-packages/) work:
the old scheme's SPIKE_DIR/REPO_ROOT assumed this package's parent directory WAS a checkout of this repo,
which a git-URL install does not guarantee.
"""

from __future__ import annotations

import importlib
import os
from pathlib import Path

PACKAGE_DIR = Path(__file__).resolve().parent

# Phase 0 fix (docs/DECISIONS.md): plain cwd-based resolution meant the SAME project could resolve to
# different traces/scenarios/contracts depending on which directory `agent-replay` happened to be run
# from -- a scratch dir, a subdirectory, CI -- with no error, no warning, nothing to notice it by. Set
# once at CLI startup (cli.py's main(), from --project-root) and checked before any search happens at
# all; None (the default) means "no override, do the marker search below."
_override: Path | None = None


def set_project_root_override(path: Path | None) -> None:
    global _override
    _override = path.resolve() if path is not None else None


_MARKERS = ("agent-replay/scenarios.yaml", "pyproject.toml", ".git")


def find_project_root(start: Path | None = None) -> Path:
    """Upward marker search from `start` (default cwd) -- the same idea as pytest finding rootdir or npm
    finding package.json: walk up looking for, in order, agent-replay/scenarios.yaml, pyproject.toml, or
    .git; the first directory containing any of them wins, so running `agent-replay` from the project
    root, a subdirectory, or anywhere else inside the same tree all resolve to the SAME answer. Falls back
    to `start` itself if nothing is found anywhere above it (a brand-new project with none of the three
    yet -- exactly what `agent-replay init` is for)."""
    cur = (start or Path.cwd()).resolve()
    for candidate in (cur, *cur.parents):
        if any((candidate / marker).exists() for marker in _MARKERS):
            return candidate
    return cur


def project_root() -> Path:
    """Wherever the project being tested actually lives -- not wherever agent-replay itself is installed,
    and not necessarily the CURRENT directory either. Resolution order: an explicit --project-root
    (cli.py's main() calls set_project_root_override before dispatching to any subcommand) or
    AGENT_REPLAY_ROOT env var wins outright, for the cases the marker search below gets wrong (a monorepo,
    an unusual CI checkout layout); otherwise find_project_root()'s upward marker search from cwd. Backs
    the `{repo}` portable-path token (agent_replay/portable.py), data_dir() below, and
    agent_replay/_spike/storage.py's traces directory -- all of which used to be bare Path.cwd(), correct
    only when the user happened to invoke agent-replay from exactly the project root itself."""
    if _override is not None:
        return _override
    env = os.environ.get("AGENT_REPLAY_ROOT")
    if env:
        return Path(env).resolve()
    return find_project_root()


def import_agent_module(name: str):
    """Resolve a scenario's `agent:` field to an actual Python module.

    A bare name with no ':' (e.g. "audit_agent") is agent-replay's OWN bundled example agent, shipped
    inside the package at agent_replay/_spike/<name>.py -- these are the only bare-name agents this repo's
    own scenarios.yaml has ever used, and disambiguation is exactly this: no colon means "one of
    agent-replay's own examples." Tried first as a normal top-level import (respecting whatever an
    adopter's own project already has importable, e.g. a same-named module of their own sitting on
    sys.path) so a real external module is never shadowed by one of our examples; only on ImportError does
    this fall back to the bundled agent_replay._spike.<name>.

    A name containing ':' is not handled here -- that is Phase 2's module:callable form
    (module_path:factory_name), which resolves to a BUILT Agent object (via importing the module and
    calling the factory), not a module, so it needs its own function rather than overloading this one's
    return type.
    """
    try:
        return importlib.import_module(name)
    except ImportError:
        return importlib.import_module(f"agent_replay._spike.{name}")


def data_dir(root: Path | None = None) -> Path:
    """The project-local data directory `agent-replay/` -- resolved from the PROJECT ROOT (see
    project_root()'s docstring), not blindly from the current directory, so this is the same path
    regardless of which subdirectory of the project `agent-replay` was actually invoked from."""
    return (root or project_root()) / "agent-replay"


def scenarios_path(root: Path | None = None) -> Path:
    return data_dir(root) / "scenarios.yaml"


def contracts_dir(root: Path | None = None) -> Path:
    return data_dir(root) / "contracts"


def contract_path(scenario_name: str, root: Path | None = None) -> Path:
    return contracts_dir(root) / f"{scenario_name}.yaml"


def traces_dir(root: Path | None = None) -> Path:
    """Phase 0 fix (docs/DECISIONS.md): traces now live at agent-replay/traces/, next to the contracts
    they back -- a golden recording and its derived contract are one artifact, not two siblings that
    happen to share a project. Replaces the old top-level traces/ (agent_replay/_spike/storage.py's
    former module-level TRACES_DIR constant, which was also frozen at import time on top of being
    cwd-based -- doubly wrong)."""
    return data_dir(root) / "traces"


def reference_run_id(scenario_name: str, index: int) -> str:
    """Run id for the i-th (1-indexed) reference recording of a scenario -- local: traces/<id>.json,
    aws: DynamoDB partition key. Deterministic from (scenario, index, contract.n_runs) alone, so no
    separate index of "which runs back this contract" needs to be kept anywhere."""
    return f"{scenario_name}--{index}"
