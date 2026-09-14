"""The correctness oracle: our model's heads against KataGo's own.

This is the test that decides whether anything else in katascope means
anything. Activations are only interesting if the position that produced them
was encoded the way KataGo encodes it. A transposed board, an off-by-one in the
history planes, the wrong side to move, a flipped ownership sign -- each
produces activations that look entirely plausible and are entirely wrong.

**The two implementations agree to float32 rounding.** One tolerance, 1e-4,
for every position; measured agreement is under 1e-6. Anything looser would
stop being a test of the encoding and start being a test of nothing.

Getting there took four engine settings and three encoding fixes, all recorded
in `tests/README.md`. The one that mattered most is `ignorePreRootHistory`,
which the analysis engine defaults to **true**: it sets `maxHistory = 0` for the
root evaluation, so the engine was reporting policy and ownership computed with
no move history at all, however many moves the query supplied. Comparing that
against a forward pass that *does* encode history produced a disagreement that
looked like an unfixable property of KataGo's two feature implementations. It
was a config default.

Reference values come from `katago analysis` at `maxVisits: 1` under
`configs/analysis-deterministic.cfg`. Skips when KataGo is not configured, and
while the service has no checkpoint.
"""

from __future__ import annotations

import numpy as np
import pytest

from support.katago_raw import policy_to_grid
from support.positions import POSITIONS

pytestmark = [pytest.mark.katago, pytest.mark.golden, pytest.mark.slow]

# ---------------------------------------------------------------------------
# One tolerance, measured rather than guessed. `measure_agreement.py` prints the
# real numbers; every position in the tight set currently reports 0.0000000.
# 1e-4 is headroom for a different net or backend, not for a known disagreement.
# Re-measure after any change to the feature path or the engine config.
# ---------------------------------------------------------------------------
POLICY_ATOL = 1e-4
OWNERSHIP_ATOL = 1e-4

# KataGo deliberately hides move history when a pass by the side to move would
# end the game -- `maxTurnsOfHistoryToInclude = 0` in NNInputs -- and KataGo's
# own Python Features has no equivalent. It is a narrow, intentional behaviour,
# so those positions are excluded here and asserted separately below.
TIGHT_POSITIONS = [p for p in POSITIONS if p.name != "pass-would-end-game"]
PASS_END_POSITION = next(p for p in POSITIONS if p.name == "pass-would-end-game")


def _reference(net, position):
    return net.query(
        board_x_size=position.board_x_size,
        board_y_size=position.board_y_size,
        moves=[list(m) for m in position.moves],
        initial_stones=[list(s) for s in position.initial_stones],
        rules=position.rules,
        komi=position.komi,
        initial_player=position.initial_player,
    )


def _both(position, extractor, raw_net):
    return _reference(raw_net, position), extractor.raw_heads(position.to_wire())


@pytest.mark.parametrize("position", TIGHT_POSITIONS, ids=lambda p: p.name)
def test_policy_matches_katago(position, extractor, raw_net) -> None:
    reference, ours = _both(position, extractor, raw_net)

    assert np.asarray(ours.policy).shape == (position.area + 1,), (
        "policy must be board area + 1 long, with pass last"
    )
    legal = reference.policy >= 0
    np.testing.assert_allclose(
        np.asarray(ours.policy)[legal],
        reference.policy[legal],
        atol=POLICY_ATOL,
        err_msg=f"policy mismatch on {position.name}: {position.why}",
    )


@pytest.mark.parametrize("position", TIGHT_POSITIONS, ids=lambda p: p.name)
def test_ownership_matches_katago(position, extractor, raw_net) -> None:
    reference, ours = _both(position, extractor, raw_net)

    assert np.asarray(ours.ownership).shape == (position.area,), (
        "ownership must be board area long, row-major"
    )
    np.testing.assert_allclose(
        np.asarray(ours.ownership),
        reference.ownership,
        atol=OWNERSHIP_ATOL,
        err_msg=f"ownership mismatch on {position.name}: {position.why}",
    )


@pytest.mark.parametrize("position", TIGHT_POSITIONS, ids=lambda p: p.name)
def test_policy_agrees_on_the_best_move(position, extractor, raw_net) -> None:
    """A check that survives every tolerance argument.

    However the distributions differ, the top move must be the same point. If it
    is not, the two are not looking at the same position.
    """
    reference, ours = _both(position, extractor, raw_net)
    assert int(np.argmax(np.asarray(ours.policy))) == int(np.argmax(reference.policy))


@pytest.mark.parametrize("position", TIGHT_POSITIONS, ids=lambda p: p.name)
def test_illegal_moves_have_no_policy_mass(position, extractor, raw_net) -> None:
    """Occupied and off-board points must be illegal on both sides, at the same
    coordinates.

    This is the orientation check: a transposed board keeps the same *set* of
    illegal points but moves them, which only an asymmetric position reveals.

    KataGo reports illegal moves as `-1`. The network does not hard-mask them --
    it leaves around 1e-8 of probability there -- so the assertion is that our
    mass is negligible, not that it is exactly zero.
    """
    reference, ours = _both(position, extractor, raw_net)
    illegal = reference.policy < 0
    # An empty board has no illegal points; the mask equality below still runs.
    if illegal.any():
        ours_at_illegal = np.asarray(ours.policy)[illegal]
        assert np.all(ours_at_illegal < 1e-6), (
            f"policy mass at illegal points on {position.name}: max {ours_at_illegal.max():.3e}"
        )

    reference_grid = policy_to_grid(reference.policy, position.board_x_size, position.board_y_size)
    ours_grid = policy_to_grid(np.asarray(ours.policy), position.board_x_size, position.board_y_size)
    np.testing.assert_array_equal(
        ours_grid < 1e-6,
        reference_grid < 0,
        err_msg=f"legality mask differs on {position.name}: {position.why}",
    )


@pytest.mark.parametrize("position", TIGHT_POSITIONS, ids=lambda p: p.name)
def test_ownership_sign_convention_matches(position, extractor, raw_net) -> None:
    """Catches a flipped ownership sign, which a tolerance check can miss.

    The handicap fixture failed here at correlation -0.90 while the side to move
    was being inferred rather than sent. Both ends now state it explicitly.
    """
    reference, ours = _both(position, extractor, raw_net)
    theirs = reference.ownership
    mine = np.asarray(ours.ownership)

    if theirs.std() < 1e-6 or mine.std() < 1e-6:
        pytest.skip("ownership is flat on this position; sign is unobservable")
    assert float(np.corrcoef(mine, theirs)[0, 1]) > 0.99


def test_value_head_matches_katago(extractor, raw_net) -> None:
    """The value head, which the spatial heads would not catch on their own."""
    position = next(p for p in TIGHT_POSITIONS if p.moves)
    reference, ours = _both(position, extractor, raw_net)
    # KataGo's winrate counts a no-result as half a win.
    ours_winrate = float(ours.value[0]) + 0.5 * float(ours.value[2])
    assert ours_winrate == pytest.approx(reference.winrate, abs=1e-4)


# ---------------------------------------------------------------------------
# The one known, deliberate divergence.
# ---------------------------------------------------------------------------


def test_katago_hides_history_when_a_pass_would_end_the_game(extractor, raw_net) -> None:
    """Documents a narrow, intentional KataGo behaviour rather than tolerating it.

    When `hist.passWouldEndGame(...)` holds, `NNInputs` sets
    `maxTurnsOfHistoryToInclude = 0` and suppresses the `passWouldEndPhase`
    global, so the engine evaluates the position with no history planes. KataGo's
    own Python `Features` has no equivalent, so the two disagree -- by about 1.8e-2
    on policy for this fixture.

    The disagreement is neither a katascope bug nor something a config can turn
    off: it survives `enablePassingHacks = false`, `conservativePass = false`,
    and a change of ruleset. Passes themselves encode correctly -- `with-passes`
    holds a pass in its history and agrees exactly.

    Asserted rather than ignored, and bounded: if it ever grows, or disappears
    because upstream aligned the two encoders, this test says so.
    """
    reference, ours = _both(PASS_END_POSITION, extractor, raw_net)
    legal = reference.policy >= 0
    difference = float(np.abs(reference.policy[legal] - np.asarray(ours.policy)[legal]).max())

    assert difference > POLICY_ATOL, (
        "the pass-would-end-game divergence has gone away -- if upstream aligned "
        "the C++ and Python encoders, move this position back into TIGHT_POSITIONS"
    )
    assert difference < 0.05, f"divergence grew to {difference:.4f}; something else has changed"

    # Even here the top move and the legality mask must still agree: the engine
    # sees the same board, only a shorter history.
    assert int(np.argmax(np.asarray(ours.policy))) == int(np.argmax(reference.policy))
