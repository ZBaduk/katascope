/** Per-channel statistics, deltas, thresholds and the hide-unused rule. */

import { describe, expect, it } from 'vitest';
import {
  ChannelStatsAccumulator,
  changeMask,
  channelChangeTotals,
  channelDelta,
  channelsByChange,
  maxVariance,
  planeStats,
  unusedChannels,
  type ChannelStats,
} from './channel-stats';

const AREA = 4; // a 2x2 board keeps the arithmetic checkable by hand

/** Two channels of a 2x2 board, channel-major. */
function frame(channel0: readonly number[], channel1: readonly number[]): Float32Array {
  return new Float32Array([...channel0, ...channel1]);
}

describe('ChannelStatsAccumulator', () => {
  it('accumulates across every frame, not per frame', () => {
    // The whole reason the grid normalises per channel across the game: a
    // channel that is loud early and quiet late must not look the same at both.
    const acc = new ChannelStatsAccumulator(2, AREA);
    acc.add(frame([0, 0, 0, 0], [1, 1, 1, 1]));
    acc.add(frame([10, 10, 10, 10], [1, 1, 1, 1]));

    const [loud, quiet] = acc.result();
    expect(loud?.min).toBe(0);
    expect(loud?.max).toBe(10);
    expect(quiet?.min).toBe(1);
    expect(quiet?.max).toBe(1);
  });

  it('computes mean and variance over every sampled value', () => {
    const acc = new ChannelStatsAccumulator(1, AREA);
    acc.add(new Float32Array([1, 2, 3, 4]));
    acc.add(new Float32Array([5, 6, 7, 8]));

    const [stats] = acc.result();
    expect(stats?.mean).toBeCloseTo(4.5, 10);
    // Population variance of 1..8 is 5.25.
    expect(stats?.variance).toBeCloseTo(5.25, 8);
    expect(stats?.stdev).toBeCloseTo(Math.sqrt(5.25), 8);
  });

  it('reports zeros before any frame has been added', () => {
    const stats = new ChannelStatsAccumulator(3, AREA).result();
    expect(stats).toHaveLength(3);
    for (const channel of stats) {
      expect(channel).toMatchObject({ min: 0, max: 0, mean: 0, variance: 0, stdev: 0 });
    }
  });

  it('gives a dead channel exactly zero variance', () => {
    const acc = new ChannelStatsAccumulator(1, AREA);
    acc.add(new Float32Array([0, 0, 0, 0]));
    acc.add(new Float32Array([0, 0, 0, 0]));
    expect(acc.result()[0]?.variance).toBe(0);
    expect(acc.result()[0]?.stdev).toBe(0);
  });

  it('never emits NaN, even for a constant non-zero channel', () => {
    // Cancellation in the sum-of-squares can make variance a tiny negative,
    // and a negative variance becomes NaN through sqrt.
    const acc = new ChannelStatsAccumulator(1, AREA);
    for (let i = 0; i < 50; i++) acc.add(new Float32Array([1e6, 1e6, 1e6, 1e6]));
    const [stats] = acc.result();
    expect(stats?.variance).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(stats?.stdev ?? Number.NaN)).toBe(true);
  });

  it('ignores non-finite values rather than poisoning the whole channel', () => {
    const acc = new ChannelStatsAccumulator(1, AREA);
    acc.add(new Float32Array([1, Number.NaN, 3, Infinity]));
    const [stats] = acc.result();
    expect(stats?.min).toBe(1);
    expect(stats?.max).toBe(3);
  });

  it('handles zero channels without throwing', () => {
    expect(new ChannelStatsAccumulator(0, AREA).result()).toEqual([]);
  });
});

describe('planeStats', () => {
  it('reports min, max and mean', () => {
    expect(planeStats([1, 2, 3, 4])).toMatchObject({ min: 1, max: 4, mean: 2.5 });
  });

  it('reports zero delta with no previous move', () => {
    // Move 0 has nothing to compare against.
    expect(planeStats([1, 2, 3, 4]).delta).toBe(0);
  });

  it('sums the absolute change against the previous move', () => {
    expect(planeStats([1, 2, 3, 4], [1, 0, 5, 4]).delta).toBe(0 + 2 + 2 + 0);
  });

  it('returns zeros for an empty plane', () => {
    expect(planeStats([])).toEqual({ min: 0, max: 0, mean: 0, delta: 0 });
  });

  it('treats non-finite values as zero rather than propagating them', () => {
    const stats = planeStats([Number.NaN, 2], [0, 0]);
    expect(Number.isFinite(stats.mean)).toBe(true);
    expect(stats.delta).toBe(2);
  });
});

describe('channelDelta', () => {
  it('reports per-cell absolute change for one channel', () => {
    const now = frame([1, 2, 3, 4], [0, 0, 0, 0]);
    const before = frame([1, 0, 5, 4], [0, 0, 0, 0]);
    expect([...channelDelta(now, before, 0, AREA)]).toEqual([0, 2, 2, 0]);
  });

  it('reads the right channel out of a channel-major frame', () => {
    const now = frame([0, 0, 0, 0], [9, 9, 9, 9]);
    const before = frame([0, 0, 0, 0], [1, 2, 3, 4]);
    expect([...channelDelta(now, before, 1, AREA)]).toEqual([8, 7, 6, 5]);
  });

  it('returns nothing when there is no previous frame', () => {
    // An invented zero baseline would paint move 0 as "unchanged", which is a
    // claim rather than an absence.
    expect(channelDelta(frame([1, 2, 3, 4], []), undefined, 0, AREA)).toHaveLength(0);
  });
});

describe('channelChangeTotals and channelsByChange', () => {
  it('totals the absolute change per channel', () => {
    const now = frame([1, 1, 1, 1], [5, 5, 5, 5]);
    const before = frame([0, 0, 0, 0], [5, 5, 5, 5]);
    expect([...channelChangeTotals(now, before, 2, AREA)]).toEqual([4, 0]);
  });

  it('orders most-changed first', () => {
    expect(channelsByChange([1, 9, 5])).toEqual([1, 2, 0]);
  });

  it('breaks ties by channel index, so the grid does not reshuffle', () => {
    expect(channelsByChange([3, 3, 3])).toEqual([0, 1, 2]);
  });

  it('degrades to channel order with no previous frame', () => {
    const totals = channelChangeTotals(frame([1, 2, 3, 4], [5, 6, 7, 8]), undefined, 2, AREA);
    expect([...totals]).toEqual([0, 0]);
    expect(channelsByChange(totals)).toEqual([0, 1]);
  });
});

describe('unusedChannels', () => {
  const stats: readonly ChannelStats[] = [
    { channel: 0, min: 0, max: 0, mean: 0, stdev: 0, variance: 0 },
    { channel: 1, min: 0, max: 0.1, mean: 0.01, stdev: 0.02, variance: 0.0004 },
    { channel: 2, min: -3, max: 5, mean: 1, stdev: 2, variance: 4 },
  ];

  it('hides channels below the variance threshold', () => {
    const hidden = unusedChannels(stats, 0.001);
    expect([...hidden]).toEqual([0, 1]);
  });

  it('hides nothing at a zero threshold', () => {
    // Zero means "show everything", not "hide the dead ones".
    expect(unusedChannels(stats, 0).size).toBe(0);
  });

  it('hides everything at a threshold above the largest variance', () => {
    expect(unusedChannels(stats, 100).size).toBe(3);
  });

  it('reports the largest variance, for scaling the slider', () => {
    // A slider in raw variance units is unusable; the control works in a
    // fraction of this.
    expect(maxVariance(stats)).toBe(4);
    expect(maxVariance([])).toBe(0);
  });
});

describe('changeMask', () => {
  it('marks cells whose change exceeds a fraction of the largest', () => {
    // Largest is 10, so a fraction of 0.5 marks anything above 5.
    expect([...changeMask([0, 2, 6, 10], 0.5)]).toEqual([0, 0, 1, 1]);
  });

  it('marks every changed cell at a zero fraction', () => {
    expect([...changeMask([0, 1, 2, 3], 0)]).toEqual([0, 1, 1, 1]);
  });

  it('marks nothing at a fraction of 1', () => {
    // Strictly greater, so the single largest cell is not special-cased in.
    expect([...changeMask([1, 5, 10], 1)]).toEqual([0, 0, 0]);
  });

  it('marks nothing when nothing changed', () => {
    expect([...changeMask([0, 0, 0], 0)]).toEqual([0, 0, 0]);
  });

  it('is relative, so one threshold works across blocks of different magnitude', () => {
    // Trunk magnitudes differ by an order of magnitude between block 0 and 17;
    // an absolute threshold would need retuning for each.
    const small = changeMask([0, 0.05, 0.1], 0.5);
    const large = changeMask([0, 5, 10], 0.5);
    expect([...small]).toEqual([...large]);
  });

  it('clamps an out-of-range fraction rather than producing nonsense', () => {
    expect([...changeMask([1, 2, 3], -5)]).toEqual([1, 1, 1]);
    expect([...changeMask([1, 2, 3], 99)]).toEqual([0, 0, 0]);
    expect([...changeMask([1, 2, 3], Number.NaN)]).toEqual([1, 1, 1]);
  });

  it('returns an empty mask for an empty delta', () => {
    expect(changeMask([], 0.5)).toHaveLength(0);
  });
});
