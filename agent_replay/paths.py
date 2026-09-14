"""Where things live. spike/ is NOT part of the installable package -- see the "Package layout" section of
the task report for why -- so this module's job is to make its unchanged, sibling-relative imports (e.g.
gate.py's `from agent import ...`) resolve after `pip install -e .`, exactly as they already resolve when
spike/*.py is run directly as a script.
"""

from __future__ import annotations

import sys
from pathlib import Path

PACKAGE_DIR = Path(__file__).resolve().parent
REPO_ROOT = PACKAGE_DIR.parent  # editable-install assumption: this package's parent dir is the repo checkout
SPIKE_DIR = REPO_ROOT / "spike"

_spike_on_path = False


def ensure_spike_importable() -> None:
    """Idempotent. Prepends spike/ to sys.path, the same effect Python gives a script's own directory when
    you run `python spike/gate.py` -- applied here for `import gate` instead of direct execution. spike/
    is never modified; every cross-import inside it (agent, audit_agent, gate, gate_compare, storage) keeps
    working completely unchanged.
    """
    global _spike_on_path
    if _spike_on_path:
        return
    if not SPIKE_DIR.is_dir():
        raise RuntimeError(
            f"spike/ not found at {SPIKE_DIR}. agent-replay must be installed editable (`pip install -e .`) "
            "from inside a checkout of the agent-replay repository -- it is not a standalone package."
        )
    sys.path.insert(0, str(SPIKE_DIR))
    _spike_on_path = True


def data_dir(cwd: Path | None = None) -> Path:
    """The project-local data directory `agent-replay/` -- resolved from the CURRENT directory, not the
    repo root, since a user runs these commands from wherever their own project lives."""
    return (cwd or Path.cwd()) / "agent-replay"


def scenarios_path(cwd: Path | None = None) -> Path:
    return data_dir(cwd) / "scenarios.yaml"


def contracts_dir(cwd: Path | None = None) -> Path:
    return data_dir(cwd) / "contracts"


def contract_path(scenario_name: str, cwd: Path | None = None) -> Path:
    return contracts_dir(cwd) / f"{scenario_name}.yaml"


def reference_run_id(scenario_name: str, index: int) -> str:
    """Run id for the i-th (1-indexed) reference recording of a scenario -- local: traces/<id>.json,
    aws: DynamoDB partition key. Deterministic from (scenario, index, contract.n_runs) alone, so no
    separate index of "which runs back this contract" needs to be kept anywhere."""
    return f"{scenario_name}--{index}"
