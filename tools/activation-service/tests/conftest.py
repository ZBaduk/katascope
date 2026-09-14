"""Shared fixtures and the skip policy for the activation-service tests.

Two independent things can be missing, and they skip for different reasons:

* **KataGo** -- binary, model and analysis config, read from the same
  ``katascope.config.json`` the app uses. Absent almost everywhere, including
  CI. Tests marked ``katago`` skip.
* **The service itself** -- ``activation_service`` is a scaffold. Tests that
  need a loaded model skip on ``activation_service.IMPLEMENTED``.

Skipping, not failing. A red suite on a laptop that was never going to have a
GPU teaches people to ignore red.
"""

from __future__ import annotations

import json
import os
import shutil
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import pytest

REPO_ROOT = Path(__file__).resolve().parents[3]
CONFIG_NAMES = ("katascope.config.local.json", "katascope.config.json")


@dataclass(frozen=True)
class KatagoPaths:
    """Everything needed to run a live ``katago analysis`` process."""

    katago: str
    model: str
    config: str


def _config_directory() -> Path:
    override = os.environ.get("KATASCOPE_CONFIG_DIR", "")
    return Path(override).resolve() if override else REPO_ROOT


def _load_config() -> dict[str, Any]:
    directory = _config_directory()
    for name in CONFIG_NAMES:
        path = directory / name
        try:
            loaded = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        if isinstance(loaded, dict):
            return loaded
    return {}


def _absolutise_command(value: str) -> str:
    """Mirrors ``resolvePaths`` for commands: a bare name stays a PATH lookup."""
    if not value or os.path.isabs(value):
        return value
    if "/" not in value and "\\" not in value:
        return value
    return str(_config_directory() / value)


def _absolutise_file(value: str) -> str:
    """Mirrors ``resolvePaths`` for files: always relative to the config directory."""
    if not value or os.path.isabs(value):
        return value
    return str(_config_directory() / value)


def _detect_checkpoint() -> tuple[str | None, str]:
    """The torch checkpoint alone. Enough for shape tests; no binary required.

    This is `checkpointPath`, not `modelPath`: KataGo's Python code loads
    training checkpoints, while the C++ engine loads the `.bin.gz`. They are
    different files describing the same network.
    """
    ckpt = _absolutise_file(str(_load_config().get("checkpointPath", "")))
    if ckpt and Path(ckpt).is_file():
        return ckpt, f"using {ckpt}"
    return None, f"not configured: checkpointPath ({ckpt or 'unset'})"


def _detect_katago() -> tuple[KatagoPaths | None, str]:
    """Binary, model and analysis config -- everything a live query needs."""
    config = _load_config()
    katago = _absolutise_command(str(config.get("katagoPath", "katago")))
    analysis_config = _absolutise_file(str(config.get("katagoConfigPath", "")))
    model = _absolutise_file(str(config.get("modelPath", "")))
    if not (model and Path(model).is_file()):
        model = None

    resolved = shutil.which(katago) if katago else None
    missing: list[str] = []
    if resolved is None:
        missing.append(f"katagoPath ({katago or 'unset'})")
    if model is None:
        missing.append(f"modelPath ({config.get('modelPath', '') or 'unset'})")
    if not analysis_config or not Path(analysis_config).is_file():
        missing.append(f"katagoConfigPath ({analysis_config or 'unset'})")

    if missing:
        return None, "not configured: " + ", ".join(missing)
    assert resolved is not None and model is not None
    return KatagoPaths(katago=resolved, model=model, config=analysis_config), f"using {resolved}"


CHECKPOINT_PATH, CHECKPOINT_REASON = _detect_checkpoint()
KATAGO_PATHS, KATAGO_REASON = _detect_katago()


def pytest_report_header(config: pytest.Config) -> list[str]:
    del config
    import activation_service

    return [
        f"katago: {KATAGO_REASON}",
        f"checkpoint: {CHECKPOINT_REASON}",
        f"activation_service.IMPLEMENTED: {activation_service.IMPLEMENTED}",
    ]


def pytest_collection_modifyitems(
    config: pytest.Config, items: list[pytest.Item]
) -> None:
    """Skips ``katago``-marked tests when no binary is configured."""
    del config
    if KATAGO_PATHS is not None:
        return
    skip = pytest.mark.skip(reason=f"needs a real katago -- {KATAGO_REASON}")
    for item in items:
        if "katago" in item.keywords:
            item.add_marker(skip)


@pytest.fixture(scope="session")
def checkpoint_path() -> str:
    """The torch checkpoint. Shape tests need this and nothing else."""
    if CHECKPOINT_PATH is None:
        pytest.skip(f"needs a checkpoint -- {CHECKPOINT_REASON}")
    return CHECKPOINT_PATH


@pytest.fixture(scope="session")
def katago_paths() -> KatagoPaths:
    if KATAGO_PATHS is None:
        pytest.skip(f"needs a real katago -- {KATAGO_REASON}")
    return KATAGO_PATHS


@pytest.fixture(scope="session")
def extractor(checkpoint_path: str):
    """A loaded model, or a skip while the service is still a scaffold.

    Depends on the model alone: reading a network's shape does not need a
    ``katago`` binary, and forcing one would hide shape regressions from anyone
    who has weights but no working engine build.
    """
    import activation_service

    if not activation_service.IMPLEMENTED:
        pytest.skip(
            "activation_service is a scaffold; flip IMPLEMENTED once load_model works"
        )
    from activation_service.model import load_model

    return load_model(checkpoint_path)


@pytest.fixture(scope="session")
def raw_net(katago_paths: KatagoPaths):
    """A live ``katago analysis`` process, reused across the golden positions."""
    from support.katago_raw import KatagoRawNet

    with KatagoRawNet(
        katago_path=katago_paths.katago,
        model_path=katago_paths.model,
        config_path=katago_paths.config,
    ) as net:
        yield net
