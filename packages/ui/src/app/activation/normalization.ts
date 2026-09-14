/**
 * Turning activation values into something drawable.
 *
 * Pure, per CLAUDE.md: `(plane, options) => numbers`. No canvas, no injector,
 * no component. A heatmap cannot be verified by looking at it, so the decisions
 * live here where they can be asserted.
 *
 * Two ideas run through this file:
 *
 * * **Which range to normalise against.** Per-plane makes each channel legible
 *   on its own but destroys any comparison between channels or between moves --
 *   a channel that goes quiet looks identical to one that never moved. The
 *   Diagnostics grid therefore normalises **per channel across the whole game**,
 *   which is what `ChannelStats` carries.
 * * **Outliers.** One extreme cell flattens everything else to a single tone.
 *   Percentile clipping bounds that without discarding the value.
 */

import { dequantize, type ActivationFrame, type PlaneBuffer } from '@katascope/core';

/** A min/max pair to normalise against. */
export interface ValueRange {
  readonly min: number;
  readonly max: number;
}

export type NormalizationMode =
  /** `min..max` maps to `0..1`. */
  | 'linear'
  /**
   * Symmetric about zero: `-m..m` maps to `0..1` where `m` is the larger
   * magnitude, so zero always lands on 0.5 and the neutral colour means
   * "nothing here" rather than "somewhere in the middle of this plane".
   */
  | 'diverging';

export interface NormalizeOptions {
  /** Range to scale against. Defaults to the plane's own min and max. */
  readonly range?: ValueRange;
  readonly mode?: NormalizationMode;
  /**
   * Clip to this central fraction before scaling, e.g. `0.98` keeps the 1st to
   * 99th percentile. `1` (the default) clips nothing.
   */
  readonly percentile?: number;
  /** Values whose magnitude is below this become exactly 0 after scaling. */
  readonly threshold?: number;
  /**
   * Treat `threshold` as a fraction of the range's largest magnitude rather
   * than an absolute value.
   */
  readonly relativeThreshold?: boolean;
}

/** The plane's own extent, ignoring any frame-level range. */
export function planeRange(plane: ArrayLike<number>): ValueRange {
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < plane.length; i++) {
    const value = plane[i] ?? 0;
    if (!Number.isFinite(value)) continue;
    if (value < min) min = value;
    if (value > max) max = value;
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) return { min: 0, max: 0 };
  return { min, max };
}

/**
 * Scales a plane onto 0..1.
 *
 * Never returns NaN or Infinity: a non-finite input becomes 0, and a zero-width
 * range yields all zeros rather than dividing by it. A single NaN in a heatmap
 * paints one transparent cell that reads as a rendering bug rather than as data.
 *
 * The input is never mutated.
 */
export function normalizePlane(
  plane: ArrayLike<number>,
  options: NormalizeOptions = {},
): Float32Array {
  const mode = options.mode ?? 'linear';
  const base = options.range ?? planeRange(plane);
  const clipped = options.percentile === undefined || options.percentile >= 1
    ? base
    : percentileRange(plane, options.percentile, base);

  const range = mode === 'diverging' ? symmetricRange(clipped) : clipped;
  const span = range.max - range.min;
  const out = new Float32Array(plane.length);
  // A non-finite span -- from a caller passing NaN bounds -- must yield zeros,
  // not NaN. One NaN cell paints as a hole and reads as a renderer bug.
  if (!Number.isFinite(span) || span <= 0) return out;

  const threshold = resolveThreshold(options, range);

  for (let i = 0; i < plane.length; i++) {
    const raw = plane[i] ?? 0;
    const value = Number.isFinite(raw) ? raw : 0;
    if (threshold > 0 && Math.abs(value) < threshold) continue; // already 0
    const scaled = (Math.min(range.max, Math.max(range.min, value)) - range.min) / span;
    out[i] = scaled;
  }
  return out;
}

/** Widens a range to be symmetric about zero, for diverging colour maps. */
export function symmetricRange(range: ValueRange): ValueRange {
  const magnitude = Math.max(Math.abs(range.min), Math.abs(range.max));
  return { min: -magnitude, max: magnitude };
}

/**
 * The central `fraction` of a plane's values.
 *
 * Sorts a copy, so the input is untouched. `fraction` is the proportion kept:
 * 0.98 drops the top and bottom 1%.
 */
export function percentileRange(
  plane: ArrayLike<number>,
  fraction: number,
  fallback?: ValueRange,
): ValueRange {
  if (plane.length === 0) return fallback ?? { min: 0, max: 0 };
  const kept = Math.min(1, Math.max(0, fraction));
  if (kept >= 1) return fallback ?? planeRange(plane);

  const sorted = Array.from(plane, (v) => (Number.isFinite(v) ? v : 0)).sort((a, b) => a - b);
  const tail = (1 - kept) / 2;
  // Count the values to drop from each end rather than interpolating a
  // quantile index: rounding the index outwards kept the very outlier the
  // clipping exists to remove.
  const drop = Math.min(Math.floor(sorted.length * tail), Math.floor((sorted.length - 1) / 2));
  return { min: sorted[drop] ?? 0, max: sorted[sorted.length - 1 - drop] ?? 0 };
}

function resolveThreshold(options: NormalizeOptions, range: ValueRange): number {
  const threshold = options.threshold ?? 0;
  if (threshold <= 0) return 0;
  if (options.relativeThreshold !== true) return threshold;
  return threshold * Math.max(Math.abs(range.min), Math.abs(range.max));
}

/**
 * A frame's channel as float values, undoing uint8 quantisation if needed.
 *
 * `@katascope/core`'s `dequantize` is the authority on that mapping; this walks
 * the plane with it rather than re-deriving the formula.
 */
export function toFloatPlane(frame: ActivationFrame, plane: PlaneBuffer): Float32Array {
  if (frame.dtype === 'float32') {
    return plane instanceof Float32Array ? plane : Float32Array.from(plane);
  }
  const out = new Float32Array(plane.length);
  for (let i = 0; i < plane.length; i++) out[i] = Math.fround(dequantize(frame, plane[i] ?? 0));
  return out;
}
