"""The network shape the model reports must match the frames it emits.

Cheaper than the golden test and catches a different class of bug: a frame that
is the right numbers in the wrong arrangement. The TypeScript side slices
channels by arithmetic (``data[c * area : (c + 1) * area]``), so a layout
disagreement shows up as a heatmap of the wrong channel rather than an error.

Needs the model but **not** KataGo, so it runs as soon as the service is real.
"""

from __future__ import annotations

import numpy as np
import pytest

from support.positions import POSITIONS


@pytest.fixture(scope="module")
def spec(extractor):
    return extractor.spec


def test_spec_is_self_consistent(spec) -> None:
    assert spec.blocks > 0
    assert spec.channels > 0
    assert spec.board_x_size > 0
    assert spec.board_y_size > 0
    assert spec.plane_area == spec.board_x_size * spec.board_y_size
    assert spec.frame_size == spec.channels * spec.plane_area


def test_spec_name_looks_like_the_model(spec) -> None:
    """A b6c96 net should say so; a name of 'unknown' means it was not read."""
    assert spec.name
    assert spec.name != "unknown"


def test_every_block_is_addressable(extractor, spec) -> None:
    wire = POSITIONS[0].to_wire()
    for block in range(spec.blocks):
        frame = extractor.frame(wire, block)
        assert frame is not None, f"block {block} produced nothing"


def test_block_count_comes_from_the_model(extractor, spec) -> None:
    """The trunk depth must be read from the checkpoint, never assumed.

    katascope targets b6c96 first but must not hardcode it; the reference net
    in development is b18c384nbt. If this ever equals a constant someone typed,
    the whole tool silently mis-addresses blocks on every other network.
    """
    names = extractor.available_extra_outputs(POSITIONS[0].to_wire())
    reported = [n for n in names if n.startswith("trunk_after_block")]
    assert len(reported) == spec.blocks, (
        f"model reports {len(reported)} trunk blocks but spec says {spec.blocks}"
    )


def test_frame_shape_matches_the_spec(extractor, spec) -> None:
    frame = extractor.frame(POSITIONS[0].to_wire(), 0)

    assert frame.dtype == np.float32, "the wire format is float32"
    assert frame.shape == (spec.channels, spec.board_y_size, spec.board_x_size), (
        "frames are (channels, height, width) so a C-order flatten gives the "
        "channel-major, row-major layout the TypeScript side slices by hand"
    )
    assert frame.size == spec.frame_size


def test_frame_flattens_to_the_wire_layout(extractor, spec) -> None:
    """Channel ``c`` must occupy ``[c * area, (c + 1) * area)`` once flattened."""
    frame = extractor.frame(POSITIONS[0].to_wire(), 0)
    flat = frame.reshape(-1)

    assert flat.size == spec.frame_size
    for channel in range(min(spec.channels, 4)):
        start = channel * spec.plane_area
        np.testing.assert_array_equal(
            flat[start : start + spec.plane_area],
            frame[channel].reshape(-1),
        )


def test_frames_are_finite(extractor, spec) -> None:
    """NaNs would render as holes in a heatmap rather than as an error."""
    frame = extractor.frame(POSITIONS[0].to_wire(), spec.blocks - 1)
    assert np.all(np.isfinite(frame))


def test_out_of_range_block_is_rejected(extractor, spec) -> None:
    with pytest.raises((IndexError, ValueError)):
        extractor.frame(POSITIONS[0].to_wire(), spec.blocks)
    with pytest.raises((IndexError, ValueError)):
        extractor.frame(POSITIONS[0].to_wire(), -1)


@pytest.mark.parametrize("position", POSITIONS, ids=lambda p: p.name)
def test_frames_keep_the_network_extent_for_every_board_size(extractor, spec, position) -> None:
    """Frames are emitted at the *network's* extent, not the game's board size.

    A 9x9 position is evaluated in the top-left corner of the network's 19x19
    tensor, and the activations really do have the larger extent -- the
    off-board region holds real, masked values. `NetworkSpec.boardSize` is
    documented as "the spatial extent the activations were computed at" for
    exactly this reason, and the UI crops for display.
    """
    frame = extractor.frame(position.to_wire(), 0)
    assert frame.shape == (spec.channels, spec.board_y_size, spec.board_x_size)
