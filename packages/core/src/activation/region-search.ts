/**
 * Finding channels that respond to a region of the board.
 *
 * The question this answers is "which channels care about *here*" -- a corner,
 * a group, a single point -- rather than "which channels are loud", which is
 * what the impact ordering already reports. A channel that fires hard
 * everywhere is not responding to the region; a channel that fires on the
 * region and nowhere else is.
 *
 * Two decisions shape the scoring, and both are worth stating:
 *
 * * **Per-plane z-normalisation.** Raw trunk magnitudes differ by an order of
 *   magnitude between block 0 and block 17, and between channels within a
 *   block. A threshold in raw units would therefore mean something different
 *   for every plane it is compared against, and the same slider position would
 *   select half of one block and nothing of another. Working in standard
 *   deviations from the plane's own mean makes one threshold mean one thing
 *   everywhere.
 * * **`min` over the region, not `mean`.** A channel qualifies as responding to
 *   a region only if **every** point of it is high -- taking the mean would let
 *   one blazing intersection carry four dead ones, which is precisely the
 *   false positive the feature exists to avoid. The cost is that the score is
 *   set by the region's weakest point, which is the intended reading of "all
 *   high".
 *
 * Pure, per CLAUDE.md: these take numbers and return numbers. The worker calls
 * them, and so do the tests. Which frames get fed in -- the scope and the block
 * filter -- is the caller's business, not this module's.
 */

import type { BoardSize, Vertex } from '../domain/board.js';
import { boardArea, isOnBoard, vertexIndex } from '../domain/board.js';

/** What the user is looking for across the region. */
export type RegionDirection = 'high' | 'low' | 'either';

/** What a hit turned out to be. `either` resolves to one of these. */
export type HitDirection = 'high' | 'low';

/**
 * Lower bound on a plane's standard deviation before it divides.
 *
 * Without it a dead plane -- all zeros, which a real ReLU trunk has plenty of
 * -- divides zero by zero and scores `NaN`, or divides a rounding error by
 * another rounding error and scores enormously. With it a dead plane yields
 * `z = 0` everywhere, which fails any positive threshold. That last part is the
 * catch worth knowing: the floor only keeps dead planes out for `t > 0`, since
 * at `t <= 0` a plane of zeros does clear the bar. Thresholds are meant to be
 * positive -- a "responds to this region" query at `t = 0` is not asking
 * anything -- and the UI's slider starts above zero.
 */
export const DEFAULT_STD_FLOOR = 1e-6;

/** Default ceiling on outside-the-region loudness for the `specific` flag. */
export const DEFAULT_SPECIFIC_THRESHOLD = 0.5;

/** What to look for. The region is prepared separately, being reused per plane. */
export interface RegionQuery {
  readonly direction: RegionDirection;
  /** A plane qualifies when its score reaches this, in standard deviations. */
  readonly threshold: number;
  /**
   * Additionally require the channel to be quiet **outside** the region.
   *
   * Turns "fires here" into "fires here and not elsewhere", which is a much
   * stronger claim and a much smaller result set.
   */
  readonly specific?: boolean;
  /** Ceiling on `mean|z|` outside the region when `specific` is set. */
  readonly specificThreshold?: number;
  readonly stdFloor?: number;
}

/** One plane's standing relative to a region, in standard deviations. */
export interface PlaneRegionScore {
  /** `min` of `z` over the region: how high the region's *weakest* point is. */
  readonly high: number;
  /** `-max` of `z` over the region: how low the region's *highest* point is. */
  readonly low: number;
  /** Mean `z` over the region, reported so a hit can be read at a glance. */
  readonly regionMeanZ: number;
  /** `mean|z|` over everything outside the region, for the `specific` test. */
  readonly outsideMeanAbsZ: number;
}

/** One qualifying (move, block, channel). */
export interface RegionHit {
  readonly moveNumber: number;
  readonly block: number;
  readonly channel: number;
  readonly direction: HitDirection;
  readonly score: number;
  readonly regionMeanZ: number;
  readonly outsideMeanAbsZ: number;
}

/**
 * A channel's record across every move searched.
 *
 * The point of counting: a channel that clears the bar on one move of a
 * hundred is noise, and a channel that clears it on eighty is a finding. Sorting
 * hits by score alone buries the second under the first.
 */
export interface ChannelSummary {
  readonly block: number;
  readonly channel: number;
  /** How many searched moves this channel qualified on. */
  readonly moves: number;
  readonly bestScore: number;
  readonly bestMoveNumber: number;
  /** Direction of the best-scoring hit. */
  readonly direction: HitDirection;
}

/**
 * A region, resolved to plane offsets once so every plane can reuse it.
 *
 * The mask is redundant with the cell list and kept anyway: scoring needs
 * "is this cell in the region" per cell of the plane, and a `Set` lookup per
 * cell across 384 channels is exactly the kind of thing that makes a search
 * feel slow.
 */
export interface PreparedRegion {
  /** Plane offsets of the selected intersections, ascending and deduplicated. */
  readonly cells: Int32Array;
  /** `area` bytes; 1 where the cell is in the region. */
  readonly mask: Uint8Array;
  readonly area: number;
}

/** Resolves intersections to plane offsets, dropping duplicates and strays. */
export function prepareRegion(size: BoardSize, region: readonly Vertex[]): PreparedRegion {
  const area = boardArea(size);
  const mask = new Uint8Array(Math.max(0, area));
  const cells: number[] = [];

  for (const vertex of region) {
    if (!isOnBoard(size, vertex)) continue;
    const index = vertexIndex(size, vertex);
    if (index < 0 || index >= area || mask[index] === 1) continue;
    mask[index] = 1;
    cells.push(index);
  }

  cells.sort((a, b) => a - b);
  return { cells: Int32Array.from(cells), mask, area };
}

/**
 * Scores one plane against a region.
 *
 * An empty region scores `-Infinity` in both directions rather than the
 * `+Infinity` that `min` over an empty set would give: an empty selection
 * asks nothing, and must not match everything.
 */
export function planeRegionScore(
  plane: ArrayLike<number>,
  region: PreparedRegion,
  stdFloor: number = DEFAULT_STD_FLOOR,
): PlaneRegionScore {
  const empty: PlaneRegionScore = {
    high: Number.NEGATIVE_INFINITY,
    low: Number.NEGATIVE_INFINITY,
    regionMeanZ: 0,
    outsideMeanAbsZ: 0,
  };
  const area = Math.min(region.area, plane.length);
  if (area <= 0 || region.cells.length === 0) return empty;

  let sum = 0;
  let sumSquares = 0;
  for (let i = 0; i < area; i++) {
    const value = plane[i] ?? 0;
    const safe = Number.isFinite(value) ? value : 0;
    sum += safe;
    sumSquares += safe * safe;
  }
  const mean = sum / area;
  // Clamped at zero for the same reason as `ChannelStatsAccumulator`: this
  // cancellation can go slightly negative and `sqrt` would turn that into NaN.
  const variance = Math.max(0, sumSquares / area - mean * mean);
  const divisor = Math.max(Math.sqrt(variance), Math.max(0, stdFloor) || DEFAULT_STD_FLOOR);

  let minZ = Number.POSITIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;
  let regionSum = 0;
  let counted = 0;
  for (const index of region.cells) {
    if (index >= area) continue;
    const value = plane[index] ?? 0;
    const z = ((Number.isFinite(value) ? value : 0) - mean) / divisor;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
    regionSum += z;
    counted++;
  }
  if (counted === 0) return empty;

  let outsideSum = 0;
  let outside = 0;
  for (let i = 0; i < area; i++) {
    if (region.mask[i] === 1) continue;
    const value = plane[i] ?? 0;
    outsideSum += Math.abs(((Number.isFinite(value) ? value : 0) - mean) / divisor);
    outside++;
  }

  return {
    high: minZ,
    // `+ 0` normalises the negative zero that negating a zero `maxZ` produces.
    // It compares equal either way, but it reaches the results table as text.
    low: -maxZ + 0,
    regionMeanZ: regionSum / counted,
    // No outside at all -- the region is the whole board -- is not "quiet
    // elsewhere"; there is no elsewhere, so the specific test cannot pass.
    outsideMeanAbsZ: outside === 0 ? Number.POSITIVE_INFINITY : outsideSum / outside,
  };
}

/**
 * Which direction a plane qualifies in, if any.
 *
 * With `direction: 'either'` the stronger of the two wins, ties going to
 * `high` -- they can only tie when the region is a single point, where the two
 * scores are negatives of each other and a tie means `z` is exactly 0.
 */
export function qualifyingDirection(
  score: PlaneRegionScore,
  query: RegionQuery,
): HitDirection | undefined {
  if (query.specific === true) {
    const ceiling = query.specificThreshold ?? DEFAULT_SPECIFIC_THRESHOLD;
    if (!(score.outsideMeanAbsZ <= ceiling)) return undefined;
  }

  const threshold = query.threshold;
  const highOk = query.direction !== 'low' && score.high >= threshold;
  const lowOk = query.direction !== 'high' && score.low >= threshold;

  if (highOk && lowOk) return score.low > score.high ? 'low' : 'high';
  if (highOk) return 'high';
  if (lowOk) return 'low';
  return undefined;
}

/** The score a hit in this direction reports. */
export function scoreFor(score: PlaneRegionScore, direction: HitDirection): number {
  return direction === 'high' ? score.high : score.low;
}

/** One frame's worth of planes to search. */
export interface SearchFrameInput {
  readonly moveNumber: number;
  readonly block: number;
  readonly channels: number;
  readonly data: ArrayLike<number>;
}

/**
 * Every channel of one frame that qualifies.
 *
 * Returned in channel order; ranking is a separate step because hits from many
 * frames are ranked together.
 */
export function searchFrame(
  frame: SearchFrameInput,
  region: PreparedRegion,
  query: RegionQuery,
): readonly RegionHit[] {
  const hits: RegionHit[] = [];
  const area = region.area;
  if (area <= 0 || region.cells.length === 0 || frame.channels <= 0) return hits;

  for (let channel = 0; channel < frame.channels; channel++) {
    const base = channel * area;
    if (base + area > frame.data.length) break;
    // A view rather than a copy: `planeRegionScore` only reads.
    const plane = subview(frame.data, base, area);
    const score = planeRegionScore(plane, region, query.stdFloor ?? DEFAULT_STD_FLOOR);
    const direction = qualifyingDirection(score, query);
    if (direction === undefined) continue;
    hits.push({
      moveNumber: frame.moveNumber,
      block: frame.block,
      channel,
      direction,
      score: scoreFor(score, direction),
      regionMeanZ: score.regionMeanZ,
      outsideMeanAbsZ: score.outsideMeanAbsZ,
    });
  }
  return hits;
}

/**
 * Hits ordered best first.
 *
 * Ties break by move, then block, then channel, so the table does not reshuffle
 * between two equally-scoring hits when the same search is run again.
 */
export function rankHits(hits: readonly RegionHit[]): readonly RegionHit[] {
  return [...hits].sort(
    (a, b) =>
      b.score - a.score ||
      a.moveNumber - b.moveNumber ||
      a.block - b.block ||
      a.channel - b.channel,
  );
}

/**
 * Per-channel totals across every hit, most-persistent first.
 *
 * Ordered by how many moves the channel qualified on before its best score,
 * because persistence is the stronger signal: one spectacular hit is usually
 * the position, and eighty ordinary ones are the channel.
 */
export function summariseHits(hits: readonly RegionHit[]): readonly ChannelSummary[] {
  const byChannel = new Map<string, ChannelSummary>();

  for (const hit of hits) {
    const key = `${hit.block}:${hit.channel}`;
    const existing = byChannel.get(key);
    if (existing === undefined) {
      byChannel.set(key, {
        block: hit.block,
        channel: hit.channel,
        moves: 1,
        bestScore: hit.score,
        bestMoveNumber: hit.moveNumber,
        direction: hit.direction,
      });
      continue;
    }
    const better = hit.score > existing.bestScore;
    byChannel.set(key, {
      block: existing.block,
      channel: existing.channel,
      moves: existing.moves + 1,
      bestScore: better ? hit.score : existing.bestScore,
      bestMoveNumber: better ? hit.moveNumber : existing.bestMoveNumber,
      direction: better ? hit.direction : existing.direction,
    });
  }

  return [...byChannel.values()].sort(
    (a, b) =>
      b.moves - a.moves ||
      b.bestScore - a.bestScore ||
      a.block - b.block ||
      a.channel - b.channel,
  );
}

/**
 * A read-only window into a buffer.
 *
 * `subarray` avoids a copy but only exists on typed arrays; a plain array
 * falls back to `slice`, which copies. Both are `ArrayLike<number>` to the
 * caller, which is all the scoring needs.
 */
function subview(data: ArrayLike<number>, start: number, length: number): ArrayLike<number> {
  if (ArrayBuffer.isView(data) && 'subarray' in data) {
    const typed = data as unknown as { subarray(begin: number, end: number): ArrayLike<number> };
    return typed.subarray(start, start + length);
  }
  return Array.prototype.slice.call(data, start, start + length) as number[];
}
