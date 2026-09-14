/**
 * Board layout arithmetic.
 *
 * The kind of code that is obviously right and quietly off by one, and
 * miserable to verify from a picture -- which is why CLAUDE.md requires it to
 * be pure and tested rather than inlined into a canvas component.
 */

import { squareBoardSize } from '@katascope/core';
import { describe, expect, it } from 'vitest';
import {
  boardLayout,
  columnLabel,
  intersectionCell,
  intersectionCenter,
  rowLabel,
  starPoints,
  vertexAtPoint,
} from './board-geometry';

const NINETEEN = squareBoardSize(19);
const RECT = { width: 13, height: 9 };
const SQUARE_VIEWPORT = { width: 800, height: 800 };

describe('boardLayout', () => {
  it('fits the grid inside the viewport', () => {
    const layout = boardLayout(SQUARE_VIEWPORT, NINETEEN);
    expect(layout.grid.x).toBeGreaterThanOrEqual(0);
    expect(layout.grid.y).toBeGreaterThanOrEqual(0);
    expect(layout.grid.x + layout.grid.width).toBeLessThanOrEqual(SQUARE_VIEWPORT.width);
    expect(layout.grid.y + layout.grid.height).toBeLessThanOrEqual(SQUARE_VIEWPORT.height);
  });

  it('leaves half a cell of margin for the stones on the outer lines', () => {
    const layout = boardLayout(SQUARE_VIEWPORT, NINETEEN);
    expect(layout.origin.x).toBeGreaterThanOrEqual(layout.cellSize / 2);
    expect(layout.origin.y).toBeGreaterThanOrEqual(layout.cellSize / 2);
    const last = intersectionCenter(layout, { x: 18, y: 18 });
    expect(SQUARE_VIEWPORT.width - last.x).toBeGreaterThanOrEqual(layout.cellSize / 2);
  });

  it('centres the board in the viewport', () => {
    const layout = boardLayout(SQUARE_VIEWPORT, NINETEEN);
    const leftGap = layout.grid.x;
    const rightGap = SQUARE_VIEWPORT.width - (layout.grid.x + layout.grid.width);
    expect(leftGap).toBeCloseTo(rightGap, 6);
  });

  it('keeps cells square on a rectangular board', () => {
    // A 13x9 board is a wide rectangle of square cells, not a square of
    // stretched ones. One cellSize, used on both axes.
    const layout = boardLayout(SQUARE_VIEWPORT, RECT);
    expect(layout.grid.width).toBeCloseTo(12 * layout.cellSize, 6);
    expect(layout.grid.height).toBeCloseTo(8 * layout.cellSize, 6);
    expect(layout.grid.width).toBeGreaterThan(layout.grid.height);
  });

  it('is limited by the tighter axis of the viewport', () => {
    const wide = boardLayout({ width: 2000, height: 400 }, NINETEEN);
    const tall = boardLayout({ width: 400, height: 2000 }, NINETEEN);
    expect(wide.cellSize).toBeCloseTo(tall.cellSize, 6);
  });

  it('reserves room for coordinate labels when asked', () => {
    const bare = boardLayout(SQUARE_VIEWPORT, NINETEEN, { labelCells: 0 });
    const labelled = boardLayout(SQUARE_VIEWPORT, NINETEEN, { labelCells: 1 });
    expect(labelled.cellSize).toBeLessThan(bare.cellSize);
    // The labels must fit outside the grid without leaving the viewport.
    expect(labelled.origin.x).toBeGreaterThanOrEqual(labelled.cellSize * 1.5);
  });

  it('returns a zero layout rather than dividing by zero', () => {
    for (const viewport of [
      { width: 0, height: 0 },
      { width: 800, height: 0 },
      { width: -10, height: 100 },
    ]) {
      const layout = boardLayout(viewport, NINETEEN);
      expect(layout.cellSize).toBe(0);
      expect(Number.isFinite(layout.origin.x)).toBe(true);
    }
    expect(boardLayout(SQUARE_VIEWPORT, { width: 0, height: 0 }).cellSize).toBe(0);
  });

  it('gives stones a radius that stops them touching', () => {
    const layout = boardLayout(SQUARE_VIEWPORT, NINETEEN);
    expect(layout.stoneRadius).toBeLessThan(layout.cellSize / 2);
    expect(layout.stoneRadius).toBeGreaterThan(layout.cellSize * 0.4);
  });
});

describe('intersectionCenter', () => {
  it('puts the origin at the top-left intersection', () => {
    const layout = boardLayout(SQUARE_VIEWPORT, NINETEEN);
    expect(intersectionCenter(layout, { x: 0, y: 0 })).toEqual(layout.origin);
  });

  it('steps one cell per intersection, in both axes', () => {
    const layout = boardLayout(SQUARE_VIEWPORT, NINETEEN);
    const a = intersectionCenter(layout, { x: 3, y: 5 });
    const b = intersectionCenter(layout, { x: 4, y: 6 });
    expect(b.x - a.x).toBeCloseTo(layout.cellSize, 6);
    expect(b.y - a.y).toBeCloseTo(layout.cellSize, 6);
  });

  it('increases y downward, matching Board and KataGo row order', () => {
    const layout = boardLayout(SQUARE_VIEWPORT, NINETEEN);
    expect(intersectionCenter(layout, { x: 0, y: 1 }).y).toBeGreaterThan(
      intersectionCenter(layout, { x: 0, y: 0 }).y,
    );
  });
});

describe('intersectionCell', () => {
  it('is a cell-sized square centred on the intersection', () => {
    const layout = boardLayout(SQUARE_VIEWPORT, NINETEEN);
    const centre = intersectionCenter(layout, { x: 4, y: 7 });
    const cell = intersectionCell(layout, { x: 4, y: 7 });
    expect(cell.width).toBeCloseTo(layout.cellSize, 6);
    expect(cell.height).toBeCloseTo(layout.cellSize, 6);
    expect(cell.x + cell.width / 2).toBeCloseTo(centre.x, 6);
    expect(cell.y + cell.height / 2).toBeCloseTo(centre.y, 6);
  });

  it('tiles without gaps or overlap', () => {
    const layout = boardLayout(SQUARE_VIEWPORT, NINETEEN);
    const left = intersectionCell(layout, { x: 2, y: 0 });
    const right = intersectionCell(layout, { x: 3, y: 0 });
    expect(left.x + left.width).toBeCloseTo(right.x, 6);
  });
});

describe('vertexAtPoint', () => {
  it('round-trips: every intersection centre hit-tests back to itself', () => {
    const layout = boardLayout(SQUARE_VIEWPORT, RECT);
    for (let y = 0; y < RECT.height; y++) {
      for (let x = 0; x < RECT.width; x++) {
        expect(vertexAtPoint(layout, intersectionCenter(layout, { x, y }))).toEqual({ x, y });
      }
    }
  });

  it('snaps to the nearest intersection within half a cell', () => {
    const layout = boardLayout(SQUARE_VIEWPORT, NINETEEN);
    const centre = intersectionCenter(layout, { x: 5, y: 5 });
    const nudge = layout.cellSize * 0.4;
    expect(vertexAtPoint(layout, { x: centre.x + nudge, y: centre.y })).toEqual({ x: 5, y: 5 });
    expect(vertexAtPoint(layout, { x: centre.x - nudge, y: centre.y - nudge })).toEqual({ x: 5, y: 5 });
  });

  it('maps a point outside the board to nothing rather than clamping to the edge', () => {
    const layout = boardLayout(SQUARE_VIEWPORT, NINETEEN);
    expect(vertexAtPoint(layout, { x: 0, y: 0 })).toBeUndefined();
    expect(vertexAtPoint(layout, { x: 799, y: 799 })).toBeUndefined();
    const edge = intersectionCenter(layout, { x: 0, y: 0 });
    expect(vertexAtPoint(layout, { x: edge.x - layout.cellSize, y: edge.y })).toBeUndefined();
  });

  it('rejects points on a board that has no size', () => {
    const layout = boardLayout({ width: 0, height: 0 }, NINETEEN);
    expect(vertexAtPoint(layout, { x: 0, y: 0 })).toBeUndefined();
  });

  it('does not drift when the layout is not pixel-aligned', () => {
    // An odd viewport gives a fractional cellSize; the round trip must still
    // land on the right intersection rather than one over.
    const layout = boardLayout({ width: 777, height: 613 }, NINETEEN, { labelCells: 1 });
    for (const vertex of [{ x: 0, y: 0 }, { x: 9, y: 9 }, { x: 18, y: 18 }, { x: 0, y: 18 }]) {
      expect(vertexAtPoint(layout, intersectionCenter(layout, vertex))).toEqual(vertex);
    }
  });
});

describe('coordinate labels', () => {
  it('skips the letter I', () => {
    expect(columnLabel(0)).toBe('A');
    expect(columnLabel(7)).toBe('H');
    expect(columnLabel(8)).toBe('J');
    expect(columnLabel(18)).toBe('T');
  });

  it('numbers rows from the bottom', () => {
    expect(rowLabel(NINETEEN, 0)).toBe('19');
    expect(rowLabel(NINETEEN, 18)).toBe('1');
    expect(rowLabel(RECT, 0)).toBe('9');
  });
});

describe('starPoints', () => {
  it('places the nine stars of a 19x19 board', () => {
    const stars = starPoints(NINETEEN);
    expect(stars).toHaveLength(9);
    expect(stars).toContainEqual({ x: 3, y: 3 });
    expect(stars).toContainEqual({ x: 9, y: 9 });
    expect(stars).toContainEqual({ x: 15, y: 15 });
  });

  it('uses 3-3 points and a centre on a 9x9 board', () => {
    const stars = starPoints(squareBoardSize(9));
    expect(stars).toContainEqual({ x: 2, y: 2 });
    expect(stars).toContainEqual({ x: 6, y: 6 });
    // A 9x9 has corner stars plus tengen, not the 19x19 pattern.
    expect(stars).not.toContainEqual({ x: 3, y: 3 });
  });

  it('handles a rectangular board without inventing a centre it has no room for', () => {
    const stars = starPoints(RECT);
    expect(stars.length).toBeGreaterThan(0);
    for (const star of stars) {
      expect(star.x).toBeGreaterThanOrEqual(0);
      expect(star.x).toBeLessThan(RECT.width);
      expect(star.y).toBeGreaterThanOrEqual(0);
      expect(star.y).toBeLessThan(RECT.height);
    }
  });

  it('returns nothing for boards with no accepted convention', () => {
    // A wrong star point is worse than none.
    expect(starPoints(squareBoardSize(5))).toEqual([]);
    expect(starPoints(squareBoardSize(2))).toEqual([]);
  });
});
