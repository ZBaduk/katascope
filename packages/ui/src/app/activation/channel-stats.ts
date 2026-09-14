/**
 * Per-channel statistics, and the decisions that depend on them.
 *
 * The grid normalises each channel **across the whole game**, not per move.
 * Per-move normalisation is the obvious thing and it is wrong here: a channel
 * that fires hard at move 10 and goes quiet at move 60 would look identical at
 * both, because each frame would be rescaled to fill the same range. Comparing
 * moves is the entire point of the tab, so the range has to be fixed across
 * them.
 *
 * Computing that means reading every move's frame once per channel, which is
 * why it is lazy and cached, and why it runs in a worker.
 *
 * Pure, per CLAUDE.md: these take numbers and return numbers. The worker calls
 * them; so do the tests.
 */

/** One channel's extent and spread over every move sampled. */
export interface ChannelStats {
  readonly channel: number;
  readonly min: number;
  readonly max: number;
  readonly mean: number;
  /** Population standard deviation across every sampled value. */
  readonly stdev: number;
  /** Variance, kept because "hide unused" thresholds on it directly. */
  readonly variance: number;
}

/**
 * Stats for one plane at one move, for the hover readout.
 *
 * `delta` is measured against the **comparison** plane the caller supplies,
 * which the view takes from the last position with the same player to move --
 * not simply the previous move. See `SessionStore.comparisonFrame`.
 */
export interface PlaneStats {
  readonly min: number;
  readonly max: number;
  readonly mean: number;
  /** Sum of |value - comparison| over the plane, or 0 with nothing to compare. */
  readonly delta: number;
}

/**
 * Accumulates per-channel statistics one frame at a time.
 *
 * Streaming rather than collecting: a 200-move b18c384 capture is about two
 * gigabytes in float32, so the frames are read one at a time and discarded.
 * Uses a sum-of-squares accumulation, which is fine for activation magnitudes
 * and one pass rather than two.
 */
export class ChannelStatsAccumulator {
  readonly #channels: number;
  readonly #area: number;
  readonly #min: Float64Array;
  readonly #max: Float64Array;
  readonly #sum: Float64Array;
  readonly #sumSquares: Float64Array;
  #count = 0;

  constructor(channels: number, area: number) {
    this.#channels = Math.max(0, channels);
    this.#area = Math.max(0, area);
    this.#min = new Float64Array(this.#channels).fill(Infinity);
    this.#max = new Float64Array(this.#channels).fill(-Infinity);
    this.#sum = new Float64Array(this.#channels);
    this.#sumSquares = new Float64Array(this.#channels);
  }

  /** Folds in one frame's worth of planes, channel-major. */
  add(data: ArrayLike<number>): void {
    for (let channel = 0; channel < this.#channels; channel++) {
      const base = channel * this.#area;
      let min = this.#min[channel] ?? Infinity;
      let max = this.#max[channel] ?? -Infinity;
      let sum = 0;
      let sumSquares = 0;
      for (let i = 0; i < this.#area; i++) {
        const value = data[base + i] ?? 0;
        if (!Number.isFinite(value)) continue;
        if (value < min) min = value;
        if (value > max) max = value;
        sum += value;
        sumSquares += value * value;
      }
      this.#min[channel] = min;
      this.#max[channel] = max;
      this.#sum[channel] = (this.#sum[channel] ?? 0) + sum;
      this.#sumSquares[channel] = (this.#sumSquares[channel] ?? 0) + sumSquares;
    }
    this.#count++;
  }

  /** The stats so far. Safe to call before any frame has been added. */
  result(): readonly ChannelStats[] {
    const samples = this.#count * this.#area;
    const out: ChannelStats[] = [];
    for (let channel = 0; channel < this.#channels; channel++) {
      const min = this.#min[channel] ?? Infinity;
      const max = this.#max[channel] ?? -Infinity;
      if (samples === 0 || !Number.isFinite(min) || !Number.isFinite(max)) {
        out.push({ channel, min: 0, max: 0, mean: 0, stdev: 0, variance: 0 });
        continue;
      }
      const mean = (this.#sum[channel] ?? 0) / samples;
      // Clamped at zero: floating-point cancellation can make this a very small
      // negative, and a negative variance propagates as NaN through sqrt.
      const variance = Math.max(0, (this.#sumSquares[channel] ?? 0) / samples - mean * mean);
      out.push({ channel, min, max, mean, stdev: Math.sqrt(variance), variance });
    }
    return out;
  }
}

/** Stats for a single plane, with an optional previous plane for the delta. */
export function planeStats(
  plane: ArrayLike<number>,
  previous?: ArrayLike<number>,
): PlaneStats {
  if (plane.length === 0) return { min: 0, max: 0, mean: 0, delta: 0 };
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  let delta = 0;
  for (let i = 0; i < plane.length; i++) {
    const value = plane[i] ?? 0;
    const safe = Number.isFinite(value) ? value : 0;
    if (safe < min) min = safe;
    if (safe > max) max = safe;
    sum += safe;
    if (previous !== undefined) {
      const before = previous[i] ?? 0;
      delta += Math.abs(safe - (Number.isFinite(before) ? before : 0));
    }
  }
  return { min, max, mean: sum / plane.length, delta };
}

/**
 * Per-cell absolute change between two frames' planes for one channel.
 *
 * Returns an empty array when there is no previous frame — move 0 has nothing
 * to compare against, and inventing a zero baseline would paint the whole first
 * position as "unchanged", which is a claim rather than an absence.
 */
export function channelDelta(
  current: ArrayLike<number>,
  previous: ArrayLike<number> | undefined,
  channel: number,
  area: number,
): Float32Array {
  if (previous === undefined || area <= 0) return new Float32Array(0);
  const base = channel * area;
  const out = new Float32Array(area);
  for (let i = 0; i < area; i++) {
    const now = current[base + i] ?? 0;
    const before = previous[base + i] ?? 0;
    out[i] = Math.abs((Number.isFinite(now) ? now : 0) - (Number.isFinite(before) ? before : 0));
  }
  return out;
}

/**
 * Total absolute change per channel between two frames.
 *
 * This is what "sort by most changed" orders on. Returns zeros with no previous
 * frame, so the sort degrades to channel order rather than throwing.
 */
export function channelChangeTotals(
  current: ArrayLike<number>,
  previous: ArrayLike<number> | undefined,
  channels: number,
  area: number,
): Float64Array {
  const out = new Float64Array(Math.max(0, channels));
  if (previous === undefined || area <= 0) return out;
  for (let channel = 0; channel < channels; channel++) {
    const base = channel * area;
    let total = 0;
    for (let i = 0; i < area; i++) {
      const now = current[base + i] ?? 0;
      const before = previous[base + i] ?? 0;
      total += Math.abs((Number.isFinite(now) ? now : 0) - (Number.isFinite(before) ? before : 0));
    }
    out[channel] = total;
  }
  return out;
}

/**
 * Channel indices ordered most-changed first.
 *
 * Ties break by channel index so the grid does not reshuffle between two
 * equally-changed channels as the user steps back and forth.
 */
export function channelsByChange(totals: ArrayLike<number>): readonly number[] {
  const order = Array.from({ length: totals.length }, (_, i) => i);
  order.sort((a, b) => (totals[b] ?? 0) - (totals[a] ?? 0) || a - b);
  return order;
}

/**
 * Which channels count as unused at a variance threshold.
 *
 * A dead ReLU channel has variance 0 across the whole game; a nearly-dead one
 * has a very small variance. Hiding them reclaims most of a 384-channel grid.
 * Returns a `Set` of channel indices to hide.
 */
export function unusedChannels(
  stats: readonly ChannelStats[],
  varianceThreshold: number,
): ReadonlySet<number> {
  const hidden = new Set<number>();
  if (!(varianceThreshold > 0)) return hidden;
  for (const channel of stats) {
    if (channel.variance < varianceThreshold) hidden.add(channel.channel);
  }
  return hidden;
}

/**
 * The largest variance in the set, for scaling the "hide unused" slider.
 *
 * A slider in raw variance units is unusable — the range depends on the net and
 * the block — so the control works in a 0..1 fraction of this.
 */
export function maxVariance(stats: readonly ChannelStats[]): number {
  let max = 0;
  for (const channel of stats) {
    if (channel.variance > max) max = channel.variance;
  }
  return max;
}

/**
 * Cells whose change exceeds a threshold, as a boolean mask.
 *
 * The threshold arrives as a 0..1 fraction of the largest change in the plane,
 * because an absolute one would need retuning for every block: trunk magnitudes
 * differ by an order of magnitude between block 0 and block 17. A fraction of 0
 * marks every cell that changed at all.
 */
export function changeMask(delta: ArrayLike<number>, fraction: number): Uint8Array {
  const mask = new Uint8Array(delta.length);
  if (delta.length === 0) return mask;

  let largest = 0;
  for (let i = 0; i < delta.length; i++) {
    const value = delta[i] ?? 0;
    if (value > largest) largest = value;
  }
  if (largest <= 0) return mask;

  const clamped = Math.min(1, Math.max(0, Number.isFinite(fraction) ? fraction : 0));
  const threshold = clamped * largest;
  for (let i = 0; i < delta.length; i++) {
    const value = delta[i] ?? 0;
    // Strictly greater, so a fraction of 1 marks nothing rather than marking
    // exactly the single largest cell.
    if (value > threshold) mask[i] = 1;
  }
  return mask;
}
