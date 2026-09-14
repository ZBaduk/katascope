"""Measures the numpy head reference against the model's own head output.

``test_head_golden.py`` takes its tolerance from this, not from a guess. Re-run
it after any change to the head export or to ``support/head_reference.py``.

    cd tools/activation-service && .venv/bin/python tools/measure_head_agreement.py

Needs a configured checkpoint -- ``checkpointPath`` in the same
``katascope.config.local.json`` everything else reads.
"""
import json
import sys
from pathlib import Path

SERVICE = Path(__file__).resolve().parents[1]
ROOT = SERVICE.parents[1]
for entry in (SERVICE, SERVICE / 'vendor', SERVICE / 'tests'):
    sys.path.insert(0, str(entry))

import numpy as np
from activation_service.model import ActivationExtractor
from support.positions import POSITIONS
from support.head_reference import run_heads, policy_softmax

ck = json.loads((ROOT / 'katascope.config.local.json').read_text())['checkpointPath']
ex = ActivationExtractor(ck, device="cpu")
hw = ex.head_weights()
worst_p = worst_o = 0.0
for p in POSITIONS:
    wire = p.to_wire()
    trunk = np.asarray(ex.frame(wire, ex.spec.blocks-1), dtype=np.float64)
    ref = ex.raw_heads(wire)
    _, logits, passl, own = run_heads(hw, trunk, p.board_x_size, p.board_y_size)
    probs = policy_softmax(logits, passl)
    grid = probs[:-1].reshape(hw.pos_len, hw.pos_len)
    cropped = np.concatenate([grid[:p.board_y_size,:p.board_x_size].reshape(-1), probs[-1:]])
    dp = np.abs(cropped - ref.policy).max()
    do = np.abs(own[:p.board_y_size,:p.board_x_size].reshape(-1) - ref.ownership).max()
    worst_p = max(worst_p, dp); worst_o = max(worst_o, do)
    print(f"{p.name:26} policy {dp:.3e}  ownership {do:.3e}")
print(f"\nWORST policy {worst_p:.3e}   ownership {worst_o:.3e}")
