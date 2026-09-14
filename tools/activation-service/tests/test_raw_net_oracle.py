"""Validates the oracle before anything is measured against it.

The golden test only means something if ``KatagoRawNet`` reads KataGo correctly.
These tests need a real binary but **not** the Python model, so they run as soon
as KataGo is configured -- well before the service exists.
"""

from __future__ import annotations

import numpy as np
import pytest

from support.katago_raw import policy_to_grid
from support.positions import POSITIONS

pytestmark = [pytest.mark.katago, pytest.mark.slow]


@pytest.mark.parametrize("position", POSITIONS, ids=lambda p: p.name)
def test_raw_net_returns_well_formed_heads(position, raw_net) -> None:
    result = raw_net.query(
        board_x_size=position.board_x_size,
        board_y_size=position.board_y_size,
        moves=position.moves,
        initial_stones=position.initial_stones,
        rules=position.rules,
        komi=position.komi,
    )

    assert result.policy.shape == (position.area + 1,)
    assert result.ownership.shape == (position.area,)

    # KataGo reports -1 for illegal moves; everything else is a probability.
    legal = result.policy[result.policy >= 0]
    assert legal.size > 0
    assert np.all(legal <= 1.0)
    # The legal entries are a distribution over legal moves plus pass.
    assert legal.sum() == pytest.approx(1.0, abs=1e-3)

    assert np.all(result.ownership >= -1.0)
    assert np.all(result.ownership <= 1.0)
    assert 0.0 <= result.winrate <= 1.0


def test_occupied_points_are_illegal_in_the_policy(raw_net) -> None:
    """A played stone's point must be marked illegal, which pins the orientation.

    If the board were transposed, the illegal point would show up at the
    mirrored coordinate and this would fail -- which is the single cheapest
    orientation check available.
    """
    position = next(p for p in POSITIONS if p.name == "opening-4-moves")
    result = raw_net.query(
        board_x_size=position.board_x_size,
        board_y_size=position.board_y_size,
        moves=position.moves,
        initial_stones=position.initial_stones,
        rules=position.rules,
        komi=position.komi,
    )
    grid = policy_to_grid(result.policy, position.board_x_size, position.board_y_size)

    # Q16 is x=15, y=3 in katascope's top-left-origin coordinates.
    assert grid[3, 15] == pytest.approx(-1.0)
    # D4 is x=3, y=15.
    assert grid[15, 3] == pytest.approx(-1.0)


def test_empty_board_policy_is_symmetric(raw_net) -> None:
    """The empty board is symmetric, so its policy must be too (within noise)."""
    position = next(p for p in POSITIONS if p.name == "empty-19x19")
    result = raw_net.query(
        board_x_size=position.board_x_size,
        board_y_size=position.board_y_size,
        moves=[],
        initial_stones=[],
        rules=position.rules,
        komi=position.komi,
    )
    grid = policy_to_grid(result.policy, position.board_x_size, position.board_y_size)

    # Real nets are not symmetric to numerical precision -- this one disagrees
    # with its own mirror by up to 1.7e-2 on the empty board. The check is for a
    # transposed board, which would move policy mass by whole orders of
    # magnitude, not for exact symmetry.
    np.testing.assert_allclose(grid, np.fliplr(grid), atol=5e-2)
    np.testing.assert_allclose(grid, grid.T, atol=5e-2)
