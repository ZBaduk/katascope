/**
 * The contract between the grid and its worker.
 *
 * Kept separate from both so the main-thread fallback and the worker implement
 * the same thing, and so the pure functions underneath can be tested without
 * either.
 */

import type {
  HeadGeometry,
  HeadKind,
  HeadReduction,
  HeadWeights,
  PreparedRegion,
  ReduceMode,
  RegionHit,
  RegionQuery,
} from '@katascope/core';
import type { ChannelStats } from './channel-stats';

/** Colour ramp options for one repaint. */
export interface RenderOptions {
  readonly channels: number;
  /** Cells per plane: `board.width * board.height`. */
  readonly area: number;
  /** Per-channel ranges, computed across the game. Empty means per-plane. */
  readonly stats: readonly ChannelStats[];
  /**
   * Cells whose change exceeds this fraction of the plane's largest change are
   * tinted red. `undefined` disables the overlay.
   */
  readonly changeFraction?: number;
  /** Channels to render as a collapsed dark tile. */
  readonly hidden?: readonly number[];
  /**
   * Per-channel reader norms for the selected block, if known.
   *
   * Passed in so the impact score is computed here rather than on the main
   * thread: the expensive half is summing |activation| over 384 x 361 cells,
   * and that is exactly the work the worker exists to absorb.
   */
  readonly readerNorms?: Float32Array;
  /**
   * Which head reads each channel hardest, for tinting the last block.
   *
   * Only the last block has two readers, so this is absent everywhere else.
   */
  readonly leans?: readonly ('policy' | 'value' | 'shared')[];
  /**
   * Scale each plane symmetrically about zero rather than against the channel's
   * game-wide range.
   *
   * Used for attribution planes, which are signed: the sign is the information,
   * so zero has to land on the neutral tone rather than somewhere in the middle
   * of whatever range this particular plane happens to span.
   */
  readonly diverging?: boolean;
}

/**
 * One frame to score against a region.
 *
 * Deliberately one frame per message rather than a search the worker runs to
 * completion: the frames have to be fetched over IPC one at a time anyway, so
 * the worker would spend most of a long search idle, and a reply per frame is
 * what lets the table fill in as the search runs. It also keeps the worker
 * stateless, so cancelling is just the driver deciding to stop asking.
 */
export type RenderRequest =
  | { readonly type: 'statsBegin'; readonly channels: number; readonly area: number }
  | { readonly type: 'statsAdd'; readonly data: Float32Array }
  | { readonly type: 'statsEnd'; readonly id: number }
  | {
      readonly type: 'render';
      readonly id: number;
      readonly data: Float32Array;
      readonly previous?: Float32Array;
      readonly options: RenderOptions;
    }
  | {
      readonly type: 'search';
      readonly id: number;
      readonly moveNumber: number;
      readonly block: number;
      readonly channels: number;
      readonly data: Float32Array;
      readonly region: PreparedRegion;
      readonly query: RegionQuery;
    }
  | {
      readonly type: 'reduce';
      readonly id: number;
      readonly trunk: Float32Array;
      readonly weights: HeadWeights;
      readonly geometry: HeadGeometry;
      /** Channel indices; a `Set` does not survive structured clone. */
      readonly selected: readonly number[];
      readonly mode: ReduceMode;
      readonly head: HeadKind;
    };

export type RenderResponse =
  | { readonly type: 'stats'; readonly id: number; readonly stats: readonly ChannelStats[] }
  | {
      readonly type: 'rendered';
      readonly id: number;
      /** `channels * area * 4` bytes, RGBA, channel-major. */
      readonly rgba: Uint8ClampedArray;
      /** Total absolute change per channel, for the sort-by-change toggle. */
      readonly changes: Float64Array;
      /** `sum|activation| x reader norm` per channel, for the impact ordering. */
      readonly impact: Float64Array;
    }
  | {
      readonly type: 'searched';
      readonly id: number;
      /** Channels of this one frame that qualified, in channel order. */
      readonly hits: readonly RegionHit[];
    }
  | {
      readonly type: 'reduced';
      readonly id: number;
      readonly result: HeadReduction;
    };
