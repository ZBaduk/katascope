/** Policy selection and ownership colour mapping. */

import { squareBoardSize } from '@katascope/core';
import { describe, expect, it } from 'vitest';
import { formatPolicyPercent, ownershipFill, topPolicyMoves } from './overlays';

const SIZE = { width: 3, height: 2 }; // area 6, policy length 7
const NINETEEN = squareBoardSize(19);

/** Builds a policy vector for the small board; index 6 is pass. */
function policy(values: readonly number[]): number[] {
  return [...values];
}

describe('topPolicyMoves', () => {
  it('returns the most likely moves, highest first', () => {
    const moves = topPolicyMoves(policy([0.05, 0.4, 0.1, 0.2, 0.15, 0.05, 0.05]), SIZE, 3);
    expect(moves.map((m) => m.probability)).toEqual([0.4, 0.2, 0.15]);
    expect(moves.map((m) => m.rank)).toEqual([0, 1, 2]);
  });

  it('maps an index to the right intersection, row-major from the top-left', () => {
    const moves = topPolicyMoves(policy([0, 0, 0, 0, 0.9, 0, 0]), SIZE, 1);
    // Index 4 on a 3-wide board is x=1, y=1.
    expect(moves[0]?.vertex).toEqual({ x: 1, y: 1 });
  });

  it('drops illegal moves rather than treating -1 as a probability', () => {
    const moves = topPolicyMoves(policy([-1, 0.5, -1, 0.3, 0.2, -1, 0]), SIZE, 5);
    expect(moves.map((m) => m.probability)).toEqual([0.5, 0.3, 0.2]);
  });

  it('drops legal moves with no meaningful probability', () => {
    // A marker at 1e-9 is noise the user has to learn to ignore.
    const moves = topPolicyMoves(policy([0.9, 1e-9, 1e-12, 0, 0, 0, 0]), SIZE, 5);
    expect(moves).toHaveLength(1);
    expect(moves[0]?.vertex).toEqual({ x: 0, y: 0 });
  });

  it('honours an explicit probability floor', () => {
    const moves = topPolicyMoves(policy([0.5, 0.02, 0.01, 0, 0, 0, 0]), SIZE, 5, {
      minProbability: 0.015,
    });
    expect(moves.map((m) => m.probability)).toEqual([0.5, 0.02]);
  });

  it('reports pass with no vertex, since it has no place on the board', () => {
    const moves = topPolicyMoves(policy([0.1, 0, 0, 0, 0, 0, 0.9]), SIZE, 2);
    expect(moves[0]?.vertex).toBeUndefined();
    expect(moves[0]?.probability).toBe(0.9);
    expect(moves[1]?.vertex).toEqual({ x: 0, y: 0 });
  });

  it('breaks ties by position, so markers do not jump between equal moves', () => {
    const first = topPolicyMoves(policy([0.3, 0.3, 0.3, 0, 0, 0, 0]), SIZE, 2);
    const again = topPolicyMoves(policy([0.3, 0.3, 0.3, 0, 0, 0, 0]), SIZE, 2);
    expect(first.map((m) => m.vertex)).toEqual([{ x: 0, y: 0 }, { x: 1, y: 0 }]);
    expect(again.map((m) => m.vertex)).toEqual(first.map((m) => m.vertex));
  });

  it('returns fewer than n when fewer qualify', () => {
    expect(topPolicyMoves(policy([0.6, 0.4, -1, -1, -1, -1, 0]), SIZE, 10)).toHaveLength(2);
  });

  it('returns nothing for a non-positive n', () => {
    expect(topPolicyMoves(policy([0.9, 0, 0, 0, 0, 0, 0]), SIZE, 0)).toEqual([]);
    expect(topPolicyMoves(policy([0.9, 0, 0, 0, 0, 0, 0]), SIZE, -1)).toEqual([]);
  });

  it('handles an empty policy without throwing', () => {
    expect(topPolicyMoves([], SIZE, 3)).toEqual([]);
  });

  it('reads a full 19x19 policy correctly', () => {
    const full = new Array<number>(NINETEEN.width * NINETEEN.height + 1).fill(0);
    full[3 * 19 + 15] = 0.42; // Q16
    const moves = topPolicyMoves(full, NINETEEN, 1);
    expect(moves[0]?.vertex).toEqual({ x: 15, y: 3 });
    expect(moves[0]?.probability).toBe(0.42);
  });
});

describe('ownershipFill', () => {
  it('is transparent at neutral, so an undecided point does not obscure the board', () => {
    const fill = ownershipFill(0);
    expect(fill.strength).toBe(0);
    expect(fill.color).toContain('0.000');
  });

  it('grows more opaque with certainty', () => {
    expect(ownershipFill(1).strength).toBe(1);
    expect(ownershipFill(0.5).strength).toBe(0.5);
    expect(ownershipFill(-0.5).strength).toBe(0.5);
  });

  it('uses different hues for the two sides', () => {
    const mine = ownershipFill(0.8).color;
    const theirs = ownershipFill(-0.8).color;
    expect(mine).not.toBe(theirs);
    // Same magnitude, so the alpha matches and only the hue differs.
    expect(mine.split(',').at(-1)).toBe(theirs.split(',').at(-1));
  });

  it('never exceeds the configured maximum alpha', () => {
    for (const value of [-1, -0.3, 0, 0.3, 1]) {
      const alpha = Number(ownershipFill(value, { maxAlpha: 0.5 }).color.split(',').at(-1)?.replace(')', ''));
      expect(alpha).toBeLessThanOrEqual(0.5);
    }
  });

  it('clamps out-of-range values instead of failing a render', () => {
    expect(ownershipFill(5).strength).toBe(1);
    expect(ownershipFill(-5).strength).toBe(1);
    expect(ownershipFill(Number.NaN).strength).toBe(0);
  });

  it('emits a colour a canvas accepts', () => {
    expect(ownershipFill(0.42).color).toMatch(/^rgba\(\d+, \d+, \d+, \d\.\d{3}\)$/);
  });
});

describe('formatPolicyPercent', () => {
  it('drops decimals above 10%, which would not fit in a stone', () => {
    expect(formatPolicyPercent(0.371)).toBe('37%');
    expect(formatPolicyPercent(1)).toBe('100%');
  });

  it('keeps one decimal between 1% and 10%', () => {
    expect(formatPolicyPercent(0.0416)).toBe('4.2%');
  });

  it('keeps two decimals below 1%', () => {
    expect(formatPolicyPercent(0.0042)).toBe('0.42%');
  });

  it('returns nothing for a value that is not a probability', () => {
    expect(formatPolicyPercent(-1)).toBe('');
    expect(formatPolicyPercent(Number.NaN)).toBe('');
  });
});
