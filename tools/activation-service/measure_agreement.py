"""Measures the C++ engine vs PyTorch disagreement across every fixture position.

The golden test's tolerances are set from this, not guessed. Re-run it after any
change to the feature path, the vendored KataGo code, or the engine config, and
update ``POLICY_ATOL`` / ``OWNERSHIP_ATOL`` in ``tests/test_golden.py`` to match
what it reports.

    cd tools/activation-service && .venv/bin/python measure_agreement.py

Needs a configured katago, model and checkpoint -- the same
``katascope.config.local.json`` everything else reads.
"""
import sys, os, json
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE); sys.path.insert(0, os.path.join(HERE, 'tests'))
import numpy as np
from support.positions import POSITIONS
from support.katago_raw import KatagoRawNet
from activation_service.model import load_model

KNOWN_DIVERGENT = 'pass-would-end-game'

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
CFG = json.load(open(os.path.join(ROOT, 'katascope.config.local.json')))
ext = load_model(CFG['checkpointPath'])
rows = []
with KatagoRawNet(CFG['katagoPath'], CFG['modelPath'], os.path.join(ROOT, CFG['katagoConfigPath'])) as net:
    for p in POSITIONS:
        ref = net.query(board_x_size=p.board_x_size, board_y_size=p.board_y_size,
                        moves=[list(m) for m in p.moves],
                        initial_stones=[list(s) for s in p.initial_stones],
                        rules=p.rules, komi=p.komi, initial_player=p.initial_player)
        ours = ext.raw_heads(p.to_wire())
        legal = ref.policy >= 0
        pd = float(np.abs(ref.policy[legal] - ours.policy[legal]).max())
        od = float(np.abs(ref.ownership - ours.ownership).max())
        oc = float(np.corrcoef(ref.ownership, ours.ownership)[0,1])
        am = (int(np.argmax(ref.policy)) == int(np.argmax(ours.policy)))
        mask_ok = bool(np.all(ours.policy[ref.policy < 0] < 1e-6))
        rows.append((p.name, pd, od, oc, am, mask_ok))
        note = "  <- known: KataGo hides history here" if p.name == KNOWN_DIVERGENT else ""
        print(f"{p.name:28s} policy {pd:.7f}  own {od:.7f}  corr {oc:.5f}  argmax {am}  mask {mask_ok}{note}")

tight = [r for r in rows if r[0] != KNOWN_DIVERGENT]
print()
print("Tight set (everything the golden test asserts at 1e-4):")
print(f"  MAX policy diff   : {max(r[1] for r in tight):.7f}")
print(f"  MAX ownership diff: {max(r[2] for r in tight):.7f}")
print(f"  MIN ownership corr: {min(r[3] for r in tight):.6f}")
print(f"  argmax all agree  : {all(r[4] for r in tight)}")
print(f"  mask all agree    : {all(r[5] for r in tight)}")
