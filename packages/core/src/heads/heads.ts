/**
 * KataGo's output heads, re-implemented as pure functions.
 *
 * This exists so the UI can ask counterfactual questions -- "what would the
 * policy be if only these twelve channels reached the head?" -- which needs the
 * head re-run on an altered trunk tensor, not merely inspected. Nothing here
 * talks to the model; it takes a trunk frame and a weight set and returns
 * numbers.
 *
 * **It is a re-implementation, and re-implementations drift.** The golden test
 * in `tools/activation-service` is what keeps this honest: it runs the exported
 * weights against the model's own head output on real positions. A change here
 * that this file's own tests accept but that test rejects is a change that is
 * wrong.
 *
 * Three things about the arithmetic are easy to get subtly wrong, and all three
 * are deliberate:
 *
 * * **The board mask is explicit.** A frame is the network's full extent --
 *   19x19 for the reference net -- and a 13x13 game occupies its top-left
 *   corner, with real, meaningless numbers in the rest. KataGo masks that
 *   region away at every step, and the mask is not cosmetic: the pooled mean
 *   divides by the on-board count, so treating a 13x13 game's frame as 361
 *   cells would scale every pooled feature by 169/361 and quietly change the
 *   pass logit. `HeadGeometry` carries both extents for this reason.
 * * **Zeroing happens at the head input**, after the trunk's final norm and
 *   activation -- see `maskChannels`.
 * * **The activation is the model's**, whatever that is, and for the reference
 *   net it is Mish rather than the ReLU the trunk suggests.
 */

import type { BoardSize } from '../domain/board.js';
import { boardArea } from '../domain/board.js';
import type {
  Conv1x1,
  HeadActivation,
  HeadKind,
  HeadWeights,
  LinearLayer,
  ReduceMode,
} from './head-weights.js';

/** Raised when a weight set does not fit the tensor it is applied to. */
export class HeadShapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HeadShapeError';
  }
}

/**
 * Where the game board sits inside a frame.
 *
 * `planes` is the network's extent, which is what a frame's buffer holds.
 * `board` is the game, which KataGo places in the top-left corner and masks
 * the rest away. They are equal for a 19x19 game on the reference net, and
 * that equality is exactly the case where a missing mask looks correct.
 */
export interface HeadGeometry {
  readonly planes: BoardSize;
  readonly board: BoardSize;
}

/** Geometry for a game that fills the network's extent. */
export function fullGeometry(size: BoardSize): HeadGeometry {
  return { planes: size, board: size };
}

/** 1 where a cell is on the game board, 0 where it is only network extent. */
export function boardMask(geometry: HeadGeometry): Uint8Array {
  const { planes, board } = geometry;
  const mask = new Uint8Array(boardArea(planes));
  for (let y = 0; y < board.height && y < planes.height; y++) {
    const row = y * planes.width;
    for (let x = 0; x < board.width && x < planes.width; x++) mask[row + x] = 1;
  }
  return mask;
}

/**
 * Mish: `x * tanh(softplus(x))`.
 *
 * Computed through a numerically stable softplus, because `log(1 + exp(x))`
 * overflows for x around 90 in float64 and trunk activations are not bounded.
 */
export function mish(x: number): number {
  const softplus = x > 20 ? x : Math.log1p(Math.exp(x));
  return x * Math.tanh(softplus);
}

/** Applies the named activation elementwise, in place. */
export function applyActivation(values: Float32Array, activation: HeadActivation): Float32Array {
  switch (activation) {
    case 'identity':
      return values;
    case 'relu':
      for (let i = 0; i < values.length; i++) {
        const v = values[i] ?? 0;
        values[i] = v > 0 ? v : 0;
      }
      return values;
    case 'mish':
      for (let i = 0; i < values.length; i++) {
        values[i] = mish(values[i] ?? 0);
      }
      return values;
  }
}

/**
 * A 1x1 convolution over a channel-major plane stack.
 *
 * `input` is `conv.inChannels * area`; the result is `conv.outChannels * area`.
 * With a 1x1 kernel this is one matrix multiply per board point, and writing it
 * as an explicit triple loop rather than anything cleverer keeps it obviously
 * the same operation PyTorch performs.
 */
export function conv1x1(input: ArrayLike<number>, conv: Conv1x1, area: number): Float32Array {
  const expected = conv.inChannels * area;
  if (input.length < expected) {
    throw new HeadShapeError(
      `conv1x1 needs ${expected} inputs for ${conv.inChannels} channels of ${area} cells, got ${input.length}`,
    );
  }
  if (conv.weight.length < conv.outChannels * conv.inChannels) {
    throw new HeadShapeError(
      `conv1x1 weight is ${conv.weight.length}, expected ${conv.outChannels * conv.inChannels}`,
    );
  }

  const out = new Float32Array(conv.outChannels * area);
  for (let oc = 0; oc < conv.outChannels; oc++) {
    const weightBase = oc * conv.inChannels;
    const outBase = oc * area;
    for (let ic = 0; ic < conv.inChannels; ic++) {
      const w = conv.weight[weightBase + ic] ?? 0;
      if (w === 0) continue; // A zeroed channel contributes nothing; skip the row.
      const inBase = ic * area;
      for (let i = 0; i < area; i++) {
        out[outBase + i] = (out[outBase + i] ?? 0) + w * (input[inBase + i] ?? 0);
      }
    }
  }
  return out;
}

/**
 * KataGo's `BiasMask`: add a per-channel bias, then zero everything off-board.
 *
 * The masking is not optional even though the bias often is. Without it the
 * off-board region carries `beta` into the pooled max, and a channel whose bias
 * happens to exceed its on-board values would have its pooled feature decided
 * by a part of the tensor that is not the game.
 */
export function addChannelBias(
  values: Float32Array,
  bias: ArrayLike<number>,
  channels: number,
  area: number,
  mask?: Uint8Array,
): Float32Array {
  for (let c = 0; c < channels; c++) {
    const b = bias[c] ?? 0;
    const base = c * area;
    for (let i = 0; i < area; i++) {
      const masked = mask !== undefined && mask[i] === 0;
      values[base + i] = masked ? 0 : (values[base + i] ?? 0) + b;
    }
  }
  return values;
}

/** A linear layer applied to one feature vector. */
export function linear(input: ArrayLike<number>, layer: LinearLayer): Float32Array {
  if (input.length < layer.inFeatures) {
    throw new HeadShapeError(
      `linear needs ${layer.inFeatures} features, got ${input.length}`,
    );
  }
  const out = new Float32Array(layer.outFeatures);
  for (let o = 0; o < layer.outFeatures; o++) {
    const base = o * layer.inFeatures;
    let total = layer.bias?.[o] ?? 0;
    for (let i = 0; i < layer.inFeatures; i++) {
      total += (layer.weight[base + i] ?? 0) * (input[i] ?? 0);
    }
    out[o] = total;
  }
  return out;
}

/**
 * KataGo's policy-head pooling: `[mean, mean * s, max]` per channel.
 *
 * `s` is `(sqrt(area) - 14) / 10`, a board-size term that lets one network
 * behave differently on 9x9 and 19x19. The three parts are concatenated along
 * channels, so the result is `3 * channels` long with all the means first.
 */
export function kataGPool(
  values: ArrayLike<number>,
  channels: number,
  area: number,
  mask: Uint8Array,
  maskSum: number,
): Float32Array {
  const out = new Float32Array(3 * channels);
  if (area <= 0 || maskSum <= 0) return out;
  const offset = (Math.sqrt(maskSum) - 14) / 10;

  for (let c = 0; c < channels; c++) {
    const base = c * area;
    let sum = 0;
    let max = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < area; i++) {
      const on = mask[i] === 1;
      const v = on ? (values[base + i] ?? 0) : 0;
      if (on) sum += v;
      // KataGo takes the max of `x + (mask - 1)`, i.e. off-board cells are
      // offset to -1. Every activation it uses exceeds -1, so that is
      // mask-safe; skipping them outright is the same thing and clearer.
      if (on && v > max) max = v;
    }
    const mean = sum / maskSum;
    out[c] = mean;
    out[channels + c] = mean * offset;
    out[2 * channels + c] = Number.isFinite(max) ? max : 0;
  }
  return out;
}

/**
 * KataGo's value-head pooling: `[mean, mean * s, mean * q]`.
 *
 * Same mean three times over, weighted by board size rather than by anything
 * spatial -- there is no max here, unlike the policy head's.
 */
export function kataValueGPool(
  values: ArrayLike<number>,
  channels: number,
  area: number,
  mask: Uint8Array,
  maskSum: number,
): Float32Array {
  const out = new Float32Array(3 * channels);
  if (area <= 0 || maskSum <= 0) return out;
  const root = Math.sqrt(maskSum) - 14;
  const offset = root / 10;
  const quadratic = (root * root) / 100 - 0.1;

  for (let c = 0; c < channels; c++) {
    const base = c * area;
    let sum = 0;
    for (let i = 0; i < area; i++) {
      if (mask[i] === 1) sum += values[base + i] ?? 0;
    }
    const mean = sum / maskSum;
    out[c] = mean;
    out[channels + c] = mean * offset;
    out[2 * channels + c] = mean * quadratic;
  }
  return out;
}

/**
 * The tensor both heads actually read.
 *
 * The Diagnostics grid shows `trunk_after_block{N-1}`; the heads are fed that
 * same tensor after the trunk's final normalisation and activation. Tile `c`
 * and head-input channel `c` are the same channel -- the normalisation is
 * per-channel -- which is what lets a tile's checkbox mean something here.
 */
export function headInput(
  trunk: ArrayLike<number>,
  weights: HeadWeights,
  geometry: HeadGeometry,
): Float32Array {
  const area = boardArea(geometry.planes);
  const channels = weights.trunkChannels;
  if (trunk.length < channels * area) {
    throw new HeadShapeError(
      `head input needs ${channels * area} values, got ${trunk.length}`,
    );
  }

  const mask = boardMask(geometry);
  const { scale, beta } = weights.trunkFinal;
  const out = new Float32Array(channels * area);
  for (let c = 0; c < channels; c++) {
    const base = c * area;
    const b = beta[c] ?? 0;
    for (let i = 0; i < area; i++) {
      out[base + i] = mask[i] === 0 ? 0 : (trunk[base + i] ?? 0) * scale + b;
    }
  }
  // Mish(0) = 0, as does every activation KataGo uses, so the off-board region
  // stays zero through this and the mask need not be reapplied.
  return applyActivation(out, weights.activation);
}

/**
 * Zeroes channels of a head input.
 *
 * **At the head input, not at the trunk.** Zeroing a trunk channel and then
 * re-normalising would not silence it: the final norm adds a per-channel bias
 * and the activation maps that bias to something non-zero, so a "removed"
 * channel would still push a constant into every convolution that reads it.
 * Zeroing here means exactly what it looks like -- the channel contributes
 * nothing to any head output.
 *
 * The returned buffer is always a copy; the caller's frame is left alone.
 */
export function maskChannels(
  input: ArrayLike<number>,
  selected: ReadonlySet<number>,
  mode: ReduceMode,
  channels: number,
  area: number,
): Float32Array {
  const out = new Float32Array(channels * area);
  for (let c = 0; c < channels; c++) {
    const keep = mode === 'only' ? selected.has(c) : !selected.has(c);
    if (!keep) continue;
    const base = c * area;
    for (let i = 0; i < area; i++) out[base + i] = input[base + i] ?? 0;
  }
  return out;
}

/** The policy head's output for one position. */
export interface PolicyHeadOutput {
  /** `area` logits, row-major from the top-left. */
  readonly logits: Float32Array;
  /** The pass logit, which comes from the pooled branch alone. */
  readonly pass: number;
}

/**
 * Runs the policy head on a head-input tensor.
 *
 * Only output 0 is returned. KataGo's policy head emits several -- opponent
 * reply, soft, optimistic variants -- and output 0 is the one the engine plays
 * from and the one the board overlay shows.
 */
export function policyHead(
  input: ArrayLike<number>,
  weights: HeadWeights,
  geometry: HeadGeometry,
): PolicyHeadOutput {
  const area = boardArea(geometry.planes);
  const mask = boardMask(geometry);
  const maskSum = boardArea(geometry.board);
  const { policy, activation } = weights;
  const cp1 = policy.conv1p.outChannels;
  const cg1 = policy.conv1g.outChannels;

  // Spatial path.
  const outp = conv1x1(input, policy.conv1p, area);

  // Pooled path: bias-and-mask, activate, pool.
  const outg = conv1x1(input, policy.conv1g, area);
  addChannelBias(outg, policy.biasg, cg1, area, mask);
  applyActivation(outg, activation);
  const pooled = kataGPool(outg, cg1, area, mask, maskSum);

  // Pass logits come from the pooled features only, which is why a reduction
  // that ignored the pooled branch would get the pass badly wrong.
  let pass = linear(pooled, policy.linearPass);
  if (policy.linearPass2 !== undefined) {
    // Version >= 15 splits the pass path in two with an activation between.
    applyActivation(pass, activation);
    pass = linear(pass, policy.linearPass2);
  }

  // The pooled features rejoin the spatial path as a per-channel constant.
  // Added before `bias2` so the single masking pass covers both.
  const merged = linear(pooled, policy.linearG);
  addChannelBias(outp, merged, cp1, area);
  addChannelBias(outp, policy.bias2, cp1, area, mask);
  applyActivation(outp, activation);

  const conv = conv1x1(outp, policy.conv2p, area);
  // Output 0 of `num_policy_outputs`; the rest are training targets.
  const logits = conv.slice(0, area);
  // KataGo drives off-board logits to -5000 so they vanish under the softmax.
  for (let i = 0; i < area; i++) {
    if (mask[i] === 0) logits[i] = (logits[i] ?? 0) - 5000;
  }
  return { logits, pass: pass[0] ?? 0 };
}

/**
 * Runs the value head's ownership branch on a head-input tensor.
 *
 * Returns ownership in [-1, 1] after `tanh`, positive meaning the side to move
 * owns the point -- the same convention and sign as the analysis engine's, so
 * the two overlays can be compared directly.
 */
export function ownershipHead(
  input: ArrayLike<number>,
  weights: HeadWeights,
  geometry: HeadGeometry,
): Float32Array {
  const area = boardArea(geometry.planes);
  const mask = boardMask(geometry);
  const { value, activation } = weights;

  const outv1 = conv1x1(input, value.conv1, area);
  addChannelBias(outv1, value.bias1, value.conv1.outChannels, area, mask);
  applyActivation(outv1, activation);

  const pretanh = conv1x1(outv1, value.convOwnership, area);
  const out = new Float32Array(area);
  // Masked before the tanh, so off-board reads 0 rather than tanh(0)'s
  // neighbourhood of whatever the convolution made of a zeroed input.
  for (let i = 0; i < area; i++) {
    out[i] = mask[i] === 0 ? 0 : Math.tanh(pretanh[i] ?? 0);
  }
  return out;
}

/**
 * Softmax over the board points and the pass.
 *
 * Takes the values and the pass separately rather than a `PolicyHeadOutput`,
 * so a reduced policy -- which arrives as a `HeadField` -- can be turned into a
 * distribution without being repackaged. Shifted by the maximum before
 * exponentiating, which matters more here than usual: a reduction can push
 * logits a long way from where a real head would put them.
 */
export function policySoftmax(values: ArrayLike<number>, pass: number): Float32Array {
  const area = values.length;
  const out = new Float32Array(area + 1);
  let max = pass;
  for (let i = 0; i < area; i++) {
    const v = values[i] ?? 0;
    if (v > max) max = v;
  }
  let total = 0;
  for (let i = 0; i < area; i++) {
    const e = Math.exp((values[i] ?? 0) - max);
    out[i] = e;
    total += e;
  }
  const passExp = Math.exp(pass - max);
  out[area] = passExp;
  total += passExp;
  if (total > 0) {
    for (let i = 0; i <= area; i++) out[i] = (out[i] ?? 0) / total;
  }
  return out;
}

/** One head's output over the board, plus the pass logit where there is one. */
export interface HeadField {
  /** `area` values: policy logits, or ownership in [-1, 1]. */
  readonly values: Float32Array;
  /** Policy only. */
  readonly pass?: number;
}

/**
 * The full head output, the reduced one, and what the reduction cost.
 *
 * All three are reported because the reduced output alone is uninterpretable:
 * a policy that likes the top-left corner means one thing if the full head
 * liked it too and quite another if the reduction invented it. The difference
 * is `full - reduced`, so a positive value is something the removed channels
 * were contributing.
 */
export interface HeadReduction {
  readonly head: HeadKind;
  readonly mode: ReduceMode;
  /** How many channels the selection held, for the caption. */
  readonly selected: number;
  readonly full: HeadField;
  readonly reduced: HeadField;
  /** `full.values - reduced.values`, elementwise. */
  readonly difference: Float32Array;
  /** Policy only: `full.pass - reduced.pass`. */
  readonly passDifference?: number;
}

/**
 * Runs one head twice: once whole, once with channels zeroed.
 *
 * The full pass is recomputed rather than taken from the engine on purpose.
 * The engine's numbers come from a different implementation on a different
 * device, and a difference of two outputs is only meaningful when both came
 * from the same arithmetic -- otherwise the residual between implementations
 * would be indistinguishable from the effect being measured.
 */
export function reduceHead(
  trunk: ArrayLike<number>,
  weights: HeadWeights,
  geometry: HeadGeometry,
  selected: ReadonlySet<number>,
  mode: ReduceMode,
  head: HeadKind,
): HeadReduction {
  const area = boardArea(geometry.planes);
  const input = headInput(trunk, weights, geometry);
  const masked = maskChannels(input, selected, mode, weights.trunkChannels, area);

  const run = (tensor: Float32Array): HeadField => {
    if (head === 'ownership') return { values: ownershipHead(tensor, weights, geometry) };
    const out = policyHead(tensor, weights, geometry);
    return { values: out.logits, pass: out.pass };
  };

  const full = run(input);
  const reduced = run(masked);
  const difference = new Float32Array(area);
  for (let i = 0; i < area; i++) {
    difference[i] = (full.values[i] ?? 0) - (reduced.values[i] ?? 0);
  }

  return {
    head,
    mode,
    selected: selected.size,
    full,
    reduced,
    difference,
    ...(full.pass === undefined || reduced.pass === undefined
      ? {}
      : { passDifference: full.pass - reduced.pass }),
  };
}
