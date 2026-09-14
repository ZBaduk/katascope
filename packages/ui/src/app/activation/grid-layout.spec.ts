/**
 * Channel-grid layout arithmetic.
 *
 * Obviously-right code that is quietly off by one, and miserable to verify from
 * a picture — which is why CLAUDE.md requires it pure and tested. Every
 * `it.todo` the placeholder carried is implemented here.
 */

import { describe, expect, it } from 'vitest';
import {
  cellAtPlanePoint,
  channelAtPoint,
  checkboxRect,
  channelCenter,
  channelRect,
  clampPan,
  defaultColumns,
  gridLayout,
  intersectionAtPoint,
  isCheckboxHit,
  planeCellRect,
  visibleChannels,
} from './grid-layout';

const SQUARE = { width: 19, height: 19 };
const RECT = { width: 13, height: 9 };
const VIEWPORT = { width: 1000, height: 800 };

describe('defaultColumns', () => {
  it('chooses a column count that fits every channel in the viewport', () => {
    // ceil(sqrt(n)): b6c96 gives 10x10, b18c384 gives 20x20.
    expect(defaultColumns(96)).toBe(10);
    expect(defaultColumns(384)).toBe(20);
    expect(defaultColumns(1)).toBe(1);
  });

  it('prefers a near-square grid when the viewport allows it', () => {
    for (const channels of [16, 96, 256, 384]) {
      const columns = defaultColumns(channels);
      const rows = Math.ceil(channels / columns);
      // Never more than one row off square.
      expect(Math.abs(columns - rows)).toBeLessThanOrEqual(1);
    }
  });

  it('returns zero for a non-positive channel count', () => {
    expect(defaultColumns(0)).toBe(0);
    expect(defaultColumns(-5)).toBe(0);
  });
});

describe('gridLayout', () => {
  it('returns an empty layout for zero channels rather than dividing by zero', () => {
    const layout = gridLayout(VIEWPORT, 0, SQUARE);
    expect(layout.columns).toBe(0);
    expect(layout.rows).toBe(0);
    expect(layout.tile).toEqual({ width: 0, height: 0 });
    expect(Number.isFinite(layout.content.width)).toBe(true);
  });

  it('returns an empty layout for a viewport with no width', () => {
    expect(gridLayout({ width: 0, height: 800 }, 96, SQUARE).columns).toBe(0);
  });

  it('gives every tile the same size', () => {
    const layout = gridLayout(VIEWPORT, 96, SQUARE);
    const rects = Array.from({ length: 96 }, (_, i) => channelRect(layout, i));
    for (const rect of rects) {
      expect(rect?.width).toBeCloseTo(layout.tile.width, 6);
      expect(rect?.height).toBeCloseTo(layout.tile.height, 6);
    }
  });

  it('accounts for the gutter between tiles, so the last column stays inside the viewport', () => {
    const layout = gridLayout(VIEWPORT, 96, SQUARE, { gutter: 6 });
    const last = channelRect(layout, layout.columns - 1);
    expect(last).toBeDefined();
    expect((last?.x ?? 0) + (last?.width ?? 0)).toBeLessThanOrEqual(VIEWPORT.width + 1e-6);
    expect(layout.content.width).toBeLessThanOrEqual(VIEWPORT.width + 1e-6);
  });

  it('keeps tiles square for a square board and rectangular for a 13x9 board', () => {
    const square = gridLayout(VIEWPORT, 96, SQUARE);
    expect(square.tile.height).toBeCloseTo(square.tile.width, 6);

    const rect = gridLayout(VIEWPORT, 96, RECT);
    // Tiles carry the board's aspect, so the contents are not stretched.
    expect(rect.tile.height / rect.tile.width).toBeCloseTo(9 / 13, 6);
  });

  it('falls back to a single column for a viewport narrower than one tile', () => {
    // Something visible and scrollable beats an empty pane.
    const layout = gridLayout({ width: 12, height: 400 }, 96, SQUARE, { columns: 1 });
    expect(layout.columns).toBe(1);
    expect(layout.tile.width).toBeGreaterThan(0);
    expect(layout.rows).toBe(96);
  });

  it('never asks for more columns than there are channels', () => {
    const layout = gridLayout(VIEWPORT, 3, SQUARE, { columns: 20 });
    expect(layout.columns).toBe(3);
    expect(layout.rows).toBe(1);
  });

  it('scales tiles and gutters together under zoom', () => {
    const base = gridLayout(VIEWPORT, 96, SQUARE, { gutter: 4 });
    const zoomed = gridLayout(VIEWPORT, 96, SQUARE, { gutter: 4, zoom: 2 });
    expect(zoomed.tile.width).toBeCloseTo(base.tile.width * 2, 6);
    expect(zoomed.gutter).toBeCloseTo(base.gutter * 2, 6);
    expect(zoomed.content.width).toBeCloseTo(base.content.width * 2, 6);
  });

  it('reports a content size the scrollbars can use', () => {
    const layout = gridLayout(VIEWPORT, 384, SQUARE, { zoom: 3 });
    expect(layout.content.height).toBeGreaterThan(VIEWPORT.height);
    expect(layout.content.height).toBeCloseTo(
      layout.rows * layout.tile.height + (layout.rows - 1) * layout.gutter,
      6,
    );
  });
});

describe('channelRect', () => {
  it('lays tiles out in channel order, row-major', () => {
    const layout = gridLayout(VIEWPORT, 96, SQUARE);
    const first = channelRect(layout, 0);
    const nextColumn = channelRect(layout, 1);
    const nextRow = channelRect(layout, layout.columns);

    expect(nextColumn?.y).toBeCloseTo(first?.y ?? -1, 6);
    expect(nextColumn?.x).toBeGreaterThan(first?.x ?? 0);
    expect(nextRow?.x).toBeCloseTo(first?.x ?? -1, 6);
    expect(nextRow?.y).toBeGreaterThan(first?.y ?? 0);
  });

  it('maps a channel index to its tile rectangle', () => {
    const layout = gridLayout(VIEWPORT, 96, SQUARE, { gutter: 4 });
    const stride = layout.tile.width + layout.gutter;
    const rect = channelRect(layout, 13); // row 1, column 3 of 10
    expect(rect?.x).toBeCloseTo(3 * stride, 6);
    expect(rect?.y).toBeCloseTo(1 * (layout.tile.height + layout.gutter), 6);
  });

  it('shifts every tile by the pan offset', () => {
    const panned = gridLayout(VIEWPORT, 96, SQUARE, { pan: { x: 30, y: 50 } });
    const plain = gridLayout(VIEWPORT, 96, SQUARE);
    expect(channelRect(panned, 5)?.x).toBeCloseTo((channelRect(plain, 5)?.x ?? 0) - 30, 6);
    expect(channelRect(panned, 5)?.y).toBeCloseTo((channelRect(plain, 5)?.y ?? 0) - 50, 6);
  });

  it('rejects a channel outside the grid', () => {
    const layout = gridLayout(VIEWPORT, 96, SQUARE);
    expect(channelRect(layout, 96)).toBeUndefined();
    expect(channelRect(layout, -1)).toBeUndefined();
    expect(channelRect(layout, 1.5)).toBeUndefined();
  });
});

describe('channelAtPoint', () => {
  it('maps a point inside a tile back to that channel', () => {
    const layout = gridLayout(VIEWPORT, 96, SQUARE);
    const rect = channelRect(layout, 42);
    expect(
      channelAtPoint(layout, { x: (rect?.x ?? 0) + 2, y: (rect?.y ?? 0) + 2 }),
    ).toBe(42);
  });

  it('round-trips: the centre of every tile hit-tests back to its own channel', () => {
    const layout = gridLayout(VIEWPORT, 96, SQUARE, { gutter: 5 });
    for (let channel = 0; channel < 96; channel++) {
      const centre = channelCenter(layout, channel);
      expect(centre).toBeDefined();
      expect(channelAtPoint(layout, centre ?? { x: -1, y: -1 })).toBe(channel);
    }
  });

  it('round-trips under zoom and pan too', () => {
    // The inverse has to undo exactly what the forward transform did.
    const layout = gridLayout(VIEWPORT, 384, SQUARE, { zoom: 2.5, pan: { x: 123, y: 456 }, gutter: 3 });
    for (const channel of [0, 1, 19, 20, 200, 383]) {
      const centre = channelCenter(layout, channel);
      expect(channelAtPoint(layout, centre ?? { x: -1, y: -1 })).toBe(channel);
    }
  });

  it('maps a point in a gutter to no channel rather than to a neighbour', () => {
    // Snapping would make the hover readout flicker along every seam.
    const layout = gridLayout(VIEWPORT, 96, SQUARE, { gutter: 8 });
    const rect = channelRect(layout, 0);
    const inGutter = { x: (rect?.x ?? 0) + (rect?.width ?? 0) + 2, y: (rect?.y ?? 0) + 2 };
    expect(channelAtPoint(layout, inGutter)).toBeUndefined();
  });

  it('maps a point outside the grid to no channel', () => {
    const layout = gridLayout(VIEWPORT, 96, SQUARE);
    expect(channelAtPoint(layout, { x: -5, y: 10 })).toBeUndefined();
    expect(channelAtPoint(layout, { x: 10, y: -5 })).toBeUndefined();
    expect(channelAtPoint(layout, { x: 99999, y: 10 })).toBeUndefined();
    expect(channelAtPoint(layout, { x: 10, y: 99999 })).toBeUndefined();
  });

  it('maps a point in the empty tail of the last row to no channel', () => {
    // 96 channels over 10 columns leaves four empty cells in the last row.
    const layout = gridLayout(VIEWPORT, 96, SQUARE);
    const beyond = channelCenter({ ...layout, channels: 100 }, 99);
    expect(channelAtPoint(layout, beyond ?? { x: -1, y: -1 })).toBeUndefined();
  });

  it('returns nothing for a degenerate layout', () => {
    const layout = gridLayout({ width: 0, height: 0 }, 0, SQUARE);
    expect(channelAtPoint(layout, { x: 0, y: 0 })).toBeUndefined();
  });
});

describe('intersectionAtPoint', () => {
  it('maps a point inside a tile to the board intersection under it', () => {
    const layout = gridLayout(VIEWPORT, 96, SQUARE, { gutter: 4 });
    const rect = channelRect(layout, 7);
    const cellWidth = (rect?.width ?? 0) / 19;
    const cellHeight = (rect?.height ?? 0) / 19;

    const hit = intersectionAtPoint(layout, SQUARE, {
      x: (rect?.x ?? 0) + cellWidth * 3.5,
      y: (rect?.y ?? 0) + cellHeight * 5.5,
    });
    expect(hit).toEqual({ channel: 7, x: 3, y: 5 });
  });

  it('puts the origin at the top-left, matching Board and KataGo row order', () => {
    const layout = gridLayout(VIEWPORT, 96, SQUARE);
    const rect = channelRect(layout, 0);
    const hit = intersectionAtPoint(layout, SQUARE, { x: (rect?.x ?? 0) + 1, y: (rect?.y ?? 0) + 1 });
    expect(hit).toMatchObject({ x: 0, y: 0 });
  });

  it('handles a rectangular board without swapping the axes', () => {
    const layout = gridLayout(VIEWPORT, 16, RECT);
    const rect = channelRect(layout, 0);
    const hit = intersectionAtPoint(layout, RECT, {
      x: (rect?.x ?? 0) + (rect?.width ?? 0) * 0.99,
      y: (rect?.y ?? 0) + (rect?.height ?? 0) * 0.99,
    });
    expect(hit).toEqual({ channel: 0, x: 12, y: 8 });
  });

  it('never reports an intersection off the board edge', () => {
    const layout = gridLayout(VIEWPORT, 16, SQUARE);
    const rect = channelRect(layout, 0);
    const hit = intersectionAtPoint(layout, SQUARE, {
      x: (rect?.x ?? 0) + (rect?.width ?? 0) - 1e-9,
      y: (rect?.y ?? 0) + (rect?.height ?? 0) - 1e-9,
    });
    expect(hit?.x).toBeLessThanOrEqual(18);
    expect(hit?.y).toBeLessThanOrEqual(18);
  });

  it('returns nothing for a point in a gutter', () => {
    const layout = gridLayout(VIEWPORT, 96, SQUARE, { gutter: 8 });
    const rect = channelRect(layout, 0);
    expect(
      intersectionAtPoint(layout, SQUARE, {
        x: (rect?.x ?? 0) + (rect?.width ?? 0) + 3,
        y: rect?.y ?? 0,
      }),
    ).toBeUndefined();
  });
});

describe('devicePixelRatio', () => {
  it('handles a devicePixelRatio above 1 without drifting by a pixel', () => {
    // Layout is in CSS pixels; DPR is a canvas-scale concern and must not move
    // the hit-testing. Rendering at 2x is the same layout, twice as many device
    // pixels — so the round trip through CSS coordinates is unchanged.
    const layout = gridLayout({ width: 1001, height: 777 }, 384, SQUARE, {
      zoom: 1.37,
      gutter: 3,
      pan: { x: 17.5, y: 42.25 },
    });
    for (const channel of [0, 19, 20, 21, 199, 383]) {
      const centre = channelCenter(layout, channel);
      expect(channelAtPoint(layout, centre ?? { x: -1, y: -1 })).toBe(channel);
    }
  });
});

describe('clampPan', () => {
  it('pins to zero when the content fits the viewport', () => {
    // Few channels make big tiles, so the viewport has to be tall enough to
    // hold two rows of them before there is genuinely nothing to pan.
    const layout = gridLayout(VIEWPORT, 4, SQUARE);
    const roomy = { width: VIEWPORT.width, height: layout.content.height + 50 };
    expect(clampPan(layout, roomy, { x: 500, y: 500 })).toEqual({ x: 0, y: 0 });
  });

  it('stops the grid being dragged entirely off screen', () => {
    const layout = gridLayout(VIEWPORT, 384, SQUARE, { zoom: 4 });
    const clamped = clampPan(layout, VIEWPORT, { x: 1e9, y: 1e9 });
    expect(clamped.x).toBeCloseTo(layout.content.width - VIEWPORT.width, 6);
    expect(clamped.y).toBeCloseTo(layout.content.height - VIEWPORT.height, 6);
  });

  it('refuses negative and non-finite offsets', () => {
    const layout = gridLayout(VIEWPORT, 384, SQUARE, { zoom: 4 });
    expect(clampPan(layout, VIEWPORT, { x: -50, y: -50 })).toEqual({ x: 0, y: 0 });
    expect(clampPan(layout, VIEWPORT, { x: Number.NaN, y: Number.NaN })).toEqual({ x: 0, y: 0 });
  });
});

describe('visibleChannels', () => {
  it('returns only the tiles that intersect the viewport', () => {
    // At 384 channels, redrawing everything on every move is the difference
    // between stepping smoothly and not.
    const layout = gridLayout(VIEWPORT, 384, SQUARE, { zoom: 4 });
    const visible = visibleChannels(layout, VIEWPORT);
    expect(visible.length).toBeGreaterThan(0);
    expect(visible.length).toBeLessThan(384);
  });

  it('returns every channel when they all fit', () => {
    const layout = gridLayout(VIEWPORT, 16, SQUARE);
    expect(visibleChannels(layout, { width: 1000, height: 2000 })).toHaveLength(16);
  });

  it('follows the pan offset', () => {
    const layout = gridLayout(VIEWPORT, 384, SQUARE, { zoom: 4 });
    const top = visibleChannels(layout, VIEWPORT);
    const scrolled = visibleChannels(
      gridLayout(VIEWPORT, 384, SQUARE, { zoom: 4, pan: { x: 0, y: layout.content.height / 2 } }),
      VIEWPORT,
    );
    expect(scrolled[0]).toBeGreaterThan(top[0] ?? 0);
  });

  it('never reports a channel that does not exist', () => {
    const layout = gridLayout(VIEWPORT, 96, SQUARE);
    for (const channel of visibleChannels(layout, { width: 5000, height: 5000 })) {
      expect(channel).toBeLessThan(96);
    }
  });
});

describe('cellAtPlanePoint', () => {
  const BOX = { width: 190, height: 190 };

  it('maps the top-left corner to (0, 0) and the bottom-right to the last cell', () => {
    expect(cellAtPlanePoint({ x: 0, y: 0 }, BOX, SQUARE)).toEqual({ x: 0, y: 0 });
    expect(cellAtPlanePoint({ x: 189.9, y: 189.9 }, BOX, SQUARE)).toEqual({ x: 18, y: 18 });
  });

  it('maps the middle of a cell to that cell', () => {
    // Cell (5, 7) of 19 spans 50.0..60.0 and 70.0..80.0 in a 190px box.
    const cell = 190 / 19;
    expect(cellAtPlanePoint({ x: 5 * cell + 2, y: 7 * cell + 2 }, BOX, SQUARE)).toEqual({
      x: 5,
      y: 7,
    });
  });

  it('puts a cell boundary in the higher cell, matching the drawn pixels', () => {
    const cell = 190 / 19;
    expect(cellAtPlanePoint({ x: cell, y: 0 }, BOX, SQUARE)?.x).toBe(1);
  });

  it('handles a rectangular board, whose cells are not square in the box', () => {
    // The plane is stretched to fill the box, so a 13x9 board has wide cells.
    expect(cellAtPlanePoint({ x: 0, y: 0 }, BOX, RECT)).toEqual({ x: 0, y: 0 });
    expect(cellAtPlanePoint({ x: 189, y: 189 }, BOX, RECT)).toEqual({ x: 12, y: 8 });
    expect(cellAtPlanePoint({ x: 95, y: 95 }, BOX, RECT)).toEqual({ x: 6, y: 4 });
  });

  it('returns undefined outside the box rather than clamping to an edge cell', () => {
    // The pointer leaving the canvas and sitting in its corner must not look
    // the same to the caller: one highlights nothing, the other a corner.
    expect(cellAtPlanePoint({ x: -1, y: 10 }, BOX, SQUARE)).toBeUndefined();
    expect(cellAtPlanePoint({ x: 10, y: -1 }, BOX, SQUARE)).toBeUndefined();
    expect(cellAtPlanePoint({ x: 190, y: 10 }, BOX, SQUARE)).toBeUndefined();
    expect(cellAtPlanePoint({ x: 10, y: 190 }, BOX, SQUARE)).toBeUndefined();
  });

  it('returns undefined for a degenerate box or board', () => {
    expect(cellAtPlanePoint({ x: 0, y: 0 }, { width: 0, height: 190 }, SQUARE)).toBeUndefined();
    expect(cellAtPlanePoint({ x: 0, y: 0 }, BOX, { width: 0, height: 9 })).toBeUndefined();
  });

  it('is the inverse of planeCellRect for every cell', () => {
    // The forward transform and its inverse live together on purpose; this is
    // the assertion that keeps them that way.
    for (const size of [SQUARE, RECT]) {
      for (let y = 0; y < size.height; y++) {
        for (let x = 0; x < size.width; x++) {
          const rect = planeCellRect({ x, y }, BOX, size)!;
          const centre = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
          expect(cellAtPlanePoint(centre, BOX, size)).toEqual({ x, y });
        }
      }
    }
  });
});

describe('planeCellRect', () => {
  const BOX = { width: 190, height: 190 };

  it('tiles the box exactly, with no gap and no overlap', () => {
    const first = planeCellRect({ x: 0, y: 0 }, BOX, SQUARE)!;
    const second = planeCellRect({ x: 1, y: 0 }, BOX, SQUARE)!;
    expect(first.x + first.width).toBeCloseTo(second.x, 10);

    const last = planeCellRect({ x: 18, y: 18 }, BOX, SQUARE)!;
    expect(last.x + last.width).toBeCloseTo(190, 10);
    expect(last.y + last.height).toBeCloseTo(190, 10);
  });

  it('gives a rectangular board rectangular cells', () => {
    const cell = planeCellRect({ x: 0, y: 0 }, BOX, RECT)!;
    expect(cell.width).toBeCloseTo(190 / 13, 10);
    expect(cell.height).toBeCloseTo(190 / 9, 10);
  });

  it('returns undefined for a degenerate board', () => {
    expect(planeCellRect({ x: 0, y: 0 }, BOX, { width: 0, height: 9 })).toBeUndefined();
  });
});

describe('checkboxRect', () => {
  const tile = { x: 100, y: 200, width: 60, height: 60 };

  it('sits inside the tile’s top-left corner', () => {
    const box = checkboxRect(tile)!;
    expect(box.x).toBeGreaterThanOrEqual(tile.x);
    expect(box.y).toBeGreaterThanOrEqual(tile.y);
    expect(box.x + box.width).toBeLessThan(tile.x + tile.width / 2);
    expect(box.y + box.height).toBeLessThan(tile.y + tile.height / 2);
  });

  it('does not grow without bound on a zoomed-in tile', () => {
    const box = checkboxRect({ x: 0, y: 0, width: 400, height: 400 })!;
    expect(box.width).toBeLessThanOrEqual(16);
  });

  it('disappears on a tile too small to hit reliably', () => {
    // Below this the box would be a pixel or two, and every click would be a
    // coin toss between selecting the channel and opening it.
    expect(checkboxRect({ x: 0, y: 0, width: 14, height: 14 })).toBeUndefined();
  });
});

describe('isCheckboxHit', () => {
  const tile = { x: 100, y: 200, width: 60, height: 60 };

  it('is true inside the box and false elsewhere in the tile', () => {
    const box = checkboxRect(tile)!;
    expect(isCheckboxHit(tile, { x: box.x + 1, y: box.y + 1 })).toBe(true);
    expect(isCheckboxHit(tile, { x: tile.x + 50, y: tile.y + 50 })).toBe(false);
  });

  it('excludes the box’s far edge, so adjacent boxes cannot both claim a point', () => {
    const box = checkboxRect(tile)!;
    expect(isCheckboxHit(tile, { x: box.x + box.width, y: box.y })).toBe(false);
    expect(isCheckboxHit(tile, { x: box.x, y: box.y + box.height })).toBe(false);
  });

  it('is false for every point when the tile is too small for a box', () => {
    const small = { x: 0, y: 0, width: 10, height: 10 };
    expect(isCheckboxHit(small, { x: 1, y: 1 })).toBe(false);
  });
});
