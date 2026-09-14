/**
 * Activation normalization and thresholding.
 *
 * Pure functions, per CLAUDE.md, because a number is testable and a painted
 * pixel is not. Every `it.todo` the placeholder carried is implemented here.
 */

import { dequantize, type ActivationFrame } from '@katascope/core';
import { describe, expect, it } from 'vitest';
import {
  normalizePlane,
  percentileRange,
  planeRange,
  symmetricRange,
  toFloatPlane,
} from './normalization';

function uint8Frame(range: { min: number; max: number }): ActivationFrame {
  return {
    moveNumber: 0,
    block: 0,
    networkName: 'test',
    boardSize: { width: 2, height: 2 },
    channels: 1,
    dtype: 'uint8',
    data: new Uint8Array([0, 85, 170, 255]),
    range,
  };
}

describe('planeRange', () => {
  it('reports the plane extent', () => {
    expect(planeRange([1, -2, 5, 0])).toEqual({ min: -2, max: 5 });
  });

  it('returns a zero range for an empty plane rather than infinities', () => {
    expect(planeRange([])).toEqual({ min: 0, max: 0 });
  });

  it('ignores non-finite values', () => {
    expect(planeRange([1, Number.NaN, 3, Infinity])).toEqual({ min: 1, max: 3 });
  });
});

describe('normalizePlane', () => {
  it('maps a plane onto 0..1 using the frame range', () => {
    // The frame range, not the plane's own: a quiet channel must look quiet
    // rather than being stretched to full contrast.
    const out = normalizePlane([0, 5, 10], { range: { min: 0, max: 20 } });
    expect([...out]).toEqual([0, 0.25, 0.5]);
  });

  it('maps onto 0..1 using a per-plane range when asked, not the frame range', () => {
    const out = normalizePlane([0, 5, 10]);
    expect([...out]).toEqual([0, 0.5, 1]);
  });

  it('returns all zeros for a flat plane instead of dividing by a zero span', () => {
    expect([...normalizePlane([3, 3, 3])]).toEqual([0, 0, 0]);
    expect([...normalizePlane([3, 3, 3], { range: { min: 7, max: 7 } })]).toEqual([0, 0, 0]);
  });

  it('handles a negative range, as a pre-activation tensor would have', () => {
    const out = normalizePlane([-10, -5, 0], { range: { min: -10, max: 0 } });
    expect([...out]).toEqual([0, 0.5, 1]);
  });

  it('is symmetric about zero under diverging normalization, so the neutral colour lands on zero', () => {
    // -8..2 becomes -8..8, so 0 must land exactly halfway whatever the skew.
    const out = normalizePlane([-8, 0, 2], { range: { min: -8, max: 2 }, mode: 'diverging' });
    expect(out[0]).toBeCloseTo(0, 6);
    expect(out[1]).toBeCloseTo(0.5, 6);
    expect(out[2]).toBeCloseTo(0.625, 6);
  });

  it('clips to a percentile range so one outlier cannot flatten the whole plane', () => {
    const plane = [...Array.from({ length: 99 }, (_, i) => i / 98), 1000];
    const withOutlier = normalizePlane(plane);
    const clipped = normalizePlane(plane, { percentile: 0.98 });

    // Without clipping every real value is crushed into the bottom thousandth.
    expect(withOutlier[50] ?? 0).toBeLessThan(0.01);
    expect(clipped[50] ?? 0).toBeGreaterThan(0.4);
  });

  it('leaves values inside the percentile range untouched', () => {
    const plane = [0, 0.25, 0.5, 0.75, 1];
    const clipped = normalizePlane(plane, { percentile: 1 });
    expect([...clipped]).toEqual([0, 0.25, 0.5, 0.75, 1]);
  });

  it('zeroes values below an absolute threshold', () => {
    const out = normalizePlane([0, 1, 5, 10], { range: { min: 0, max: 10 }, threshold: 2 });
    expect(out[0]).toBe(0);
    expect(out[1]).toBe(0); // |1| < 2
    expect(out[2]).toBeCloseTo(0.5, 6);
    expect(out[3]).toBeCloseTo(1, 6);
  });

  it('zeroes values below a relative threshold expressed as a fraction of the max', () => {
    const out = normalizePlane([1, 3, 9], {
      range: { min: 0, max: 10 },
      threshold: 0.25,
      relativeThreshold: true,
    });
    // 25% of 10 is 2.5, so 1 goes and 3 stays.
    expect(out[0]).toBe(0);
    expect(out[1]).toBeCloseTo(0.3, 6);
    expect(out[2]).toBeCloseTo(0.9, 6);
  });

  it('treats a zero threshold as no thresholding at all', () => {
    const plain = normalizePlane([0.001, 0.5, 1], { range: { min: 0, max: 1 } });
    const zeroed = normalizePlane([0.001, 0.5, 1], { range: { min: 0, max: 1 }, threshold: 0 });
    expect([...zeroed]).toEqual([...plain]);
    expect(zeroed[0]).toBeGreaterThan(0);
  });

  it('never emits NaN or Infinity, whatever the input range', () => {
    const inputs: number[][] = [
      [Number.NaN, 1, 2],
      [Infinity, -Infinity, 0],
      [0, 0, 0],
      [],
    ];
    for (const plane of inputs) {
      for (const value of normalizePlane(plane)) {
        expect(Number.isFinite(value)).toBe(true);
      }
    }
    for (const value of normalizePlane([1, 2, 3], { range: { min: Number.NaN, max: 1 } })) {
      expect(Number.isFinite(value)).toBe(true);
    }
  });

  it('does not mutate the input plane', () => {
    const plane = new Float32Array([3, 1, 2]);
    const before = [...plane];
    normalizePlane(plane, { percentile: 0.5, threshold: 1 });
    expect([...plane]).toEqual(before);
  });

  it('clamps values outside an explicit range instead of overflowing 0..1', () => {
    const out = normalizePlane([-5, 15], { range: { min: 0, max: 10 } });
    expect(out[0]).toBe(0);
    expect(out[1]).toBe(1);
  });
});

describe('toFloatPlane', () => {
  it('dequantises a uint8 plane back through the frame range before normalising', () => {
    const frame = uint8Frame({ min: -2, max: 2 });
    const floats = toFloatPlane(frame, frame.data);
    expect(floats[0]).toBeCloseTo(-2, 5);
    expect(floats[3]).toBeCloseTo(2, 5);
    // 170/255 of the way from -2 to 2.
    expect(floats[2]).toBeCloseTo(-2 + (170 / 255) * 4, 4);
  });

  it('agrees with dequantize() from @katascope/core on the endpoints', () => {
    const frame = uint8Frame({ min: -1.5, max: 6.25 });
    const floats = toFloatPlane(frame, frame.data);
    for (const [i, stored] of [...frame.data].entries()) {
      expect(floats[i]).toBeCloseTo(dequantize(frame, stored), 4);
    }
  });

  it('passes a float32 plane through without copying it', () => {
    const frame: ActivationFrame = {
      ...uint8Frame({ min: 0, max: 1 }),
      dtype: 'float32',
      data: new Float32Array([1, 2, 3, 4]),
    };
    expect(toFloatPlane(frame, frame.data)).toBe(frame.data);
  });
});

describe('symmetricRange', () => {
  it('widens to the larger magnitude', () => {
    expect(symmetricRange({ min: -8, max: 2 })).toEqual({ min: -8, max: 8 });
    expect(symmetricRange({ min: -1, max: 9 })).toEqual({ min: -9, max: 9 });
  });

  it('leaves an already-symmetric range alone', () => {
    expect(symmetricRange({ min: -4, max: 4 })).toEqual({ min: -4, max: 4 });
  });
});

describe('percentileRange', () => {
  it('drops the tails', () => {
    const plane = Array.from({ length: 101 }, (_, i) => i);
    const range = percentileRange(plane, 0.98);
    expect(range.min).toBeGreaterThan(0);
    expect(range.max).toBeLessThan(100);
  });

  it('returns the full range when nothing is clipped', () => {
    expect(percentileRange([0, 5, 10], 1)).toEqual({ min: 0, max: 10 });
  });

  it('does not mutate the input', () => {
    const plane = [3, 1, 2];
    percentileRange(plane, 0.5);
    expect(plane).toEqual([3, 1, 2]);
  });
});
