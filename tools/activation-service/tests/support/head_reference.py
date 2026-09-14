"""KataGo's output heads, re-implemented in numpy from exported weights.

This mirrors `packages/core/src/heads/heads.ts` step for step, and exists for
two reasons:

* **It is the oracle.** ``test_head_golden`` runs it on a real block-17 frame
  and compares against the model's own head output. If it agrees, the exported
  weights are complete and correctly shaped, and the recipe below is the right
  recipe -- which is the only evidence the TypeScript version has that it is
  computing the right thing at all.
* **It generates the TypeScript fixture.** ``tools/make_head_fixture.py`` runs
  this on small synthetic weights and writes the expected output, so the core
  spec checks TypeScript against numbers that came from here rather than from
  itself.

Deliberately written plainly, one array operation per line of the model, rather
than fused or vectorised cleverly. It is a specification, not a fast path.
"""

from __future__ import annotations

from typing import Dict, Tuple

import numpy as np


def mish(x: np.ndarray) -> np.ndarray:
    """``x * tanh(softplus(x))``, through a stable softplus."""
    softplus = np.where(x > 20.0, x, np.log1p(np.exp(np.minimum(x, 20.0))))
    return x * np.tanh(softplus)


def activate(x: np.ndarray, activation: str) -> np.ndarray:
    if activation == "mish":
        return mish(x)
    if activation == "relu":
        return np.maximum(x, 0.0)
    if activation == "identity":
        return x
    raise ValueError(f"unsupported activation: {activation}")


def board_mask(pos_len: int, x_size: int, y_size: int) -> np.ndarray:
    """1 on the game board, 0 in the rest of the network's extent."""
    mask = np.zeros((pos_len, pos_len), dtype=np.float32)
    mask[:y_size, :x_size] = 1.0
    return mask


def conv1x1(x: np.ndarray, weight: np.ndarray) -> np.ndarray:
    """``(in, H, W)`` through ``(out, in)`` to ``(out, H, W)``."""
    c_in, h, w = x.shape
    assert weight.shape[1] == c_in, (weight.shape, x.shape)
    return (weight @ x.reshape(c_in, h * w)).reshape(weight.shape[0], h, w)


def kata_gpool(x: np.ndarray, mask: np.ndarray, mask_sum: float) -> np.ndarray:
    """Policy-head pooling: ``[mean, mean * s, max]``, concatenated."""
    offset = (np.sqrt(mask_sum) - 14.0) / 10.0
    mean = (x * mask).sum(axis=(1, 2)) / mask_sum
    # KataGo offsets off-board cells by -1 before the max; every activation it
    # uses exceeds -1, so masking them out entirely is the same thing.
    maximum = np.where(mask > 0, x, -np.inf).reshape(x.shape[0], -1).max(axis=1)
    return np.concatenate([mean, mean * offset, maximum])


def trunk_final(
    trunk: np.ndarray, scale: float, beta: np.ndarray, mask: np.ndarray, activation: str
) -> np.ndarray:
    """What both heads actually read: ``act((trunk * scale + beta) * mask)``."""
    biased = (trunk * scale + beta.reshape(-1, 1, 1)) * mask
    return activate(biased, activation)


def policy_head(
    head_input: np.ndarray,
    tensors: Dict[str, np.ndarray],
    mask: np.ndarray,
    mask_sum: float,
    activation: str,
) -> Tuple[np.ndarray, float]:
    """Returns ``(logits over the extent, pass logit)`` for policy output 0."""
    outp = conv1x1(head_input, tensors["policy.conv1p"])
    outg = conv1x1(head_input, tensors["policy.conv1g"])

    outg = (outg + tensors["policy.biasg"].reshape(-1, 1, 1)) * mask
    outg = activate(outg, activation)
    pooled = kata_gpool(outg, mask, mask_sum)

    pass_out = tensors["policy.linear_pass"] @ pooled
    if "policy.linear_pass2" in tensors:
        # Version >= 15: a hidden layer with an activation in between.
        pass_out = pass_out + tensors["policy.linear_pass.bias"]
        pass_out = activate(pass_out, activation)
        pass_out = tensors["policy.linear_pass2"] @ pass_out

    merged = tensors["policy.linear_g"] @ pooled
    outp = outp + merged.reshape(-1, 1, 1)
    outp = (outp + tensors["policy.bias2"].reshape(-1, 1, 1)) * mask
    outp = activate(outp, activation)

    logits = conv1x1(outp, tensors["policy.conv2p"])[0]
    logits = logits - (1.0 - mask) * 5000.0
    return logits, float(pass_out[0])


def ownership_head(
    head_input: np.ndarray,
    tensors: Dict[str, np.ndarray],
    mask: np.ndarray,
    activation: str,
) -> np.ndarray:
    """Ownership in [-1, 1] over the network's extent, masked off-board."""
    outv1 = conv1x1(head_input, tensors["value.conv1"])
    outv1 = (outv1 + tensors["value.bias1"].reshape(-1, 1, 1)) * mask
    outv1 = activate(outv1, activation)

    pretanh = conv1x1(outv1, tensors["value.conv_ownership"])[0]
    return np.tanh(pretanh) * mask


def unpack(head_weights) -> Dict[str, np.ndarray]:
    """Reshapes the flat exported tensors to the shapes the maths wants."""
    out: Dict[str, np.ndarray] = {}
    for name, flat in head_weights.tensors.items():
        shape = head_weights.shapes[name]
        out[name] = np.asarray(flat, dtype=np.float64).reshape(shape)
    return out


def run_heads(head_weights, trunk: np.ndarray, x_size: int, y_size: int):
    """Both heads from a trunk frame. ``trunk`` is ``(channels, pos_len, pos_len)``."""
    tensors = unpack(head_weights)
    pos_len = head_weights.pos_len
    mask = board_mask(pos_len, x_size, y_size).astype(np.float64)
    mask_sum = float(x_size * y_size)

    head_input = trunk_final(
        np.asarray(trunk, dtype=np.float64),
        head_weights.trunk_final_scale,
        tensors["trunkfinal.beta"],
        mask,
        head_weights.activation,
    )
    logits, pass_logit = policy_head(
        head_input, tensors, mask, mask_sum, head_weights.activation
    )
    ownership = ownership_head(head_input, tensors, mask, head_weights.activation)
    return head_input, logits, pass_logit, ownership


def policy_softmax(logits: np.ndarray, pass_logit: float) -> np.ndarray:
    """Softmax over the flattened extent plus the pass, as KataGo reports it."""
    flat = np.concatenate([logits.reshape(-1), [pass_logit]])
    shifted = flat - flat.max()
    exp = np.exp(shifted)
    return exp / exp.sum()
