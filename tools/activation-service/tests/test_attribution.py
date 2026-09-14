"""Reader weights and attribution.

Shapes are checked against the **loaded model** rather than against constants,
for the same reason the frame tests are: katascope must work on whatever net it
is pointed at, and a hardcoded 384 would pass here and mis-address every channel
on anything else.

Needs a checkpoint; no `katago` binary.
"""

from __future__ import annotations

import numpy as np
import pytest

from support.positions import POSITIONS

WIRE = POSITIONS[1].to_wire()  # an asymmetric opening, so nothing is degenerate


@pytest.fixture(scope="module")
def spec(extractor):
    return extractor.spec


# ---------------------------------------------------------------------------
# reader_weights
# ---------------------------------------------------------------------------


def test_reader_weights_cover_every_block_but_the_last(extractor, spec) -> None:
    # Blocks 0..N-2 are read by the next block; the last is read by the heads.
    weights = extractor.reader_weights()
    assert len(weights.by_block) == spec.blocks - 1
    assert set(weights.heads) == {"policy", "value"}


def test_reader_weight_vectors_are_one_value_per_channel(extractor, spec) -> None:
    weights = extractor.reader_weights()
    for vector in weights.by_block:
        assert vector.shape == (spec.channels,)
    for vector in weights.heads.values():
        assert vector.shape == (spec.channels,)


def test_reader_weights_are_non_negative_and_finite(extractor) -> None:
    weights = extractor.reader_weights()
    for vector in [*weights.by_block, *weights.heads.values()]:
        assert np.all(np.isfinite(vector))
        assert np.all(vector >= 0)


def test_reader_weights_are_not_all_equal(extractor) -> None:
    """A constant vector would mean the measure carries no information."""
    first = extractor.reader_weights().by_block[0]
    assert first.std() > 0


def test_reader_weights_are_cached(extractor) -> None:
    # Static per network, so the second call must be the same object rather than
    # a second pass over every weight tensor.
    assert extractor.reader_weights() is extractor.reader_weights()


def test_the_two_heads_read_different_channels(extractor) -> None:
    """Policy and value do not simply share one notion of importance.

    If they did, the last block's per-head split would be noise and the UI
    should not offer it. Measured on kata1-b18c384nbt the correlation is 0.13.
    """
    weights = extractor.reader_weights()
    correlation = float(np.corrcoef(weights.heads["policy"], weights.heads["value"])[0, 1])
    assert correlation < 0.9


def test_reader_weights_are_float32(extractor) -> None:
    """The wire format is float32; anything wider would be silently truncated."""
    assert extractor.reader_weights().by_block[0].dtype == np.float32


# ---------------------------------------------------------------------------
# attribute
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "target",
    [
        {"kind": "ownership_total"},
        {"kind": "ownership_point", "x": 3, "y": 4},
        {"kind": "policy_move", "x": 15, "y": 3},
        {"kind": "policy_pass"},
        {"kind": "winrate"},
    ],
    ids=lambda t: t["kind"],
)
def test_attribution_shape_matches_the_model(extractor, spec, target) -> None:
    result = extractor.attribute(WIRE, target)
    assert result.by_block.shape == (spec.blocks, spec.channels)
    assert result.by_block.dtype == np.float32
    assert np.all(np.isfinite(result.by_block))
    # |activation * gradient| summed, so never negative.
    assert np.all(result.by_block >= 0)


def test_attribution_is_not_uniformly_zero(extractor) -> None:
    """A target the network genuinely depends on must attribute somewhere."""
    result = extractor.attribute(WIRE, {"kind": "ownership_total"})
    assert result.by_block.sum() > 0
    # And not concentrated in a single block, which would suggest the graph is
    # broken rather than that one block does all the work.
    per_block = result.by_block.sum(axis=1)
    assert (per_block > 0).sum() >= 2


@pytest.mark.parametrize(
    "target",
    [{"kind": "ownership_total"}, {"kind": "winrate"}, {"kind": "policy_move", "x": 3, "y": 3}],
    ids=lambda t: t["kind"],
)
def test_attribution_is_stable_across_two_runs(extractor, target) -> None:
    """The same request twice must give the same numbers.

    Nothing here samples and the model is in eval mode, so this is exact
    equality rather than a tolerance. If it ever stops being exact, something
    stateful has crept into the forward pass and every comparison the tab draws
    is suspect.
    """
    first = extractor.attribute(WIRE, target)
    second = extractor.attribute(WIRE, target)
    np.testing.assert_array_equal(first.by_block, second.by_block)


def test_different_targets_attribute_differently(extractor) -> None:
    """Otherwise the target selector would be decoration."""
    ownership = extractor.attribute(WIRE, {"kind": "ownership_total"}).by_block
    policy = extractor.attribute(WIRE, {"kind": "policy_move", "x": 15, "y": 3}).by_block
    assert not np.array_equal(ownership, policy)


def test_planes_are_returned_only_when_asked(extractor, spec) -> None:
    without = extractor.attribute(WIRE, {"kind": "winrate"})
    assert without.planes is None

    with_planes = extractor.attribute(WIRE, {"kind": "winrate"}, plane_block=2)
    assert with_planes.planes is not None
    assert with_planes.planes.shape == (spec.channels, 19, 19)
    assert with_planes.plane_block == 2


def test_planes_agree_with_the_per_channel_totals(extractor) -> None:
    """The totals are the planes summed, so they must reconcile.

    Catches a plane taken from a different block than the one reported -- which
    would look entirely plausible and be entirely wrong.
    """
    result = extractor.attribute(WIRE, {"kind": "ownership_total"}, plane_block=3)
    assert result.planes is not None
    from_planes = np.abs(result.planes).sum(axis=(1, 2))
    np.testing.assert_allclose(from_planes, result.by_block[3], rtol=1e-4, atol=1e-4)


def test_planes_are_signed_but_totals_are_not(extractor) -> None:
    """Totals use |a*g|; the planes keep the sign so direction is visible."""
    result = extractor.attribute(WIRE, {"kind": "ownership_total"}, plane_block=0)
    assert result.planes is not None
    assert result.planes.min() < 0


def test_rejects_an_out_of_range_plane_block(extractor, spec) -> None:
    with pytest.raises(IndexError):
        extractor.attribute(WIRE, {"kind": "winrate"}, plane_block=spec.blocks)


def test_rejects_an_unknown_target(extractor) -> None:
    with pytest.raises(ValueError, match="unknown attribution target"):
        extractor.attribute(WIRE, {"kind": "nonsense"})


def test_rejects_a_point_off_the_board(extractor) -> None:
    with pytest.raises(ValueError, match="off a"):
        extractor.attribute(WIRE, {"kind": "ownership_point", "x": 99, "y": 0})


def test_attribution_follows_the_position(extractor) -> None:
    """A different position must attribute differently, or the forward pass is
    not actually being redone."""
    other = POSITIONS[4].to_wire()  # the 9x9 fixture
    a = extractor.attribute(WIRE, {"kind": "winrate"}).by_block
    b = extractor.attribute(other, {"kind": "winrate"}).by_block
    assert not np.array_equal(a, b)
