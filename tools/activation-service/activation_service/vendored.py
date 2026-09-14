"""Single import point for the vendored KataGo training code.

The copy lives in ``tools/activation-service/vendor/katago`` -- see
``vendor/README.md`` for what it is and why it is vendored rather than
installed. Everything else in this package imports KataGo through here, so the
``sys.path`` manipulation happens once and the vendor path is easy to find.
"""

from __future__ import annotations

import sys
from pathlib import Path

VENDOR_ROOT = Path(__file__).resolve().parents[1] / "vendor"

if str(VENDOR_ROOT) not in sys.path:
    sys.path.insert(0, str(VENDOR_ROOT))

from katago.game.board import Board  # noqa: E402
from katago.game.features import Features  # noqa: E402
from katago.game.gamestate import GameState  # noqa: E402
from katago.train.load_model import load_model as katago_load_model  # noqa: E402
from katago.train.model_pytorch import ExtraOutputs  # noqa: E402

__all__ = ["Board", "Features", "GameState", "ExtraOutputs", "katago_load_model", "VENDOR_ROOT"]
