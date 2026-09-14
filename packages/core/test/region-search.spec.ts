/**
 * Scoring for the region search.
 *
 * These are the functions that decide whether a channel "responds to" a region,
 * which is a claim the UI cannot check and the reader cannot eyeball. A grid of
 * heatmaps looks plausible whatever the scores say, so the arithmetic is only
 * ever as trustworthy as this file.
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SPECIFIC_THRESHOLD,
  FakeActivationStore,
  PLANTED_CHANNELS,
  planeRegionScore,
  plantedRegion,
  prepareRegion,
  qualifyingDirection,
  rankHits,
  searchFrame,
  squareBoardSize,
  summariseHits,
  type BoardSize,
  type RegionHit,
  type RegionQuery,
} from '../src/index.js';

const SIZE: BoardSize = squareBoardSize(19);

/** A plane that is `hot` on the region cells and `cold` everywhere else. */
function planeWith(size: BoardSize, region: readonly number[], hot: number, cold: number): Float32Array {
  const plane = new Float32Array(size.width * size.height).fill(cold);
  for (const index of region) plane[index] = hot;
  return plane;
}

describe('prepareRegion', () => {
  it('resolves vertices to plane offsets', () => {
    const region = prepareRegion(SIZE, [
      { x: 0, y: 0 },
      { x: 3, y: 2 },
    ]);
    expect([...region.cells]).toEqual([0, 2 * 19 + 3]);
    expect(region.area).toBe(361);
    expect(region.mask[0]).toBe(1);
    expect(region.mask[2 * 19 + 3]).toBe(1);
    expect(region.mask[1]).toBe(0);
  });

  it('drops duplicates and off-board vertices', () => {
    const region = prepareRegion(SIZE, [
      { x: 1, y: 1 },
      { x: 1, y: 1 },
      { x: -1, y: 0 },
      { x: 19, y: 0 },
      { x: 0, y: 19 },
    ]);
    expect([...region.cells]).toEqual([20]);
  });

  it('sorts cells ascending regardless of click order', () => {
    const region = prepareRegion(SIZE, [
      { x: 5, y: 5 },
      { x: 0, y: 0 },
    ]);
    expect([...region.cells]).toEqual([0, 5 * 19 + 5]);
  });
});

describe('planeRegionScore', () => {
  it('scores a plane that is high exactly on the region', () => {
    const region = prepareRegion(SIZE, [
      { x: 3, y: 3 },
      { x: 4, y: 3 },
    ]);
    const plane = planeWith(SIZE, [...region.cells], 5, 0);
    const score = planeRegionScore(plane, region);

    // Both region cells sit far above a plane whose mean is near zero.
    expect(score.high).toBeGreaterThan(5);
    expect(score.regionMeanZ).toBeGreaterThan(5);
    // The mirror score: the region's highest point is not low.
    expect(score.low).toBeLessThan(0);
    expect(score.outsideMeanAbsZ).toBeLessThan(DEFAULT_SPECIFIC_THRESHOLD);
  });

  it('scores a plane that is low exactly on the region', () => {
    const region = prepareRegion(SIZE, [{ x: 3, y: 3 }]);
    const plane = planeWith(SIZE, [...region.cells], 0, 5);
    const score = planeRegionScore(plane, region);

    expect(score.low).toBeGreaterThan(5);
    expect(score.high).toBeLessThan(0);
    expect(score.regionMeanZ).toBeLessThan(-5);
  });

  it('takes the region minimum, so one hot point cannot carry a cold one', () => {
    const cells = [3 * 19 + 3, 3 * 19 + 4];
    const region = prepareRegion(SIZE, [
      { x: 3, y: 3 },
      { x: 4, y: 3 },
    ]);
    const plane = new Float32Array(361);
    plane[cells[0] ?? 0] = 20; // blazing
    plane[cells[1] ?? 0] = 0; // dead

    const score = planeRegionScore(plane, region);
    // The mean would be strongly positive; the minimum is what decides.
    expect(score.regionMeanZ).toBeGreaterThan(0);
    expect(score.high).toBeLessThan(0);
  });

  it('gives a dead plane a score of zero rather than NaN or infinity', () => {
    const region = prepareRegion(SIZE, [{ x: 3, y: 3 }]);
    const score = planeRegionScore(new Float32Array(361), region);

    expect(Number.isNaN(score.high)).toBe(false);
    expect(score.high).toBe(0);
    expect(score.low).toBe(0);
    expect(score.regionMeanZ).toBe(0);
  });

  it('gives a constant non-zero plane a score of zero too', () => {
    const region = prepareRegion(SIZE, [{ x: 3, y: 3 }]);
    const score = planeRegionScore(new Float32Array(361).fill(7), region);
    expect(score.high).toBe(0);
  });

  it('refuses an empty region rather than matching everything', () => {
    const region = prepareRegion(SIZE, []);
    const score = planeRegionScore(new Float32Array(361).fill(1), region);
    // `min` over an empty set is +Infinity, which would qualify every channel.
    expect(score.high).toBe(Number.NEGATIVE_INFINITY);
    expect(score.low).toBe(Number.NEGATIVE_INFINITY);
  });

  it('treats a whole-board region as having no quiet elsewhere', () => {
    const all = [];
    for (let y = 0; y < 19; y++) for (let x = 0; x < 19; x++) all.push({ x, y });
    const region = prepareRegion(SIZE, all);
    const score = planeRegionScore(new Float32Array(361).fill(1), region);
    expect(score.outsideMeanAbsZ).toBe(Number.POSITIVE_INFINITY);
  });

  it('ignores non-finite values rather than poisoning the statistics', () => {
    const region = prepareRegion(SIZE, [{ x: 3, y: 3 }]);
    const plane = planeWith(SIZE, [3 * 19 + 3], 5, 0);
    plane[0] = Number.NaN;
    const score = planeRegionScore(plane, region);
    expect(Number.isFinite(score.high)).toBe(true);
    expect(score.high).toBeGreaterThan(5);
  });

  it('is scale invariant: multiplying a plane leaves the score unchanged', () => {
    const region = prepareRegion(SIZE, [
      { x: 3, y: 3 },
      { x: 4, y: 4 },
    ]);
    const cells = [...region.cells];
    const small = planeRegionScore(planeWith(SIZE, cells, 0.5, 0.01), region);
    const large = planeRegionScore(planeWith(SIZE, cells, 500, 10), region);
    // This is the whole reason for z-normalising: one threshold has to mean the
    // same thing at block 0 and block 17, whose magnitudes differ ten-fold.
    expect(large.high).toBeCloseTo(small.high, 4);
  });
});

describe('qualifyingDirection', () => {
  const base: RegionQuery = { direction: 'either', threshold: 2 };

  it('accepts a high plane in high and either, rejects it in low', () => {
    const score = { high: 3, low: -3, regionMeanZ: 3, outsideMeanAbsZ: 0.1 };
    expect(qualifyingDirection(score, { ...base, direction: 'high' })).toBe('high');
    expect(qualifyingDirection(score, { ...base, direction: 'either' })).toBe('high');
    expect(qualifyingDirection(score, { ...base, direction: 'low' })).toBeUndefined();
  });

  it('accepts a low plane in low and either', () => {
    const score = { high: -3, low: 3, regionMeanZ: -3, outsideMeanAbsZ: 0.1 };
    expect(qualifyingDirection(score, { ...base, direction: 'low' })).toBe('low');
    expect(qualifyingDirection(score, { ...base, direction: 'either' })).toBe('low');
    expect(qualifyingDirection(score, { ...base, direction: 'high' })).toBeUndefined();
  });

  it('rejects a plane below the threshold', () => {
    const score = { high: 1.9, low: -1.9, regionMeanZ: 1.9, outsideMeanAbsZ: 0.1 };
    expect(qualifyingDirection(score, base)).toBeUndefined();
  });

  it('accepts a plane exactly at the threshold', () => {
    const score = { high: 2, low: -2, regionMeanZ: 2, outsideMeanAbsZ: 0.1 };
    expect(qualifyingDirection(score, base)).toBe('high');
  });

  it('picks the stronger direction when both qualify', () => {
    const score = { high: 2.5, low: 4, regionMeanZ: 0, outsideMeanAbsZ: 0.1 };
    expect(qualifyingDirection(score, base)).toBe('low');
  });

  it('rejects a channel that is loud outside the region when specific is set', () => {
    const score = { high: 5, low: -5, regionMeanZ: 5, outsideMeanAbsZ: 0.9 };
    expect(qualifyingDirection(score, base)).toBe('high');
    expect(
      qualifyingDirection(score, { ...base, specific: true, specificThreshold: 0.5 }),
    ).toBeUndefined();
    expect(
      qualifyingDirection(score, { ...base, specific: true, specificThreshold: 1 }),
    ).toBe('high');
  });
});

describe('searchFrame', () => {
  const region = prepareRegion(SIZE, [
    { x: 3, y: 3 },
    { x: 4, y: 3 },
  ]);

  /** Three channels: one responds to the region, two do not. */
  function frameData(): Float32Array {
    const area = 361;
    const data = new Float32Array(3 * area);
    data.set(planeWith(SIZE, [...region.cells], 6, 0), 0); // responds
    data.set(new Float32Array(area).fill(3), area); // flat
    data.set(planeWith(SIZE, [0, 1], 6, 0), 2 * area); // responds elsewhere
    return data;
  }

  it('returns only the channels that qualify', () => {
    const hits = searchFrame(
      { moveNumber: 4, block: 1, channels: 3, data: frameData() },
      region,
      { direction: 'high', threshold: 2 },
    );
    expect(hits.map((hit) => hit.channel)).toEqual([0]);
    expect(hits[0]?.moveNumber).toBe(4);
    expect(hits[0]?.block).toBe(1);
    expect(hits[0]?.direction).toBe('high');
  });

  it('returns nothing for an empty region', () => {
    const hits = searchFrame(
      { moveNumber: 0, block: 0, channels: 3, data: frameData() },
      prepareRegion(SIZE, []),
      { direction: 'either', threshold: 0 },
    );
    expect(hits).toEqual([]);
  });

  it('stops at the channels the buffer actually holds', () => {
    // A store that served a narrower frame than the spec advertises must not
    // make this read past the end and score whatever it finds.
    const hits = searchFrame(
      { moveNumber: 0, block: 0, channels: 99, data: frameData() },
      region,
      { direction: 'high', threshold: 2 },
    );
    expect(hits.every((hit) => hit.channel < 3)).toBe(true);
  });
});

describe('rankHits', () => {
  it('orders by score, breaking ties by move then block then channel', () => {
    const hits: RegionHit[] = [
      { moveNumber: 5, block: 1, channel: 9, direction: 'high', score: 3, regionMeanZ: 0, outsideMeanAbsZ: 0 },
      { moveNumber: 2, block: 0, channel: 1, direction: 'high', score: 7, regionMeanZ: 0, outsideMeanAbsZ: 0 },
      { moveNumber: 1, block: 0, channel: 4, direction: 'low', score: 3, regionMeanZ: 0, outsideMeanAbsZ: 0 },
    ];
    expect(rankHits(hits).map((hit) => hit.score)).toEqual([7, 3, 3]);
    expect(rankHits(hits).map((hit) => hit.moveNumber)).toEqual([2, 1, 5]);
  });

  it('does not mutate its input', () => {
    const hits: RegionHit[] = [
      { moveNumber: 1, block: 0, channel: 0, direction: 'high', score: 1, regionMeanZ: 0, outsideMeanAbsZ: 0 },
      { moveNumber: 2, block: 0, channel: 0, direction: 'high', score: 9, regionMeanZ: 0, outsideMeanAbsZ: 0 },
    ];
    rankHits(hits);
    expect(hits[0]?.score).toBe(1);
  });
});

describe('summariseHits', () => {
  const hit = (moveNumber: number, channel: number, score: number): RegionHit => ({
    moveNumber,
    block: 2,
    channel,
    direction: 'high',
    score,
    regionMeanZ: score,
    outsideMeanAbsZ: 0.1,
  });

  it('counts the moves each channel qualified on', () => {
    const summaries = summariseHits([hit(1, 5, 3), hit(2, 5, 4), hit(3, 9, 8)]);
    expect(summaries.map((s) => [s.channel, s.moves])).toEqual([
      [5, 2],
      [9, 1],
    ]);
  });

  it('ranks a persistent channel above a single better hit', () => {
    // The whole reason the summary exists: one spectacular score is usually the
    // position, and a channel that keeps qualifying is the finding.
    const summaries = summariseHits([hit(1, 5, 3), hit(2, 5, 3), hit(3, 9, 99)]);
    expect(summaries[0]?.channel).toBe(5);
    expect(summaries[1]?.channel).toBe(9);
  });

  it('keeps the best score and the move it came from', () => {
    const summaries = summariseHits([hit(1, 5, 3), hit(7, 5, 11), hit(9, 5, 4)]);
    expect(summaries[0]?.bestScore).toBe(11);
    expect(summaries[0]?.bestMoveNumber).toBe(7);
  });

  it('keeps channels of different blocks apart', () => {
    const summaries = summariseHits([hit(1, 5, 3), { ...hit(1, 5, 3), block: 4 }]);
    expect(summaries).toHaveLength(2);
  });

  it('returns nothing for no hits', () => {
    expect(summariseHits([])).toEqual([]);
  });
});

describe('the planted channels in FakeActivationStore', () => {
  it('finds every planted channel on its own region', async () => {
    const store = new FakeActivationStore();
    const { spec } = await store.describe();
    const region = prepareRegion(spec.boardSize, plantedRegion(spec.boardSize));
    const frame = await store.frame({ moveNumber: 12, block: 2 });

    const hits = searchFrame(
      {
        moveNumber: 12,
        block: 2,
        channels: frame.channels,
        data: frame.data,
      },
      region,
      { direction: 'either', threshold: 3, specific: true },
    );

    const found = new Map(hits.map((hit) => [hit.channel, hit.direction]));
    for (const planted of PLANTED_CHANNELS) {
      expect(found.get(planted.channel)).toBe(planted.direction);
    }
    await store.dispose();
  });

  it('finds them at every block and move, since they are planted throughout', async () => {
    const store = new FakeActivationStore();
    const { spec } = await store.describe();
    const region = prepareRegion(spec.boardSize, plantedRegion(spec.boardSize));

    for (const block of [0, 3, spec.blocks - 1]) {
      for (const moveNumber of [0, 7, 40]) {
        const frame = await store.frame({ moveNumber, block });
        const hits = searchFrame(
          { moveNumber, block, channels: frame.channels, data: frame.data },
          region,
          { direction: 'either', threshold: 3 },
        );
        const channels = new Set(hits.map((hit) => hit.channel));
        for (const planted of PLANTED_CHANNELS) {
          expect(channels.has(planted.channel)).toBe(true);
        }
      }
    }
    await store.dispose();
  });

  it('does not plant on a region the search is not asking about', async () => {
    const store = new FakeActivationStore();
    const frame = await store.frame({ moveNumber: 3, block: 1 });
    // A region far from the planted square: the planted channels are flat
    // there, so they must not qualify.
    const elsewhere = prepareRegion(squareBoardSize(19), [
      { x: 15, y: 15 },
      { x: 16, y: 15 },
    ]);
    const hits = searchFrame(
      { moveNumber: 3, block: 1, channels: frame.channels, data: frame.data },
      elsewhere,
      { direction: 'high', threshold: 3, specific: true },
    );
    const channels = new Set(hits.map((hit) => hit.channel));
    expect(channels.has(7)).toBe(false);
    expect(channels.has(23)).toBe(false);
    await store.dispose();
  });

  it('leaves a three-channel net unplanted, so the .kact fixture is unchanged', async () => {
    // `fixtures/kact/tiny-b2c3.kact` is compared byte for byte by the codec
    // tests; planting inside its channel range would rewrite it.
    const store = new FakeActivationStore({
      spec: { name: 'tiny-b2c3', blocks: 2, channels: 3, boardSize: squareBoardSize(5) },
      seed: 20_260_914,
    });
    const frame = await store.frame({ moveNumber: 0, block: 0 });
    expect(frame.channels).toBe(3);
    // Planted planes peak at 5; the ordinary generator never gets near it.
    expect(Math.max(...frame.data)).toBeLessThan(PLANTED_LEVEL_FLOOR);
    await store.dispose();
  });
});

/** Below the planted level, above anything the noise generator produces. */
const PLANTED_LEVEL_FLOOR = 5;
