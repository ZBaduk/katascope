"""The exported head weights must reproduce the model's own head output.

This is the correctness oracle for the "reduce" feature, and it is the same
kind of claim as the feature-encoding golden test: a re-implemented head that is
subtly wrong produces entirely plausible policies and ownership maps, and
nothing downstream can tell. A reduced output is only interesting relative to
the full one, so if the full one is wrong the whole feature is decoration.

What is checked: take a real position, read the **last block's** trunk frame,
run the exported weights over it with `support.head_reference`, and compare
against what the model itself said for the same position.

Needs the model but **not** KataGo -- the comparison is against the model's own
output, not against the C++ engine.
"""

from __future__ import annotations

import numpy as np
import pytest

from support.head_reference import policy_softmax, run_heads
from support.positions import POSITIONS

# Measured, not guessed. Across the seven fixture positions the worst
# disagreement is 3.3e-7 on policy and 3.7e-7 on ownership -- float32 rounding,
# since the weights and the frame are stored in float32 and re-run in float64.
# 1e-4 is headroom for a different net or a different device, not for a known
# discrepancy. Re-measure with `tools/measure_head_agreement.py` after any
# change to the export or the reference implementation.
HEAD_ATOL = 1e-4


@pytest.fixture(scope="module")
def head_weights(extractor):
    return extractor.head_weights()


def _last_block_frame(extractor, wire):
    """The trunk tensor the heads read, before the final norm."""
    return np.asarray(extractor.frame(wire, extractor.spec.blocks - 1), dtype=np.float64)


def test_exported_weights_cover_both_heads(head_weights) -> None:
    """A missing tensor would otherwise surface as a plausible wrong number."""
    required = {
        "trunkfinal.beta",
        "policy.conv1p",
        "policy.conv1g",
        "policy.biasg",
        "policy.linear_g",
        "policy.linear_pass",
        "policy.bias2",
        "policy.conv2p",
        "value.conv1",
        "value.bias1",
        "value.conv_ownership",
    }
    assert required <= set(head_weights.tensors)
    for name, flat in head_weights.tensors.items():
        shape = head_weights.shapes[name]
        assert flat.size == int(np.prod(shape)), f"{name}: {flat.size} != {shape}"


def test_trunk_final_scale_is_not_the_default(head_weights, extractor) -> None:
    """The scale lives on the module, not in the checkpoint.

    `initialize()` sets it to ``1/sqrt(blocks + 1)`` for the ``fixscale*`` norm
    kinds and runs before the state dict loads, so it is part of the network as
    evaluated while appearing in no saved tensor. Exporting a default 1.0 would
    scale the entire head input by about 4.4 and still produce a tidy-looking
    policy, which is exactly the failure this catches.
    """
    expected = 1.0 / np.sqrt(extractor.spec.blocks + 1.0)
    assert head_weights.trunk_final_scale == pytest.approx(expected, rel=1e-6)


@pytest.mark.parametrize("position", POSITIONS, ids=[p.name for p in POSITIONS])
def test_exported_head_reproduces_the_model(extractor, head_weights, position) -> None:
    wire = position.to_wire()
    trunk = _last_block_frame(extractor, wire)
    reference = extractor.raw_heads(wire)

    x_size, y_size = position.board_x_size, position.board_y_size
    _, logits, pass_logit, ownership = run_heads(head_weights, trunk, x_size, y_size)

    # The model reports policy as a softmax over the whole extent plus the pass,
    # so the comparison has to be made after the same softmax: the logits
    # themselves are only defined up to an additive constant.
    probs = policy_softmax(logits, pass_logit)
    grid = probs[:-1].reshape(head_weights.pos_len, head_weights.pos_len)
    cropped = np.concatenate([grid[:y_size, :x_size].reshape(-1), probs[-1:]])

    assert cropped.shape == reference.policy.shape
    np.testing.assert_allclose(cropped, reference.policy, atol=HEAD_ATOL)

    own = ownership[:y_size, :x_size].reshape(-1)
    assert own.shape == reference.ownership.shape
    np.testing.assert_allclose(own, reference.ownership, atol=HEAD_ATOL)


def test_zeroing_every_channel_still_produces_a_valid_distribution(
    extractor, head_weights
) -> None:
    """The degenerate reduction must not produce NaN.

    "Only these" with nothing selected zeroes the entire head input, which is a
    state the UI can reach in one click. The pooled branch then sees a constant
    plane and the softmax sees constant logits; both are well defined, and a
    NaN here would paint the overlay blank with no explanation.
    """
    position = POSITIONS[0]
    wire = position.to_wire()
    trunk = _last_block_frame(extractor, wire)
    zeroed = np.zeros_like(trunk)

    _, logits, pass_logit, ownership = run_heads(
        head_weights, zeroed, position.board_x_size, position.board_y_size
    )
    probs = policy_softmax(logits, pass_logit)
    assert np.isfinite(probs).all()
    assert probs.sum() == pytest.approx(1.0, abs=1e-6)
    assert np.isfinite(ownership).all()


def test_reduction_changes_the_output(extractor, head_weights) -> None:
    """A reduction that changed nothing would mean the mask never applied.

    Cheap, and it catches the whole class of "the selection is not wired up":
    if zeroing half the trunk channels leaves the policy identical, the feature
    is reporting the full head twice.
    """
    position = POSITIONS[0]
    wire = position.to_wire()
    trunk = _last_block_frame(extractor, wire)

    _, full_logits, full_pass, full_own = run_heads(
        head_weights, trunk, position.board_x_size, position.board_y_size
    )

    reduced_trunk = trunk.copy()
    reduced_trunk[1::2] = 0.0
    _, half_logits, half_pass, half_own = run_heads(
        head_weights, reduced_trunk, position.board_x_size, position.board_y_size
    )

    assert not np.allclose(full_logits, half_logits, atol=1e-6)
    assert not np.allclose(full_own, half_own, atol=1e-6)
    # The pass comes from the pooled branch alone, so a reduction that only
    # touched the spatial path would move the board logits and leave this
    # identical -- which is the specific wiring mistake worth catching.
    assert half_pass != pytest.approx(full_pass, abs=1e-6)
