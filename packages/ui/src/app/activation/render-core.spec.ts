/** Colouring a frame: light-to-dark, per-channel ranges, and the change overlay. */

import { describe, expect, it } from 'vitest';
import { accumulateStats, renderFrame } from './render-core';
import type { RenderOptions } from './render-protocol';

const AREA = 4;

function options(over: Partial<RenderOptions> = {}): RenderOptions {
  return { channels: 1, area: AREA, stats: [], ...over };
}

/** Grey level of cell `i` of channel `c`. */
function shade(rgba: Uint8ClampedArray, channel: number, i: number): number {
  return rgba[(channel * AREA + i) * 4] ?? -1;
}

function alpha(rgba: Uint8ClampedArray, channel: number, i: number): number {
  return rgba[(channel * AREA + i) * 4 + 3] ?? -1;
}

describe('renderFrame', () => {
  it('maps values light to dark', () => {
    const { rgba } = renderFrame(new Float32Array([0, 0.5, 1, 1]), undefined, options());
    // Quiet is near-white, loud is near-black: ink on paper, not false colour.
    expect(shade(rgba, 0, 0)).toBeGreaterThan(shade(rgba, 0, 1));
    expect(shade(rgba, 0, 1)).toBeGreaterThan(shade(rgba, 0, 2));
    expect(shade(rgba, 0, 0)).toBe(255);
  });

  it('writes fully opaque pixels', () => {
    const { rgba } = renderFrame(new Float32Array([0, 1, 0, 1]), undefined, options());
    for (let i = 0; i < AREA; i++) expect(alpha(rgba, 0, i)).toBe(255);
  });

  it('writes grey, not colour, where nothing changed', () => {
    const { rgba } = renderFrame(new Float32Array([0, 0.5, 1, 0.25]), undefined, options());
    for (let i = 0; i < AREA; i++) {
      const at = i * 4;
      expect(rgba[at]).toBe(rgba[at + 1]);
      expect(rgba[at + 1]).toBe(rgba[at + 2]);
    }
  });

  it('normalises per channel across the game when stats are given', () => {
    // Two channels with the same plane but different game-wide ranges must not
    // look the same: that is the whole reason stats exist.
    const data = new Float32Array([1, 1, 1, 1, 1, 1, 1, 1]);
    const { rgba } = renderFrame(
      data,
      undefined,
      options({
        channels: 2,
        stats: [
          { channel: 0, min: 0, max: 1, mean: 0, stdev: 0, variance: 0 },
          { channel: 1, min: 0, max: 100, mean: 0, stdev: 0, variance: 0 },
        ],
      }),
    );
    expect(shade(rgba, 0, 0)).toBeLessThan(shade(rgba, 1, 0));
  });

  it('falls back to per-plane scaling with no stats', () => {
    const { rgba } = renderFrame(new Float32Array([0, 10, 20, 30]), undefined, options());
    expect(shade(rgba, 0, 0)).toBe(255);
    expect(shade(rgba, 0, 3)).toBe(20); // 255 - 235
  });

  it('collapses hidden channels to a flat dark tile', () => {
    const data = new Float32Array([0, 1, 0, 1, 0, 1, 0, 1]);
    const { rgba } = renderFrame(data, undefined, options({ channels: 2, hidden: [1] }));
    const first = shade(rgba, 1, 0);
    for (let i = 1; i < AREA; i++) expect(shade(rgba, 1, i)).toBe(first);
    // Dark and obviously not data, so a hidden channel cannot be mistaken for
    // a quiet one -- and the tile still occupies its slot, so the grid does not
    // reflow when the slider moves.
    expect(first).toBeLessThan(60);
    expect(shade(rgba, 0, 0)).toBeGreaterThan(first);
  });

  it('tints cells whose change exceeds the threshold', () => {
    const now = new Float32Array([0, 0, 1, 1]);
    const before = new Float32Array([0, 0, 0, 1]);
    const { rgba } = renderFrame(now, before, options({ changeFraction: 0.5 }));
    const at = 2 * 4;
    // Index 2 changed by 1 (the largest), so it is tinted: red channel clearly
    // above green and blue.
    expect(rgba[at]).toBeGreaterThan((rgba[at + 1] ?? 0) + 20);
    const unchanged = 3 * 4;
    expect(rgba[unchanged]).toBe(rgba[unchanged + 1]);
  });

  it('tints nothing without a previous frame', () => {
    const { rgba } = renderFrame(new Float32Array([0, 1, 0, 1]), undefined, options({ changeFraction: 0 }));
    for (let i = 0; i < AREA; i++) {
      const at = i * 4;
      expect(rgba[at]).toBe(rgba[at + 1]);
    }
  });

  it('reports each channel total change, for the sort toggle', () => {
    const now = new Float32Array([1, 1, 1, 1, 0, 0, 0, 0]);
    const before = new Float32Array([0, 0, 0, 0, 0, 0, 0, 0]);
    const { changes } = renderFrame(now, before, options({ channels: 2 }));
    expect([...changes]).toEqual([4, 0]);
  });

  it('writes pixels in board order, so index i is (x = i % width, y = floor(i / width))', () => {
    // The buffer is handed to ImageData with the board's width, so this mapping
    // is what puts a plane the right way up. Pinned rather than inferred from a
    // screenshot: a transposed plane still looks like a plausible heatmap.
    const width = 4;
    const height = 2;
    const area = width * height;
    const plane = new Float32Array(area);
    plane[1 * width + 3] = 1; // x = 3, y = 1
    const { rgba } = renderFrame(plane, undefined, { channels: 1, area, stats: [] });

    const index = 1 * width + 3;
    for (let i = 0; i < area; i++) {
      const value = rgba[i * 4] ?? 0;
      if (i === index) expect(value).toBeLessThan(60); // the loud cell is dark
      else expect(value).toBe(255); // everything else is paper
    }
  });

  it('returns an empty buffer for a degenerate frame', () => {
    expect(renderFrame(new Float32Array(0), undefined, options({ channels: 0 })).rgba).toHaveLength(0);
    expect(renderFrame(new Float32Array(0), undefined, options({ area: 0 })).rgba).toHaveLength(0);
  });

  it('produces a buffer the right size for a real net', () => {
    const channels = 96;
    const area = 361;
    const data = new Float32Array(channels * area);
    const { rgba } = renderFrame(data, undefined, { channels, area, stats: [] });
    expect(rgba).toHaveLength(channels * area * 4);
  });
});

describe('accumulateStats', () => {
  it('folds frames into per-channel statistics', () => {
    const stats = accumulateStats(
      [new Float32Array([0, 0, 0, 0]), new Float32Array([4, 4, 4, 4])],
      1,
      AREA,
    );
    expect(stats[0]).toMatchObject({ min: 0, max: 4, mean: 2 });
  });

  it('returns zeroed stats for no frames', () => {
    expect(accumulateStats([], 2, AREA)).toHaveLength(2);
  });
});
