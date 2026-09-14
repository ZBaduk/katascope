/**
 * Two ways of asking which trunk channels matter.
 *
 * They answer different questions and cost wildly different amounts:
 *
 * * **Reader weights** are static. A channel only matters to the extent
 *   something downstream reads it, and the weight slice its consumer applies
 *   bounds how much it can influence anything whatever its activation happens
 *   to be. One request per network, no position, no forward pass -- a cheap
 *   prior, and wrong about any particular position.
 * * **Attribution** is exact for one position and one output. It runs a forward
 *   and a backward pass and reports `sum over the board of |activation x
 *   gradient|`. It answers "what did this channel contribute to *that* number,
 *   *here*", and costs a model evaluation to find out.
 *
 * Both are optional on `ActivationStore`: a `.kact` capture holds stored planes
 * and can supply neither, so the UI must degrade rather than assume.
 */

import type { Vertex } from './board.js';

/** Per-channel L2 norms of the weights that read each block's output. */
export interface ReaderWeights {
  readonly networkName: string;
  readonly channels: number;
  /**
   * `byBlock[i]` is block `i` as read by block `i + 1`'s first convolution.
   * Length is `blocks - 1`: the last block is read by the heads instead.
   */
  readonly byBlock: readonly Float32Array[];
  /**
   * The last block, as read by each head's first convolution.
   *
   * The policy head's global-pooling branch is **not** included -- that head
   * opens with two convolutions on the trunk and only the spatial one is
   * measured -- so a channel used mainly by the pooled branch reads quieter
   * than it is.
   */
  readonly heads: {
    readonly policy: Float32Array;
    readonly value: Float32Array;
  };
}

/** Which head reads the last block. Only meaningful for the last block. */
export type ReaderHead = 'policy' | 'value';

/** What an attribution run differentiates. */
export type AttributionTarget =
  /** The predicted territory balance: the signed sum of the ownership map. */
  | { readonly kind: 'ownership_total' }
  /** Predicted ownership of one intersection. */
  | { readonly kind: 'ownership_point'; readonly x: number; readonly y: number }
  /**
   * The policy **logit** for one move -- not the probability, whose gradient is
   * entangled with every other move through the softmax normaliser.
   */
  | { readonly kind: 'policy_move'; readonly x: number; readonly y: number }
  | { readonly kind: 'policy_pass' }
  /** Win probability for the side to move. */
  | { readonly kind: 'winrate' };

export interface AttributionRequest {
  readonly moveNumber: number;
  readonly target: AttributionTarget;
  /** Also return the signed per-point planes for this block. */
  readonly planeBlock?: number;
}

export interface Attribution {
  readonly moveNumber: number;
  readonly target: AttributionTarget;
  readonly blocks: number;
  readonly channels: number;
  /** `blocks * channels`, block-major. Non-negative: the sum is over `|a x g|`. */
  readonly byBlock: Float32Array;
  readonly planeBlock?: number;
  /**
   * `channels * width * height`, channel-major, **signed** -- the totals drop
   * the sign, these keep it so the direction of a contribution is visible.
   */
  readonly planes?: Float32Array;
}

/** One block's slice of an attribution, without copying. */
export function attributionForBlock(attribution: Attribution, block: number): Float32Array {
  if (!Number.isInteger(block) || block < 0 || block >= attribution.blocks) {
    throw new RangeError(`block ${block} outside 0..${attribution.blocks - 1}`);
  }
  const start = block * attribution.channels;
  return attribution.byBlock.subarray(start, start + attribution.channels);
}

/**
 * The reader norms that apply to a block.
 *
 * Every block but the last is read by the next one, so `head` is ignored there.
 * The last block is read by both heads and there is no single answer, so the
 * caller must say which it means.
 */
export function readerNormsFor(
  weights: ReaderWeights,
  block: number,
  blocks: number,
  head: ReaderHead = 'policy',
): Float32Array | undefined {
  if (block < 0 || block >= blocks) return undefined;
  if (block === blocks - 1) return weights.heads[head];
  return weights.byBlock[block];
}

/** True when a target names a specific point, for showing it on the board. */
export function targetVertex(target: AttributionTarget): Vertex | undefined {
  if (target.kind === 'ownership_point' || target.kind === 'policy_move') {
    return { x: target.x, y: target.y };
  }
  return undefined;
}

/** A short label for a target, for the status lines on both tabs. */
export function describeTarget(target: AttributionTarget): string {
  switch (target.kind) {
    case 'ownership_total':
      return 'total ownership';
    case 'winrate':
      return 'winrate';
    case 'policy_pass':
      return 'policy: pass';
    case 'ownership_point':
      return `ownership at (${target.x}, ${target.y})`;
    case 'policy_move':
      return `policy at (${target.x}, ${target.y})`;
  }
}
