/**
 * The arithmetic behind a grid repaint.
 *
 * Runs in the worker normally and on the main thread when a worker cannot be
 * constructed. One implementation either way, so the fallback cannot drift from
 * the fast path — and so all of it is testable without a worker at all.
 *
 * Values map **light to dark**: a quiet cell is near-white and a loud one near
 * black, which reads as ink on paper rather than as a false-colour map, and
 * leaves saturated colour free to mean something. It means one thing here: red,
 * for a cell that changed sharply since the previous move.
 */

import { ChannelStatsAccumulator, changeMask, channelDelta, type ChannelStats } from './channel-stats';
import { channelImpact, channelMagnitudes } from './ordering';
import { normalizePlane } from './normalization';
import type { RenderOptions } from './render-protocol';

/** A collapsed tile for a hidden channel: dark, flat, and obviously not data. */
const HIDDEN_RGB = [26, 28, 34] as const;

/** Red tint for a cell that changed more than the threshold allows. */
const CHANGE_RGB = [222, 68, 58] as const;

/**
 * Head tints for the last block, applied as a faint wash over the whole tile.
 *
 * Faint on purpose: this says which head reads the channel, which is a property
 * of the weights and not of the position, so it must not compete with the
 * activations it sits behind.
 */
const LEAN_RGB: Readonly<Record<string, readonly [number, number, number]>> = {
  policy: [80, 200, 140],
  value: [160, 130, 245],
};
const LEAN_STRENGTH = 0.16;

export interface RenderResult {
  readonly rgba: Uint8ClampedArray;
  readonly changes: Float64Array;
  readonly impact: Float64Array;
}

/**
 * Paints every channel of a frame into one RGBA buffer, channel-major.
 *
 * Returns the buffer plus each channel's total change, so the caller can sort
 * by it without a second pass over the data.
 */
export function renderFrame(
  data: ArrayLike<number>,
  previous: ArrayLike<number> | undefined,
  options: RenderOptions,
): RenderResult {
  const { channels, area } = options;
  const rgba = new Uint8ClampedArray(Math.max(0, channels * area * 4));
  const changes = new Float64Array(Math.max(0, channels));
  if (channels <= 0 || area <= 0) {
    return { rgba, changes, impact: new Float64Array(Math.max(0, channels)) };
  }
  // Computed here rather than on the main thread: the expensive half is summing
  // |activation| over every cell of every channel.
  const impact = channelImpact(channelMagnitudes(data, channels, area), options.readerNorms);

  const hidden = new Set(options.hidden ?? []);
  const statsByChannel = new Map(options.stats.map((s) => [s.channel, s]));

  for (let channel = 0; channel < channels; channel++) {
    const pixelBase = channel * area * 4;

    if (hidden.has(channel)) {
      for (let i = 0; i < area; i++) {
        const at = pixelBase + i * 4;
        rgba[at] = HIDDEN_RGB[0];
        rgba[at + 1] = HIDDEN_RGB[1];
        rgba[at + 2] = HIDDEN_RGB[2];
        rgba[at + 3] = 255;
      }
      continue;
    }

    const planeBase = channel * area;
    const plane = sliceOf(data, planeBase, area);
    const stats = statsByChannel.get(channel);
    // Per channel across the whole game when stats are available. Without them
    // each plane is scaled to itself, which is legible but not comparable.
    // Diverging for signed data (attribution planes), otherwise the channel's
    // range across the whole game when it is known.
    const normalized = options.diverging === true
      ? normalizePlane(plane, { mode: 'diverging' })
      : normalizePlane(plane, stats === undefined ? {} : { range: { min: stats.min, max: stats.max } });

    const delta = previous === undefined ? new Float32Array(0) : channelDelta(data, previous, channel, area);
    let total = 0;
    for (let i = 0; i < delta.length; i++) total += delta[i] ?? 0;
    changes[channel] = total;

    const mask =
      options.changeFraction === undefined || delta.length === 0
        ? undefined
        : changeMask(delta, options.changeFraction);

    const lean = options.leans?.[channel];
    const tint = lean === undefined ? undefined : LEAN_RGB[lean];

    for (let i = 0; i < area; i++) {
      const intensity = normalized[i] ?? 0;
      // Light to dark: 0 is paper, 1 is ink.
      const shade = Math.round(255 - intensity * 235);
      const at = pixelBase + i * 4;
      if (mask?.[i] === 1) {
        // Blend toward red in proportion to the value, so a changed-but-quiet
        // cell still reads as quiet.
        const blend = 0.35 + 0.65 * intensity;
        rgba[at] = Math.round(shade * (1 - blend) + CHANGE_RGB[0] * blend);
        rgba[at + 1] = Math.round(shade * (1 - blend) + CHANGE_RGB[1] * blend);
        rgba[at + 2] = Math.round(shade * (1 - blend) + CHANGE_RGB[2] * blend);
      } else if (tint !== undefined) {
        rgba[at] = Math.round(shade * (1 - LEAN_STRENGTH) + tint[0] * LEAN_STRENGTH);
        rgba[at + 1] = Math.round(shade * (1 - LEAN_STRENGTH) + tint[1] * LEAN_STRENGTH);
        rgba[at + 2] = Math.round(shade * (1 - LEAN_STRENGTH) + tint[2] * LEAN_STRENGTH);
      } else {
        rgba[at] = shade;
        rgba[at + 1] = shade;
        rgba[at + 2] = shade;
      }
      rgba[at + 3] = 255;
    }
  }

  return { rgba, changes, impact };
}

/** Folds frames into per-channel statistics. Thin wrapper, kept for symmetry. */
export function accumulateStats(
  frames: readonly ArrayLike<number>[],
  channels: number,
  area: number,
): readonly ChannelStats[] {
  const accumulator = new ChannelStatsAccumulator(channels, area);
  for (const frame of frames) accumulator.add(frame);
  return accumulator.result();
}

function sliceOf(data: ArrayLike<number>, offset: number, length: number): Float32Array {
  if (data instanceof Float32Array) return data.subarray(offset, offset + length);
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) out[i] = data[offset + i] ?? 0;
  return out;
}
