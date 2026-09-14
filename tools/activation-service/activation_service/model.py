"""Model loading and activation extraction.

Loads a KataGo training checkpoint with KataGo's own ``model_pytorch`` code and
runs positions through it. Using KataGo's code rather than a reimplementation is
the whole point: the input feature encoding is intricate (ladder detection, area
scoring, history planes, a dozen global features) and an independent version of
it would be subtly wrong in ways only the golden test could find -- and only
after someone had trusted the output for a while.

Activations come from KataGo's own instrumentation. ``model_pytorch`` already
reports ``trunk_after_block{i}`` through its ``ExtraOutputs`` mechanism, so
there are no forward hooks and no monkey-patching here; this module asks for
the tensors by name.

**Checkpoints, not ``.bin.gz``.** ``.bin.gz``/``.txt.gz`` is the serialisation
the C++ engine reads and KataGo's Python code cannot load it -- the conversion
only runs the other way, via ``export_model_pytorch.py``. A ``.ckpt`` comes from
the ``model_zip_file`` for a network on katagotraining.org. See the README.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Optional, Protocol

import numpy as np
import torch

from .vendored import ExtraOutputs, Features, GameState, katago_load_model


@dataclass(frozen=True)
class NetworkSpec:
    """Mirrors ``NetworkSpec`` in ``@katascope/core``.

    ``board_x_size``/``board_y_size`` are the network's **spatial extent**
    (``pos_len``), not the size of any particular game's board. A 9x9 position
    is evaluated in the top-left corner of a 19x19 tensor, and the activations
    genuinely have the larger extent.
    """

    name: str
    blocks: int
    channels: int
    board_x_size: int
    board_y_size: int

    @property
    def plane_area(self) -> int:
        return self.board_x_size * self.board_y_size

    @property
    def frame_size(self) -> int:
        return self.channels * self.plane_area


@dataclass(frozen=True)
class RawHeads:
    """The model's output heads for one position, before any search.

    Cropped to the *position's* board, so these line up with what the KataGo
    analysis engine reports and can be compared element for element.

    ``policy`` is ``x_size * y_size + 1`` long, row-major from the top-left,
    pass last. ``ownership`` is ``x_size * y_size``, row-major, in [-1, 1] from
    the side to move's perspective.
    """

    policy: np.ndarray
    ownership: np.ndarray
    value: np.ndarray
    score_lead: float


class Position(Protocol):
    board_x_size: int
    board_y_size: int


def load_model(model_path: str, device: str = "cpu") -> "ActivationExtractor":
    """Loads a KataGo checkpoint and returns an extractor for it."""
    return ActivationExtractor(model_path, device=device)


class ActivationExtractor:
    """Runs positions through a model and exposes trunk activations.

    Stateless with respect to the protocol -- nothing here remembers a game or a
    move number. The one piece of retained state is a single-entry memo of the
    last forward pass, keyed by the exact position: asking for eighteen blocks
    of one position would otherwise run the network eighteen times. Because the
    key is the whole position, the memo cannot change an answer, only skip
    recomputing it.
    """

    def __init__(self, model_path: str, device: str = "cpu", pos_len: int = 19) -> None:
        self._path = Path(model_path)
        self._device = torch.device(device)

        # KataGo exports .bin.gz from the SWA (averaged) weights, so the raw
        # model is NOT what the C++ engine runs. Using it costs about 2.5x the
        # disagreement in the golden test.
        model, swa_model, _other = katago_load_model(
            str(self._path), use_swa=True, device=str(self._device), pos_len=pos_len
        )
        self._model = swa_model if swa_model is not None else model
        self._model.eval()
        self._config: Dict[str, Any] = model.config
        self._features = Features(self._config, pos_len)
        self._pos_len = pos_len

        self._spec = NetworkSpec(
            # The checkpoint carries no name, so the file names the network.
            name=self._path.name.split(".")[0],
            blocks=len(self._config["block_kind"]),
            channels=int(self._config["trunk_num_channels"]),
            board_x_size=pos_len,
            board_y_size=pos_len,
        )
        self._block_names = [f"trunk_after_block{i}" for i in range(self._spec.blocks)]

        self._memo_key: Optional[str] = None
        self._memo: Dict[str, Any] = {}
        self._reader_weights: Optional["ReaderWeights"] = None
        self._head_weights: Optional["HeadWeights"] = None

    @property
    def spec(self) -> NetworkSpec:
        return self._spec

    @property
    def used_swa(self) -> bool:
        return True

    def raw_heads(self, position: Dict[str, Any]) -> RawHeads:
        """Policy, ownership and value for a position, with no search.

        This is what the golden test compares against ``katago``'s own raw-net
        numbers. If these disagree, the feature encoding is wrong and every
        activation derived from it is meaningless.
        """
        state, key = self._state_for(position)
        outputs = self._forward(state, key, blocks=[])
        x_size = state.board.x_size
        y_size = state.board.y_size

        policy_full = np.asarray(outputs["policy0"], dtype=np.float64)
        policy = self._crop_policy(policy_full, x_size, y_size)

        ownership_full = np.asarray(outputs["ownership"], dtype=np.float64).reshape(
            self._pos_len, self._pos_len
        )
        ownership = ownership_full[:y_size, :x_size].reshape(-1)

        return RawHeads(
            policy=policy,
            ownership=ownership,
            value=np.asarray(outputs["value"], dtype=np.float64),
            score_lead=float(outputs["lead"]),
        )

    def frame(self, position: Dict[str, Any], block: int) -> np.ndarray:
        """All channels of ``block``'s trunk output.

        Returns ``(channels, pos_len, pos_len)`` float32, which flattened
        C-order is the channel-major, row-major layout the TypeScript side
        slices by hand. Not cropped to the game's board: the tensor really does
        have the network's extent, and the off-board region holds real values.
        """
        if not isinstance(block, int) or isinstance(block, bool):
            raise ValueError(f"block must be an integer, got {block!r}")
        if block < 0 or block >= self._spec.blocks:
            raise IndexError(f"block {block} outside 0..{self._spec.blocks - 1}")

        state, key = self._state_for(position)
        outputs = self._forward(state, key, blocks=[block])
        # GameState.get_model_outputs already moves extra outputs to CPU numpy
        # and strips the batch dimension, giving (channels, pos_len, pos_len).
        array = np.asarray(outputs[self._block_names[block]])
        if array.ndim == 4:  # a batch dimension survived
            array = array[0]
        if array.ndim != 3:
            raise ValueError(f"block {block} gave shape {array.shape}, expected 3 dimensions")
        return np.ascontiguousarray(array, dtype=np.float32)

    def _state_for(self, position: Dict[str, Any]) -> "tuple[GameState, str]":
        """Builds the GameState for a wire position, plus its memo key."""
        from .position import build_game_state, position_key

        return build_game_state(position), position_key(position)

    def _crop_policy(self, policy: np.ndarray, x_size: int, y_size: int) -> np.ndarray:
        """Extracts a board-sized policy from the pos_len-sized tensor.

        The model always predicts over ``pos_len**2 + 1`` points with the board
        in the top-left corner, so a 9x9 game's policy is scattered through a
        362-long vector. KataGo's analysis engine reports ``x*y + 1``; this
        makes the two comparable.
        """
        grid = policy[:-1].reshape(self._pos_len, self._pos_len)
        cropped = grid[:y_size, :x_size].reshape(-1)
        return np.concatenate([cropped, policy[-1:]])

    def _forward(self, state: GameState, position_key: str, blocks: List[int]) -> Dict[str, Any]:
        """Runs the network, reusing the last result when the position repeats."""
        wanted = {self._block_names[b] for b in blocks}
        if self._memo_key == position_key and wanted.issubset(self._memo.keys()):
            return self._memo

        names = self._block_names if blocks else []
        with torch.no_grad():
            outputs = state.get_model_outputs(self._model, extra_output_names=names)
        self._memo_key = position_key
        self._memo = outputs
        return outputs

    # ---- static weight-based importance ------------------------------------

    def reader_weights(self) -> "ReaderWeights":
        """Per-channel norms of the weights that read each block's output.

        Static: it depends only on the network, so it is computed once and
        cached. Blocks 0..N-2 are read by the next block's first conv; the last
        block is read by the heads.

        **The policy head's global-pooling branch is not included.** That head
        opens with two convs on the trunk -- ``conv1p`` for the spatial path and
        ``conv1g`` for the pooled one -- and only the first is measured here.
        A channel used mainly by the pooled branch will therefore look quieter
        than it is.
        """
        if self._reader_weights is None:
            self._reader_weights = self._compute_reader_weights()
        return self._reader_weights

    def _compute_reader_weights(self) -> "ReaderWeights":
        blocks = self._model.blocks
        by_block = []
        for i in range(len(blocks) - 1):
            conv = _first_conv(blocks[i + 1])
            if conv is None:
                raise ValueError(f"block {i + 1} has no convolution to read block {i}")
            by_block.append(_input_channel_norms(conv))

        heads = {}
        for name, module in (("policy", self._model.policy_head), ("value", self._model.value_head)):
            conv = _first_conv(module)
            if conv is None:
                raise ValueError(f"{name} head has no convolution reading the trunk")
            heads[name] = _input_channel_norms(conv)

        return ReaderWeights(channels=self._spec.channels, by_block=by_block, heads=heads)

    # ---- exported head weights ---------------------------------------------

    def head_weights(self) -> "HeadWeights":
        """Every parameter needed to re-run the heads outside this process.

        The point is counterfactuals: the UI zeroes trunk channels and asks what
        the head would then say. That cannot be answered by inspecting outputs,
        only by re-running the head, so the head has to be exportable.

        Two things here are not in the checkpoint and would be silently wrong if
        assumed:

        * ``trunk_final.scale``. For the ``fixscale*`` norm kinds the model's
          ``initialize()`` sets it to ``1/sqrt(blocks + 1)`` **before** the
          state dict loads, so it is part of the network as evaluated but
          appears in no saved tensor. It is read off the live module.
        * The activation. KataGo's trunk suggests ReLU; the reference net is
          Mish, and the head's non-linearities are whatever ``config`` says.
        """
        if self._head_weights is None:
            self._head_weights = self._compute_head_weights()
        return self._head_weights

    def _compute_head_weights(self) -> "HeadWeights":
        model = self._model
        policy = model.policy_head
        value = model.value_head
        config = model.config

        trunk_final = model.norm_trunkfinal
        scale = getattr(trunk_final, "scale", None)
        beta = getattr(trunk_final, "beta", None)
        if beta is None:
            raise ValueError("trunk final norm has no bias to export")

        tensors = {
            "trunkfinal.beta": _flat(beta),
            "policy.conv1p": _flat(policy.conv1p.weight),
            "policy.conv1g": _flat(policy.conv1g.weight),
            "policy.biasg": _flat(policy.biasg.beta),
            "policy.linear_g": _flat(policy.linear_g.weight),
            "policy.linear_pass": _flat(policy.linear_pass.weight),
            "policy.bias2": _flat(policy.bias2.beta),
            "policy.conv2p": _flat(policy.conv2p.weight),
            "value.conv1": _flat(value.conv1.weight),
            "value.bias1": _flat(value.bias1.beta),
            "value.conv_ownership": _flat(value.conv_ownership.weight),
            "value.conv_scoring": _flat(value.conv_scoring.weight),
            "value.conv_futurepos": _flat(value.conv_futurepos.weight),
            "value.conv_seki": _flat(value.conv_seki.weight),
        }
        shapes = {
            "trunkfinal.beta": [int(beta.shape[1])],
            "policy.conv1p": _conv_shape(policy.conv1p),
            "policy.conv1g": _conv_shape(policy.conv1g),
            "policy.biasg": [int(policy.biasg.beta.shape[1])],
            "policy.linear_g": _linear_shape(policy.linear_g),
            "policy.linear_pass": _linear_shape(policy.linear_pass),
            "policy.bias2": [int(policy.bias2.beta.shape[1])],
            "policy.conv2p": _conv_shape(policy.conv2p),
            "value.conv1": _conv_shape(value.conv1),
            "value.bias1": [int(value.bias1.beta.shape[1])],
            "value.conv_ownership": _conv_shape(value.conv_ownership),
            "value.conv_scoring": _conv_shape(value.conv_scoring),
            "value.conv_futurepos": _conv_shape(value.conv_futurepos),
            "value.conv_seki": _conv_shape(value.conv_seki),
        }

        # The pass path gained a hidden layer at version 15; before that it is a
        # single bias-free linear straight to the policy output count.
        if getattr(policy, "linear_pass2", None) is not None:
            tensors["policy.linear_pass.bias"] = _flat(policy.linear_pass.bias)
            shapes["policy.linear_pass.bias"] = [int(policy.linear_pass.bias.shape[0])]
            tensors["policy.linear_pass2"] = _flat(policy.linear_pass2.weight)
            shapes["policy.linear_pass2"] = _linear_shape(policy.linear_pass2)

        return HeadWeights(
            version=int(config["version"]),
            activation=str(config["activation"]),
            trunk_channels=int(self._spec.channels),
            pos_len=int(self._pos_len),
            trunk_final_scale=1.0 if scale is None else float(scale),
            tensors=tensors,
            shapes=shapes,
        )

    # ---- gradient-based attribution ----------------------------------------

    def attribute(
        self,
        position: Dict[str, Any],
        target: Dict[str, Any],
        plane_block: Optional[int] = None,
    ) -> "Attribution":
        """Attributes one scalar output back to every trunk channel.

        Runs a forward pass **with gradients** -- which `GameState`'s helper
        cannot do, since it wraps everything in ``torch.no_grad()`` -- then
        backpropagates the requested scalar and reads ``activation * gradient``
        off every block.

        Deterministic: the same request twice gives the same numbers, because
        the model is in eval mode and nothing here samples.
        """
        state, _ = self._state_for(position)
        blocks = self._spec.blocks
        if plane_block is not None and not (0 <= plane_block < blocks):
            raise IndexError(f"block {plane_block} outside 0..{blocks - 1}")

        extra = _RetainingExtraOutputs(self._block_names)
        bin_input, global_input = state.get_input_features(self._features)

        # No torch.no_grad(): the whole point is the backward pass.
        self._model.zero_grad(set_to_none=True)
        model_outputs = self._model(
            torch.tensor(bin_input, dtype=torch.float32, device=self._device),
            torch.tensor(global_input, dtype=torch.float32, device=self._device),
            extra_outputs=extra,
        )
        outputs = self._model.postprocess_output(model_outputs)
        policy_logits, value_logits = outputs[0][0][0], outputs[0][1][0]
        ownership_pretanh = outputs[0][4][0]

        scalar = self._target_scalar(target, state, policy_logits, value_logits, ownership_pretanh)
        scalar.backward()

        area = self._pos_len * self._pos_len
        by_block = np.zeros((blocks, self._spec.channels), dtype=np.float32)
        planes = None
        for index, name in enumerate(self._block_names):
            tensor = extra.returned.get(name)
            if tensor is None or tensor.grad is None:
                continue
            product = (tensor[0] * tensor.grad[0]).detach()
            by_block[index] = product.abs().sum(dim=(1, 2)).cpu().numpy()
            if plane_block is not None and index == plane_block:
                planes = np.ascontiguousarray(product.cpu().numpy(), dtype=np.float32)

        del area
        return Attribution(by_block=by_block, planes=planes, plane_block=plane_block)

    def _target_scalar(self, target, state, policy_logits, value_logits, ownership_pretanh):
        """The scalar to differentiate, from a wire target description."""
        kind = str(target.get("kind", ""))
        x_size, y_size = state.board.x_size, state.board.y_size

        def require_point() -> "tuple[int, int]":
            x, y = int(target.get("x", -1)), int(target.get("y", -1))
            if not (0 <= x < x_size and 0 <= y < y_size):
                raise ValueError(f"point ({x}, {y}) is off a {x_size}x{y_size} board")
            return x, y

        if kind == "ownership_total":
            # The predicted territory balance: a signed sum, so a position where
            # both sides own equal amounts genuinely attributes to nothing.
            return torch.tanh(ownership_pretanh).sum()
        if kind == "ownership_point":
            x, y = require_point()
            return torch.tanh(ownership_pretanh)[0, y, x]
        if kind == "policy_move":
            x, y = require_point()
            # The logit, not the softmax probability: the probability's gradient
            # is entangled with every other move through the normaliser.
            return policy_logits[0, y * self._pos_len + x]
        if kind == "policy_pass":
            return policy_logits[0, self._pos_len * self._pos_len]
        if kind == "winrate":
            return torch.softmax(value_logits, dim=0)[0]
        raise ValueError(f"unknown attribution target {kind!r}")

    def available_extra_outputs(self, position: Dict[str, Any]) -> List[str]:
        """Names the model can report. Used by tests to pin the block naming."""
        state, _ = self._state_for(position)
        with torch.no_grad():
            outputs = state.get_model_outputs(self._model, extra_output_names=[])
        return list(outputs.get("available_extra_outputs", []))


@dataclass(frozen=True)
class ReaderWeights:
    """Per-channel L2 norms of the weights that *read* each block's output.

    A trunk channel only matters to the extent something downstream looks at
    it. The weight slice a consumer applies to input channel ``c`` bounds how
    much that channel can influence anything, whatever its activation happens
    to be -- so it is a cheap, static prior on importance, computed once per
    network rather than per position.

    ``by_block[i]`` is block ``i`` read by block ``i + 1``. The last block is
    read by the heads instead, so it gets one vector per head.
    """

    channels: int
    by_block: list  # list[np.ndarray], length blocks - 1
    heads: dict  # {"policy": np.ndarray, "value": np.ndarray}


@dataclass(frozen=True)
class Attribution:
    """Per-channel attribution of one scalar target to every trunk channel.

    ``by_block[i][c]`` is ``sum over the board of |activation * gradient|`` for
    channel ``c`` of block ``i`` -- the standard gradient x input saliency,
    summed over space. Absolute value inside the sum, because a channel that
    pushes hard in both directions across the board is still doing work; a
    signed sum would cancel it to nothing.

    ``planes`` is the signed ``activation * gradient`` for one requested block,
    shaped ``(channels, pos_len, pos_len)``, for callers that want to see
    *where* on the board a channel earned its attribution.
    """

    by_block: object  # np.ndarray (blocks, channels)
    planes: object  # np.ndarray (channels, pos_len, pos_len) or None
    plane_block: object  # int or None


@dataclass(frozen=True)
class HeadWeights:
    """Both output heads, flattened for transport.

    ``tensors`` maps a name to a 1-D float32 array in PyTorch's own memory
    order, and ``shapes`` gives the logical shape that flat run unpacks to. The
    consumer reshapes; nothing is transposed on the way out, so a disagreement
    about layout shows up as a golden-test failure rather than as plausible
    wrong numbers.
    """

    version: int
    activation: str
    trunk_channels: int
    pos_len: int
    trunk_final_scale: float
    tensors: dict  # {name: np.ndarray}
    shapes: dict  # {name: list[int]}


def _flat(tensor) -> np.ndarray:
    """A parameter as a contiguous 1-D float32 array, gradients detached."""
    return tensor.detach().reshape(-1).cpu().numpy().astype(np.float32)


def _conv_shape(conv: torch.nn.Conv2d) -> list:
    """``[out, in]`` for a 1x1 conv; the kernel axes are both 1 and dropped."""
    weight = conv.weight
    if weight.shape[2] != 1 or weight.shape[3] != 1:
        raise ValueError(f"expected a 1x1 convolution, got {tuple(weight.shape)}")
    return [int(weight.shape[0]), int(weight.shape[1])]


def _linear_shape(layer: torch.nn.Linear) -> list:
    return [int(layer.weight.shape[0]), int(layer.weight.shape[1])]


class _RetainingExtraOutputs(ExtraOutputs):
    """``ExtraOutputs`` that keeps tensors attached to the graph.

    The stock one calls ``.detach()``, which is right for inspection and fatal
    for attribution: a detached tensor has no ``.grad`` to read after
    ``backward()``.
    """

    def report(self, name, value):
        self.available.append(name)
        if name in self.requested:
            value.retain_grad()
            self.returned[name] = value


def _first_conv(module):
    """The first ``Conv2d`` a module applies, in forward order.

    ``named_modules`` yields in registration order, which for every block and
    head in this model is construction order and therefore forward order.
    """
    for _, sub in module.named_modules():
        if isinstance(sub, torch.nn.Conv2d):
            return sub
    return None


def _input_channel_norms(conv: torch.nn.Conv2d) -> np.ndarray:
    """L2 norm over everything a conv applies to each *input* channel.

    Weight is ``(out, in, kh, kw)``; this reduces every axis but ``in``. Works
    for any kernel size -- the trunk blocks of an nbt net open with 1x1 rather
    than the 3x3 a plain residual net would use.
    """
    weight = conv.weight.detach()
    return weight.pow(2).sum(dim=(0, 2, 3)).sqrt().cpu().numpy().astype(np.float32)
