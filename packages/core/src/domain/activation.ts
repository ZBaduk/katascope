/**
 * Activations: the tensors katascope exists to show.
 *
 * A frame is one (move, block) pair -- every channel of the trunk output at
 * that block, for the position after that move. Planes are stored channel-major
 * and row-major within a channel, so channel `c` occupies
 * `data[c * area .. (c + 1) * area)`.
 */

import type { BoardSize } from './board.js';
import { boardArea } from './board.js';
import type { NetworkSpec } from './network-spec.js';
import type { Attribution, AttributionRequest, ReaderWeights } from './attribution.js';
import type { HeadWeights } from '../heads/head-weights.js';

/**
 * Element type of a frame's buffer. `float32` carries raw activations;
 * `uint8` carries values the producer has already quantised to 0..255, which
 * is four times cheaper to ship across IPC for heatmap rendering.
 */
export type PlaneDType = 'float32' | 'uint8';

export type PlaneBuffer = Float32Array | Uint8Array;

/** Value range of a frame, needed to colour-map quantised planes back to reality. */
export interface ValueRange {
  readonly min: number;
  readonly max: number;
}

/** Identifies one inspectable tensor. */
export interface ActivationKey {
  /** Index into `GameRecord.moves`; 0 is the position before the first move. */
  readonly moveNumber: number;
  /** Residual block index, `0 .. NetworkSpec.blocks - 1`. */
  readonly block: number;
}

/** All channels of one block's output at one move. */
export interface ActivationFrame extends ActivationKey {
  readonly networkName: string;
  readonly boardSize: BoardSize;
  readonly channels: number;
  readonly dtype: PlaneDType;
  /**
   * `channels * width * height` elements, channel-major. For `uint8` frames the
   * stored value `v` maps back to `range.min + (v / 255) * (range.max - range.min)`.
   */
  readonly data: PlaneBuffer;
  /** Range of the underlying float values across the whole frame. */
  readonly range: ValueRange;
}

/** What a store can serve, so callers can bound their requests. */
export interface ActivationAvailability {
  readonly spec: NetworkSpec;
  /** Highest addressable move number, inclusive. */
  readonly maxMoveNumber: number;
  readonly dtype: PlaneDType;
}

/**
 * Source of activation frames. Implemented by `FakeActivationStore` (synthetic,
 * in `@katascope/core`) and by the Python sidecar client (real, in
 * `@katascope/katago-bridge`). Consumers depend only on this interface.
 */
export interface ActivationStore {
  /** Network shape and addressable range. */
  describe(): Promise<ActivationAvailability>;
  /** All channels of `key`. Rejects if the key is out of range. */
  frame(key: ActivationKey): Promise<ActivationFrame>;
  /**
   * Static, weight-based channel importance.
   *
   * Optional: a `.kact` capture holds stored planes and has no weights to
   * measure, so callers must degrade rather than assume.
   */
  readerWeights?(): Promise<ReaderWeights>;
  /**
   * Gradient-based attribution of one output to every channel.
   *
   * Optional for the same reason as `readerWeights`, and additionally because
   * it needs a live model: a capture cannot be differentiated.
   */
  attribute?(request: AttributionRequest): Promise<Attribution>;
  /**
   * Both output heads' parameters, for re-running them on an altered trunk.
   *
   * Optional for the same reason as the others: a capture holds stored planes
   * and carries no weights, so a caller must degrade rather than assume.
   */
  headWeights?(): Promise<HeadWeights>;
  /** Releases any underlying process or handle. Safe to call more than once. */
  dispose(): Promise<void>;
}

/** Elements per channel in a frame. */
export function planeLength(frame: Pick<ActivationFrame, 'boardSize'>): number {
  return boardArea(frame.boardSize);
}

/**
 * View of a single channel, sharing the frame's buffer -- no copy is made.
 * Throws if `channel` is out of range.
 */
export function channelPlane(frame: ActivationFrame, channel: number): PlaneBuffer {
  if (!Number.isInteger(channel) || channel < 0 || channel >= frame.channels) {
    throw new RangeError(`channel ${channel} outside 0..${frame.channels - 1}`);
  }
  const area = planeLength(frame);
  const start = channel * area;
  return frame.data.subarray(start, start + area) as PlaneBuffer;
}

/** Maps a stored element back to its float value, undoing uint8 quantisation. */
export function dequantize(frame: ActivationFrame, stored: number): number {
  if (frame.dtype === 'float32') return stored;
  const { min, max } = frame.range;
  return min + (stored / 255) * (max - min);
}
