/**
 * Draws the board.
 *
 * Deliberately thin: every decision about *where* something goes comes from
 * `board-geometry`, and every decision about *what colour* comes from
 * `overlays`. What is left here is `ctx` calls in a sensible order, which is
 * the part no test can meaningfully check.
 *
 * The canvas is sized in device pixels and scaled once, so everything below
 * works in CSS pixels and the geometry functions never learn about DPR.
 */

import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  afterRenderEffect,
  computed,
  effect,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import type { Board, BoardSize, Move, Vertex } from '@katascope/core';
import {
  boardLayout,
  columnLabel,
  intersectionCell,
  intersectionCenter,
  rowLabel,
  starPoints,
  vertexAtPoint,
  type BoardLayout,
} from './board-geometry';
import { ownershipFill, type PolicyMove } from './overlays';

@Component({
  selector: 'ks-board-canvas',
  template: `
    <canvas
      #canvas
      class="board"
      (click)="onClick($event)"
      (pointermove)="onPointerMove($event)"
      (pointerleave)="onPointerLeave()"
    ></canvas>
  `,
  styles: `
    :host {
      display: block;
      width: 100%;
      height: 100%;
      min-height: 0;
    }

    .board {
      display: block;
      width: 100%;
      height: 100%;
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class BoardCanvas {
  readonly board = input<Board | undefined>(undefined);
  readonly size = input.required<BoardSize>();
  readonly lastMove = input<Move | undefined>(undefined);
  readonly showCoordinates = input(true);
  /** `width * height` ownership values, or `undefined` when the overlay is off. */
  readonly ownership = input<readonly number[] | undefined>(undefined);
  /** Already-selected top-N moves; this component does not choose them. */
  readonly policyMoves = input<readonly PolicyMove[]>([]);
  /**
   * A generic diverging field in [-1, 1], drawn like the ownership heatmap.
   *
   * Separate from `ownership` because it is not ownership: the reduce panel
   * feeds it normalised policy logits, and naming that input `ownership` would
   * make every later reader believe the wrong thing about what is on screen.
   * The caller normalises, because only the caller knows what the numbers are.
   */
  readonly field = input<readonly number[] | undefined>(undefined);
  /** Intersections in the channel-search region, marked so the set is legible. */
  readonly region = input<readonly Vertex[]>([]);
  /**
   * One intersection to ring, for cross-highlighting with an activation plane.
   *
   * Separate from `region` because it means something else entirely: the region
   * is a selection the user made, this is wherever the pointer happens to be.
   */
  readonly highlight = input<Vertex | undefined>(undefined);

  readonly vertexClicked = output<Vertex>();
  /** The intersection under the pointer, or `undefined` once it leaves. */
  readonly vertexHovered = output<Vertex | undefined>();

  private readonly canvasRef = viewChild.required<ElementRef<HTMLCanvasElement>>('canvas');
  readonly #viewport = signal({ width: 0, height: 0 });

  readonly #layout = computed<BoardLayout>(() =>
    boardLayout(this.#viewport(), this.size(), {
      labelCells: this.showCoordinates() ? 1 : 0,
    }),
  );

  #observer: ResizeObserver | undefined;

  constructor() {
    // The element only exists after the first render, so the observer is set up
    // there rather than in the constructor.
    afterRenderEffect(() => {
      const element = this.canvasRef().nativeElement;
      if (this.#observer !== undefined) return;
      this.#observer = new ResizeObserver(([entry]) => {
        const box = entry?.contentRect;
        if (box !== undefined) this.#viewport.set({ width: box.width, height: box.height });
      });
      this.#observer.observe(element);
      const rect = element.getBoundingClientRect();
      this.#viewport.set({ width: rect.width, height: rect.height });
    });

    // One effect, reading every input, so any change repaints exactly once.
    effect(() => this.#draw());
  }

  ngOnDestroy(): void {
    this.#observer?.disconnect();
  }

  onClick(event: MouseEvent): void {
    const element = this.canvasRef().nativeElement;
    const rect = element.getBoundingClientRect();
    const vertex = vertexAtPoint(this.#layout(), {
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
    });
    if (vertex !== undefined) this.vertexClicked.emit(vertex);
  }

  /**
   * Reports the intersection under the pointer.
   *
   * Emits `undefined` in the outer margin as well as on leave: the pointer is
   * over the canvas but not over any intersection, and reporting the nearest
   * one would put a highlight somewhere the pointer is not.
   */
  onPointerMove(event: PointerEvent): void {
    const element = this.canvasRef().nativeElement;
    const rect = element.getBoundingClientRect();
    this.#emitHover(
      vertexAtPoint(this.#layout(), {
        x: event.clientX - rect.left,
        y: event.clientY - rect.top,
      }),
    );
  }

  onPointerLeave(): void {
    this.#emitHover(undefined);
  }

  /** Last vertex emitted, so an unchanged position does not re-emit. */
  #lastHover: Vertex | undefined;

  #emitHover(vertex: Vertex | undefined): void {
    const previous = this.#lastHover;
    const same =
      previous === vertex ||
      (previous !== undefined &&
        vertex !== undefined &&
        previous.x === vertex.x &&
        previous.y === vertex.y);
    // A pointermove fires per pixel; re-emitting the same intersection would
    // repaint both canvases dozens of times while crossing one cell.
    if (same) return;
    this.#lastHover = vertex;
    this.vertexHovered.emit(vertex);
  }

  #draw(): void {
    const layout = this.#layout();
    const canvas = this.canvasRef().nativeElement;
    const viewport = this.#viewport();
    const ratio = globalThis.devicePixelRatio ?? 1;

    canvas.width = Math.max(1, Math.round(viewport.width * ratio));
    canvas.height = Math.max(1, Math.round(viewport.height * ratio));
    const ctx = canvas.getContext('2d');
    if (ctx === null) return;

    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, viewport.width, viewport.height);
    if (layout.cellSize <= 0) return;

    this.#drawWood(ctx, layout);
    this.#drawGrid(ctx, layout);
    if (this.showCoordinates()) this.#drawCoordinates(ctx, layout);
    this.#drawOwnership(ctx, layout);
    this.#drawField(ctx, layout);
    this.#drawStones(ctx, layout);
    this.#drawPolicy(ctx, layout);
    this.#drawLastMove(ctx, layout);
    // After the stones: a region point can sit on an occupied intersection, and
    // a marker hidden under a stone would make the selection unreadable.
    this.#drawRegion(ctx, layout);
    this.#drawHighlight(ctx, layout);
  }

  #drawWood(ctx: CanvasRenderingContext2D, layout: BoardLayout): void {
    // The wood extends past the outermost lines by half a cell for the stones
    // that sit on them, plus the coordinate margin -- labels belong on the
    // board, not floating on the page behind it where they are unreadable.
    const margin = layout.cellSize * (0.5 + layout.labelCells);
    ctx.fillStyle = '#d8b26a';
    ctx.fillRect(
      layout.grid.x - margin,
      layout.grid.y - margin,
      layout.grid.width + margin * 2,
      layout.grid.height + margin * 2,
    );
  }

  #drawGrid(ctx: CanvasRenderingContext2D, layout: BoardLayout): void {
    const { size } = layout;
    ctx.strokeStyle = 'rgba(40, 28, 12, 0.85)';
    ctx.lineWidth = Math.max(0.5, layout.cellSize / 28);
    ctx.beginPath();
    for (let x = 0; x < size.width; x++) {
      const top = intersectionCenter(layout, { x, y: 0 });
      const bottom = intersectionCenter(layout, { x, y: size.height - 1 });
      ctx.moveTo(top.x, top.y);
      ctx.lineTo(bottom.x, bottom.y);
    }
    for (let y = 0; y < size.height; y++) {
      const left = intersectionCenter(layout, { x: 0, y });
      const right = intersectionCenter(layout, { x: size.width - 1, y });
      ctx.moveTo(left.x, left.y);
      ctx.lineTo(right.x, right.y);
    }
    ctx.stroke();

    ctx.fillStyle = 'rgba(40, 28, 12, 0.9)';
    const radius = Math.max(1.5, layout.cellSize / 10);
    for (const star of starPoints(size)) {
      const centre = intersectionCenter(layout, star);
      ctx.beginPath();
      ctx.arc(centre.x, centre.y, radius, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  #drawCoordinates(ctx: CanvasRenderingContext2D, layout: BoardLayout): void {
    const { size } = layout;
    ctx.fillStyle = 'rgba(40, 28, 12, 0.75)';
    ctx.font = `${Math.round(layout.cellSize * 0.42)}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    for (let x = 0; x < size.width; x++) {
      const centre = intersectionCenter(layout, { x, y: 0 });
      ctx.fillText(columnLabel(x), centre.x, centre.y - layout.cellSize);
    }
    for (let y = 0; y < size.height; y++) {
      const centre = intersectionCenter(layout, { x: 0, y });
      ctx.fillText(rowLabel(size, y), centre.x - layout.cellSize, centre.y);
    }
  }

  #drawOwnership(ctx: CanvasRenderingContext2D, layout: BoardLayout): void {
    const values = this.ownership();
    if (values === undefined) return;
    const { size } = layout;

    for (let y = 0; y < size.height; y++) {
      for (let x = 0; x < size.width; x++) {
        const value = values[y * size.width + x];
        if (value === undefined) continue;
        const fill = ownershipFill(value);
        // Skip near-neutral points entirely rather than painting a wash of grey.
        if (fill.strength < 0.02) continue;
        const cell = intersectionCell(layout, { x, y });
        ctx.fillStyle = fill.color;
        ctx.fillRect(cell.x, cell.y, cell.width, cell.height);
      }
    }
  }

  /** The generic field, painted with the same ramp as ownership. */
  #drawField(ctx: CanvasRenderingContext2D, layout: BoardLayout): void {
    const values = this.field();
    if (values === undefined) return;
    const size = this.size();
    for (let y = 0; y < size.height; y++) {
      for (let x = 0; x < size.width; x++) {
        const value = values[y * size.width + x];
        if (value === undefined) continue;
        const fill = ownershipFill(value);
        // Same near-neutral skip as the ownership map: a wash of faint colour
        // over every point reads as noise and hides the board lines.
        if (fill.strength < 0.02) continue;
        const cell = intersectionCell(layout, { x, y });
        ctx.fillStyle = fill.color;
        ctx.fillRect(cell.x, cell.y, cell.width, cell.height);
      }
    }
  }

  #drawStones(ctx: CanvasRenderingContext2D, layout: BoardLayout): void {
    const board = this.board();
    if (board === undefined) return;
    const { size } = layout;

    for (let y = 0; y < size.height; y++) {
      for (let x = 0; x < size.width; x++) {
        const stone = board.get({ x, y });
        if (stone === 'empty') continue;
        const centre = intersectionCenter(layout, { x, y });
        ctx.beginPath();
        ctx.arc(centre.x, centre.y, layout.stoneRadius, 0, Math.PI * 2);
        ctx.fillStyle = stone === 'black' ? '#14161a' : '#f4f1e8';
        ctx.fill();
        ctx.lineWidth = Math.max(0.5, layout.cellSize / 32);
        ctx.strokeStyle = stone === 'black' ? 'rgba(0,0,0,0.6)' : 'rgba(40,28,12,0.55)';
        ctx.stroke();
      }
    }
  }

  #drawPolicy(ctx: CanvasRenderingContext2D, layout: BoardLayout): void {
    const moves = this.policyMoves();
    if (moves.length === 0) return;

    const best = moves[0]?.probability ?? 1;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `${Math.round(layout.cellSize * 0.34)}px system-ui, sans-serif`;

    for (const move of moves) {
      if (move.vertex === undefined) continue; // a pass has nowhere to go
      const centre = intersectionCenter(layout, move.vertex);
      // Area scales with probability relative to the best move, so the ranking
      // is legible at a glance rather than only from the labels.
      const share = best > 0 ? move.probability / best : 0;
      const radius = layout.stoneRadius * (0.45 + 0.55 * Math.sqrt(share));

      ctx.beginPath();
      ctx.arc(centre.x, centre.y, radius, 0, Math.PI * 2);
      ctx.fillStyle = move.rank === 0 ? 'rgba(80, 200, 140, 0.75)' : 'rgba(80, 200, 140, 0.4)';
      ctx.fill();
      ctx.lineWidth = Math.max(0.5, layout.cellSize / 26);
      ctx.strokeStyle = 'rgba(20, 90, 60, 0.9)';
      ctx.stroke();

      if (layout.cellSize >= 22) {
        ctx.fillStyle = 'rgba(10, 40, 25, 0.95)';
        ctx.fillText(String(move.rank + 1), centre.x, centre.y);
      }
    }
  }

  /**
   * The channel-search region: a square outline per selected intersection.
   *
   * A square rather than the circle every other overlay uses, so the selection
   * cannot be mistaken for a stone, a policy candidate or the last-move marker
   * at a glance.
   */
  #drawRegion(ctx: CanvasRenderingContext2D, layout: BoardLayout): void {
    const region = this.region();
    if (region.length === 0) return;

    const side = layout.cellSize * 0.62;
    ctx.lineWidth = Math.max(1.5, layout.cellSize / 12);
    for (const vertex of region) {
      const centre = intersectionCenter(layout, vertex);
      ctx.fillStyle = 'rgba(255, 196, 64, 0.28)';
      ctx.fillRect(centre.x - side / 2, centre.y - side / 2, side, side);
      ctx.strokeStyle = 'rgba(255, 176, 32, 0.95)';
      ctx.strokeRect(centre.x - side / 2, centre.y - side / 2, side, side);
    }
  }

  /**
   * The cross-highlight: a rectangle around one intersection.
   *
   * Drawn as the cell the intersection owns rather than as a ring, so it reads
   * as the same shape as the heatmap cell it corresponds to -- the whole point
   * is that the two canvases are showing the same place.
   */
  #drawHighlight(ctx: CanvasRenderingContext2D, layout: BoardLayout): void {
    const vertex = this.highlight();
    if (vertex === undefined || layout.cellSize <= 0) return;
    const cell = intersectionCell(layout, vertex);

    // Inset by half the stroke so the rectangle sits inside its own cell: at
    // the 190px board in the detail drawer a cell is about 9px, and a stroke
    // centred on the boundary would bleed into all four neighbours.
    const inset = Math.max(0.75, layout.cellSize / 16);
    ctx.lineWidth = inset * 2;
    ctx.strokeStyle = 'rgba(106, 169, 255, 0.95)';
    ctx.strokeRect(
      cell.x + inset,
      cell.y + inset,
      Math.max(0, cell.width - inset * 2),
      Math.max(0, cell.height - inset * 2),
    );
  }

  #drawLastMove(ctx: CanvasRenderingContext2D, layout: BoardLayout): void {
    const move = this.lastMove();
    if (move === undefined || move.kind !== 'play') return;
    const centre = intersectionCenter(layout, move.vertex);

    // A ring rather than a dot: a dot on a black stone is invisible, and a ring
    // reads the same over either colour.
    ctx.beginPath();
    ctx.arc(centre.x, centre.y, layout.stoneRadius * 0.55, 0, Math.PI * 2);
    ctx.lineWidth = Math.max(1, layout.cellSize / 14);
    ctx.strokeStyle = move.player === 'black' ? 'rgba(255, 90, 80, 0.95)' : 'rgba(200, 40, 30, 0.95)';
    ctx.stroke();
  }
}
