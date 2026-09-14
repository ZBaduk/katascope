/**
 * Layout arithmetic for the channel grid.
 *
 * Given a viewport, a channel count and a board size, work out the tile grid,
 * each tile's rectangle, and the inverse — which channel, and which board
 * intersection, is under a point. Pure numbers, per CLAUDE.md: the canvas code
 * consumes these and does nothing else.
 *
 * A b18c384 net puts 384 tiles on screen at once, so the grid pans and zooms.
 * Zoom and pan are part of the layout rather than a canvas transform because
 * hit-testing has to invert them, and an inverse that lives somewhere else from
 * the forward transform is an inverse that drifts.
 */

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

export interface Size {
  readonly width: number;
  readonly height: number;
}

export interface GridLayoutOptions {
  /** Gap between tiles in CSS pixels at zoom 1. Defaults to 4. */
  readonly gutter?: number;
  /** Scale factor. 1 fits the grid to the viewport width. */
  readonly zoom?: number;
  /** Scroll offset in CSS pixels, applied after zoom. */
  readonly pan?: Point;
  /** Explicit column count. Defaults to `ceil(sqrt(channels))`. */
  readonly columns?: number;
}

export interface GridLayout {
  readonly channels: number;
  readonly columns: number;
  readonly rows: number;
  /** Tile size in CSS pixels, including zoom. Cells are the board's aspect. */
  readonly tile: Size;
  readonly gutter: number;
  readonly zoom: number;
  readonly pan: Point;
  /** Total extent of the laid-out grid, for scrollbar sizing. */
  readonly content: Size;
}

/**
 * Columns for a channel count: `ceil(sqrt(n))`.
 *
 * b6c96 gives 10 columns for 96 channels, b18c384 gives 20 for 384 — near
 * square, which keeps the whole grid reachable without scrolling in one axis
 * far more than the other.
 */
export function defaultColumns(channels: number): number {
  if (!Number.isFinite(channels) || channels <= 0) return 0;
  return Math.ceil(Math.sqrt(channels));
}

/**
 * Lays out `channels` tiles across `viewport`.
 *
 * Tiles keep the board's aspect ratio, so a 13x9 net's channels are wide
 * rectangles rather than squares with stretched contents. Returns a zero
 * layout for zero channels or a degenerate viewport rather than dividing by
 * zero — a component that has not been measured yet draws nothing.
 */
export function gridLayout(
  viewport: Size,
  channels: number,
  board: Size,
  options: GridLayoutOptions = {},
): GridLayout {
  const gutter = options.gutter ?? 4;
  const zoom = options.zoom ?? 1;
  const pan = options.pan ?? { x: 0, y: 0 };

  const requested = options.columns ?? defaultColumns(channels);
  const columns = Math.max(0, Math.min(requested, Math.max(0, channels)));

  if (
    channels <= 0 ||
    columns <= 0 ||
    viewport.width <= 0 ||
    board.width <= 0 ||
    board.height <= 0 ||
    zoom <= 0
  ) {
    return {
      channels: Math.max(0, channels),
      columns: 0,
      rows: 0,
      tile: { width: 0, height: 0 },
      gutter,
      zoom,
      pan,
      content: { width: 0, height: 0 },
    };
  }

  const rows = Math.ceil(channels / columns);

  // Fit the columns across the viewport at zoom 1, gutters included. The last
  // column has no gutter after it, so there are `columns - 1` of them.
  const available = viewport.width - gutter * (columns - 1);
  // A viewport narrower than one tile still gets a tile: something visible and
  // scrollable beats an empty pane.
  const baseWidth = Math.max(1, available / columns);
  const tileWidth = baseWidth * zoom;
  const tileHeight = tileWidth * (board.height / board.width);
  const scaledGutter = gutter * zoom;

  return {
    channels,
    columns,
    rows,
    tile: { width: tileWidth, height: tileHeight },
    gutter: scaledGutter,
    zoom,
    pan,
    content: {
      width: columns * tileWidth + (columns - 1) * scaledGutter,
      height: rows * tileHeight + (rows - 1) * scaledGutter,
    },
  };
}

/** The rectangle tile `channel` occupies, pan included. */
export function channelRect(layout: GridLayout, channel: number): Rect | undefined {
  if (!Number.isInteger(channel) || channel < 0 || channel >= layout.channels) return undefined;
  if (layout.columns <= 0) return undefined;

  const column = channel % layout.columns;
  const row = Math.floor(channel / layout.columns);
  return {
    x: column * (layout.tile.width + layout.gutter) - layout.pan.x,
    y: row * (layout.tile.height + layout.gutter) - layout.pan.y,
    width: layout.tile.width,
    height: layout.tile.height,
  };
}

/**
 * The channel under a point, or `undefined` in a gutter or outside the grid.
 *
 * A point in a gutter belongs to no tile. Snapping it to the nearer neighbour
 * would make the hover readout flicker between two channels along every seam.
 */
export function channelAtPoint(layout: GridLayout, point: Point): number | undefined {
  if (layout.columns <= 0 || layout.tile.width <= 0 || layout.tile.height <= 0) return undefined;

  const x = point.x + layout.pan.x;
  const y = point.y + layout.pan.y;
  if (x < 0 || y < 0) return undefined;

  const strideX = layout.tile.width + layout.gutter;
  const strideY = layout.tile.height + layout.gutter;
  const column = Math.floor(x / strideX);
  const row = Math.floor(y / strideY);
  if (column >= layout.columns || row >= layout.rows) return undefined;

  // Inside the cell's stride but past the tile means the gutter.
  if (x - column * strideX >= layout.tile.width) return undefined;
  if (y - row * strideY >= layout.tile.height) return undefined;

  const channel = row * layout.columns + column;
  return channel < layout.channels ? channel : undefined;
}

/**
 * The board intersection under a point within a tile.
 *
 * Returns `undefined` when the point is not on a tile at all, so callers need
 * only one check. Coordinates are the board's own: origin top-left, matching
 * `Board` and KataGo's row-major order.
 */
export function intersectionAtPoint(
  layout: GridLayout,
  board: Size,
  point: Point,
): { readonly channel: number; readonly x: number; readonly y: number } | undefined {
  const channel = channelAtPoint(layout, point);
  if (channel === undefined) return undefined;
  const rect = channelRect(layout, channel);
  if (rect === undefined) return undefined;

  const cellWidth = rect.width / board.width;
  const cellHeight = rect.height / board.height;
  if (cellWidth <= 0 || cellHeight <= 0) return undefined;

  const x = Math.min(board.width - 1, Math.floor((point.x - rect.x) / cellWidth));
  const y = Math.min(board.height - 1, Math.floor((point.y - rect.y) / cellHeight));
  return { channel, x: Math.max(0, x), y: Math.max(0, y) };
}

/** The centre of a tile, for scrolling a channel into view. */
export function channelCenter(layout: GridLayout, channel: number): Point | undefined {
  const rect = channelRect(layout, channel);
  if (rect === undefined) return undefined;
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}

/**
 * Clamps a pan offset so the grid cannot be dragged entirely off screen.
 *
 * When the content is smaller than the viewport in an axis there is nothing to
 * pan, so the offset pins to zero.
 */
export function clampPan(layout: GridLayout, viewport: Size, pan: Point): Point {
  const maxX = Math.max(0, layout.content.width - viewport.width);
  const maxY = Math.max(0, layout.content.height - viewport.height);
  return {
    x: Math.min(maxX, Math.max(0, Number.isFinite(pan.x) ? pan.x : 0)),
    y: Math.min(maxY, Math.max(0, Number.isFinite(pan.y) ? pan.y : 0)),
  };
}

/**
 * The channels whose tiles intersect the viewport.
 *
 * The grid only draws these. At 384 channels, redrawing every tile on every
 * move is the difference between stepping smoothly and not.
 */
export function visibleChannels(layout: GridLayout, viewport: Size): readonly number[] {
  if (layout.columns <= 0 || layout.tile.height <= 0) return [];
  const strideY = layout.tile.height + layout.gutter;
  const strideX = layout.tile.width + layout.gutter;

  const firstRow = Math.max(0, Math.floor(layout.pan.y / strideY));
  const lastRow = Math.min(layout.rows - 1, Math.floor((layout.pan.y + viewport.height) / strideY));
  const firstColumn = Math.max(0, Math.floor(layout.pan.x / strideX));
  const lastColumn = Math.min(
    layout.columns - 1,
    Math.floor((layout.pan.x + viewport.width) / strideX),
  );

  const channels: number[] = [];
  for (let row = firstRow; row <= lastRow; row++) {
    for (let column = firstColumn; column <= lastColumn; column++) {
      const channel = row * layout.columns + column;
      if (channel < layout.channels) channels.push(channel);
    }
  }
  return channels;
}

/**
 * Which cell of a single, stretched plane a point falls on.
 *
 * The detail pane draws one plane filling a fixed square, unlike the grid,
 * which packs many planes at their own aspect ratio. So it needs its own
 * inverse, and it lives next to the others for the same reason they do: an
 * inverse kept somewhere else is one that drifts from the transform it undoes.
 *
 * Returns `undefined` for a point outside the box, so a pointer leaving the
 * canvas and a pointer in a corner of it are the same case to the caller.
 */
export function cellAtPlanePoint(
  point: Point,
  viewport: Size,
  board: Size,
): { readonly x: number; readonly y: number } | undefined {
  if (viewport.width <= 0 || viewport.height <= 0) return undefined;
  if (board.width <= 0 || board.height <= 0) return undefined;
  if (point.x < 0 || point.y < 0 || point.x >= viewport.width || point.y >= viewport.height) {
    return undefined;
  }

  const x = Math.floor((point.x / viewport.width) * board.width);
  const y = Math.floor((point.y / viewport.height) * board.height);
  return {
    x: Math.max(0, Math.min(board.width - 1, x)),
    y: Math.max(0, Math.min(board.height - 1, y)),
  };
}

/** The rectangle one cell of a stretched plane occupies, for highlighting it. */
export function planeCellRect(
  cell: { readonly x: number; readonly y: number },
  viewport: Size,
  board: Size,
): Rect | undefined {
  if (board.width <= 0 || board.height <= 0) return undefined;
  const width = viewport.width / board.width;
  const height = viewport.height / board.height;
  return { x: cell.x * width, y: cell.y * height, width, height };
}

/**
 * The checkbox drawn in a tile's corner, for multi-selecting channels.
 *
 * Sized as a fraction of the tile and clamped, so it stays usable when the grid
 * is zoomed out to fit 384 channels and does not become a placard when zoomed
 * in on one. `undefined` when the tile is too small to hit reliably -- below
 * that the checkbox would be a pixel or two and every click would be a
 * coin toss between selecting and opening the channel.
 */
export function checkboxRect(tile: Rect): Rect | undefined {
  const side = Math.min(16, Math.max(8, tile.width * 0.22));
  if (tile.width < side * 2.2 || tile.height < side * 2.2) return undefined;
  const inset = Math.max(1, tile.width * 0.04);
  return { x: tile.x + inset, y: tile.y + inset, width: side, height: side };
}

/** True when a point lands on a tile's checkbox rather than on the tile. */
export function isCheckboxHit(tile: Rect, point: Point): boolean {
  const box = checkboxRect(tile);
  if (box === undefined) return false;
  return (
    point.x >= box.x &&
    point.y >= box.y &&
    point.x < box.x + box.width &&
    point.y < box.y + box.height
  );
}
