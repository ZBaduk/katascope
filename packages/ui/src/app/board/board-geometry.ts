/**
 * Board layout arithmetic: pure functions over numbers.
 *
 * Every decision about where a line, stone or label goes lives here, so it can
 * be asserted rather than squinted at. `board-canvas` consumes the results and
 * does nothing but paint them, per CLAUDE.md.
 *
 * Coordinates: `Vertex` is `{x, y}` with the origin at the **top-left**, which
 * is how `Board` stores cells and how KataGo reports policy and ownership.
 * Canvas pixels share that origin, so nothing here flips an axis.
 */

import type { BoardSize, Vertex } from '@katascope/core';

/** A rectangle in CSS pixels. */
export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface Point {
  readonly x: number;
  readonly y: number;
}

export interface BoardLayoutOptions {
  /**
   * Room to leave outside the grid for coordinate labels, as a multiple of the
   * cell size. Zero when coordinates are hidden.
   */
  readonly labelCells?: number;
  /** Extra padding in CSS pixels outside the labels. Defaults to 4. */
  readonly padding?: number;
}

/**
 * Where everything sits for one viewport and board size.
 *
 * `cellSize` is uniform in both axes even on a rectangular board: Go boards are
 * drawn on a square grid, and a 13x9 board is a wide rectangle of square cells,
 * not a square of stretched ones.
 */
export interface BoardLayout {
  readonly size: BoardSize;
  readonly cellSize: number;
  /** Centre of the top-left intersection, in CSS pixels. */
  readonly origin: Point;
  /** Bounding box of the grid lines, from first to last intersection. */
  readonly grid: Rect;
  /** Radius a stone is drawn at. Slightly under half a cell so stones do not touch. */
  readonly stoneRadius: number;
  readonly labelCells: number;
}

/**
 * Fits the largest square-celled grid into `viewport`, centred.
 *
 * Returns a zero-size layout for a degenerate board or viewport rather than
 * dividing by zero -- a caller that has not been laid out yet gets zeros and
 * draws nothing, which is what should happen.
 */
export function boardLayout(
  viewport: { readonly width: number; readonly height: number },
  size: BoardSize,
  options: BoardLayoutOptions = {},
): BoardLayout {
  const labelCells = options.labelCells ?? 0;
  const padding = options.padding ?? 4;

  if (size.width < 1 || size.height < 1 || viewport.width <= 0 || viewport.height <= 0) {
    return {
      size,
      cellSize: 0,
      origin: { x: 0, y: 0 },
      grid: { x: 0, y: 0, width: 0, height: 0 },
      stoneRadius: 0,
      labelCells,
    };
  }

  // The drawing needs half a cell of margin beyond the outermost lines for the
  // stones that sit on them, plus `labelCells` for the coordinates.
  const margin = 1 + 2 * labelCells;
  const cellsWide = size.width - 1 + margin;
  const cellsHigh = size.height - 1 + margin;

  const usableWidth = Math.max(0, viewport.width - 2 * padding);
  const usableHeight = Math.max(0, viewport.height - 2 * padding);
  const cellSize = Math.max(0, Math.min(usableWidth / cellsWide, usableHeight / cellsHigh));

  const gridWidth = (size.width - 1) * cellSize;
  const gridHeight = (size.height - 1) * cellSize;
  const totalWidth = cellsWide * cellSize;
  const totalHeight = cellsHigh * cellSize;

  // Centre the whole drawing, then step in past the margin to the first line.
  const originX = (viewport.width - totalWidth) / 2 + (margin / 2) * cellSize;
  const originY = (viewport.height - totalHeight) / 2 + (margin / 2) * cellSize;

  return {
    size,
    cellSize,
    origin: { x: originX, y: originY },
    grid: { x: originX, y: originY, width: gridWidth, height: gridHeight },
    // 0.48 rather than 0.5: adjacent stones should read as separate discs.
    stoneRadius: cellSize * 0.48,
    labelCells,
  };
}

/** Pixel centre of an intersection. Does not check that the vertex is on the board. */
export function intersectionCenter(layout: BoardLayout, vertex: Vertex): Point {
  return {
    x: layout.origin.x + vertex.x * layout.cellSize,
    y: layout.origin.y + vertex.y * layout.cellSize,
  };
}

/** The square a heatmap cell occupies, centred on its intersection. */
export function intersectionCell(layout: BoardLayout, vertex: Vertex): Rect {
  const centre = intersectionCenter(layout, vertex);
  return {
    x: centre.x - layout.cellSize / 2,
    y: centre.y - layout.cellSize / 2,
    width: layout.cellSize,
    height: layout.cellSize,
  };
}

/**
 * The intersection nearest a point, or `undefined` if the point is not within
 * half a cell of any -- so a click in the outer margin selects nothing rather
 * than snapping to the edge.
 */
export function vertexAtPoint(layout: BoardLayout, point: Point): Vertex | undefined {
  if (layout.cellSize <= 0) return undefined;
  const x = Math.round((point.x - layout.origin.x) / layout.cellSize);
  const y = Math.round((point.y - layout.origin.y) / layout.cellSize);
  if (x < 0 || y < 0 || x >= layout.size.width || y >= layout.size.height) return undefined;

  const centre = intersectionCenter(layout, { x, y });
  const half = layout.cellSize / 2;
  if (Math.abs(point.x - centre.x) > half || Math.abs(point.y - centre.y) > half) return undefined;
  return { x, y };
}

/** GTP column letters. `I` is skipped, as in every Go program since the 1980s. */
const COLUMN_LETTERS = 'ABCDEFGHJKLMNOPQRSTUVWXYZ';

export function columnLabel(x: number): string {
  return COLUMN_LETTERS[x] ?? '?';
}

/** Row labels count up from the bottom, so row 0 of the array is the highest number. */
export function rowLabel(size: BoardSize, y: number): string {
  return String(size.height - y);
}

/**
 * Star points (hoshi) for a board size.
 *
 * Follows the usual convention: 3-3 points on boards up to 11, 4-4 above that,
 * with edge and centre stars only where the board is odd and large enough.
 * Returns nothing for sizes with no accepted convention rather than inventing
 * one -- a wrong star point is worse than none.
 */
export function starPoints(size: BoardSize): readonly Vertex[] {
  const offset = (edge: number): number | undefined => {
    if (edge < 7) return undefined;
    return edge <= 11 ? 2 : 3;
  };
  const dx = offset(size.width);
  const dy = offset(size.height);
  if (dx === undefined || dy === undefined) return [];

  const xs = axisPositions(size.width, dx);
  const ys = axisPositions(size.height, dy);
  const points: Vertex[] = [];
  for (const y of ys) {
    for (const x of xs) points.push({ x, y });
  }
  return points;
}

/** Corner offsets, plus the centre when the axis is odd and big enough for a middle star. */
function axisPositions(length: number, offset: number): number[] {
  const near = offset;
  const far = length - 1 - offset;
  if (far <= near) return [];
  const middle = (length - 1) / 2;
  const hasMiddle = length % 2 === 1 && length >= 13 && middle > near && middle < far;
  return hasMiddle ? [near, middle, far] : [near, far];
}
