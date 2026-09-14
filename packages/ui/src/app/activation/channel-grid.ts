/**
 * The channel grid: every channel of one block, each a small heatmap.
 *
 * Thin, per CLAUDE.md. Layout comes from `grid-layout`, pixels come from the
 * render worker, and what is left here is `drawImage` in a loop plus the
 * pointer handling that zoom and pan need.
 *
 * One canvas, not one per channel. 384 canvas elements would each carry their
 * own context and compositing layer; a single canvas draws the same tiles in
 * one pass and lets the layout maths decide where they land.
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
import type { BoardSize } from '@katascope/core';
import {
  channelAtPoint,
  channelRect,
  checkboxRect,
  clampPan,
  isCheckboxHit,
  defaultColumns,
  gridLayout,
  intersectionAtPoint,
  visibleChannels,
  type GridLayout,
  type Rect,
} from './grid-layout';

/** What the pointer is over, for the hover readout. */
export interface GridHover {
  readonly channel: number;
  readonly x: number;
  readonly y: number;
}

const MIN_ZOOM = 0.5;
const MAX_ZOOM = 12;

@Component({
  selector: 'ks-channel-grid',
  template: `
    <div #host class="grid">
      <canvas
        #canvas
        class="grid__canvas"
        (pointerdown)="onPointerDown($event)"
        (pointermove)="onPointerMove($event)"
        (pointerup)="onPointerUp($event)"
        (pointerleave)="onPointerLeave()"
        (wheel)="onWheel($event)"
        (click)="onClick($event)"
      ></canvas>
    </div>
  `,
  styles: `
    :host {
      display: block;
      height: 100%;
      min-height: 0;
      min-width: 0;
    }

    .grid {
      width: 100%;
      height: 100%;
      overflow: hidden;
      background: var(--ks-bg);
    }

    .grid__canvas {
      display: block;
      width: 100%;
      height: 100%;
      cursor: crosshair;
      touch-action: none;
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ChannelGrid {
  readonly channels = input.required<number>();
  readonly boardSize = input.required<BoardSize>();
  /** `channels * area * 4` RGBA bytes, channel-major, from the renderer. */
  readonly pixels = input<Uint8ClampedArray | undefined>(undefined);
  /** Display order. Index i of this array is drawn in slot i. */
  readonly order = input<readonly number[] | undefined>(undefined);
  readonly selected = input<number | undefined>(undefined);
  readonly hidden = input<ReadonlySet<number>>(new Set<number>());
  /**
   * Whether tiles carry a selection checkbox.
   *
   * Only the last block does: it is the one the heads read, so it is the only
   * block where "remove these channels and re-run the head" means anything.
   */
  readonly selectable = input(false);
  readonly selectedChannels = input<ReadonlySet<number>>(new Set<number>());

  readonly hovered = output<GridHover | undefined>();
  readonly channelPicked = output<number>();
  /** A checkbox was clicked; the channel should be added or removed. */
  readonly selectionToggled = output<number>();

  private readonly hostRef = viewChild.required<ElementRef<HTMLDivElement>>('host');
  private readonly canvasRef = viewChild.required<ElementRef<HTMLCanvasElement>>('canvas');

  readonly #viewport = signal({ width: 0, height: 0 });
  readonly #zoom = signal(1);
  readonly #pan = signal({ x: 0, y: 0 });

  #observer: ResizeObserver | undefined;
  #dragging: { pointerId: number; startX: number; startY: number; panX: number; panY: number } | undefined;
  #moved = false;
  /** Scratch canvas at board size: `putImageData` cannot scale, `drawImage` can. */
  #scratch: HTMLCanvasElement | undefined;

  readonly #layout = computed<GridLayout>(() =>
    gridLayout(this.#viewport(), this.channels(), this.boardSize(), {
      zoom: this.#zoom(),
      pan: this.#pan(),
      columns: defaultColumns(this.channels()),
    }),
  );

  constructor() {
    afterRenderEffect(() => {
      const host = this.hostRef().nativeElement;
      if (this.#observer !== undefined) return;
      this.#observer = new ResizeObserver(([entry]) => {
        const box = entry?.contentRect;
        if (box !== undefined) this.#viewport.set({ width: box.width, height: box.height });
      });
      this.#observer.observe(host);
      const rect = host.getBoundingClientRect();
      this.#viewport.set({ width: rect.width, height: rect.height });
    });

    effect(() => this.#draw());
  }

  ngOnDestroy(): void {
    this.#observer?.disconnect();
  }

  /** Scrolls a channel into view, for the rail and for keyboard selection. */
  revealChannel(channel: number): void {
    const layout = this.#layout();
    const rect = channelRect(layout, this.#slotOf(channel));
    if (rect === undefined) return;
    const viewport = this.#viewport();
    const pan = this.#pan();
    const next = { x: pan.x, y: pan.y };
    if (rect.y < 0) next.y = pan.y + rect.y;
    else if (rect.y + rect.height > viewport.height) next.y = pan.y + rect.y + rect.height - viewport.height;
    this.#pan.set(clampPan(layout, viewport, next));
  }

  protected onWheel(event: WheelEvent): void {
    event.preventDefault();
    const layout = this.#layout();
    const viewport = this.#viewport();

    if (event.ctrlKey || event.metaKey) {
      // Zoom about the pointer, so the tile under the cursor stays put.
      const factor = Math.exp(-event.deltaY / 400);
      const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, this.#zoom() * factor));
      const scale = zoom / this.#zoom();
      const pan = this.#pan();
      const next = {
        x: (pan.x + event.offsetX) * scale - event.offsetX,
        y: (pan.y + event.offsetY) * scale - event.offsetY,
      };
      this.#zoom.set(zoom);
      const rescaled = gridLayout(viewport, this.channels(), this.boardSize(), {
        zoom,
        columns: defaultColumns(this.channels()),
      });
      this.#pan.set(clampPan(rescaled, viewport, next));
      return;
    }

    const pan = this.#pan();
    this.#pan.set(clampPan(layout, viewport, { x: pan.x + event.deltaX, y: pan.y + event.deltaY }));
  }

  protected onPointerDown(event: PointerEvent): void {
    const pan = this.#pan();
    this.#dragging = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      panX: pan.x,
      panY: pan.y,
    };
    this.#moved = false;
    (event.target as Element).setPointerCapture?.(event.pointerId);
  }

  protected onPointerMove(event: PointerEvent): void {
    const drag = this.#dragging;
    if (drag !== undefined && drag.pointerId === event.pointerId) {
      const dx = event.clientX - drag.startX;
      const dy = event.clientY - drag.startY;
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) this.#moved = true;
      this.#pan.set(
        clampPan(this.#layout(), this.#viewport(), { x: drag.panX - dx, y: drag.panY - dy }),
      );
      return;
    }

    const hit = intersectionAtPoint(this.#layout(), this.boardSize(), {
      x: event.offsetX,
      y: event.offsetY,
    });
    this.hovered.emit(
      hit === undefined ? undefined : { channel: this.#channelOf(hit.channel), x: hit.x, y: hit.y },
    );
  }

  protected onPointerUp(event: PointerEvent): void {
    if (this.#dragging?.pointerId === event.pointerId) this.#dragging = undefined;
  }

  protected onPointerLeave(): void {
    this.#dragging = undefined;
    this.hovered.emit(undefined);
  }

  protected onClick(event: MouseEvent): void {
    // A drag that happened to end over a tile is not a click on it.
    if (this.#moved) return;
    const layout = this.#layout();
    const point = { x: event.offsetX, y: event.offsetY };
    const slot = channelAtPoint(layout, point);
    if (slot === undefined) return;
    const channel = this.#channelOf(slot);

    // The checkbox sits inside the tile, so it has to be tested first --
    // otherwise selecting a channel would also open it in the drawer, and
    // ticking six boxes would leave the drawer showing the sixth.
    const rect = channelRect(layout, slot);
    if (this.selectable() && rect !== undefined && isCheckboxHit(rect, point)) {
      this.selectionToggled.emit(channel);
      return;
    }
    this.channelPicked.emit(channel);
  }

  /** Which channel is drawn in a slot, honouring the sort order. */
  #channelOf(slot: number): number {
    return this.order()?.[slot] ?? slot;
  }

  /** Which slot a channel is drawn in. */
  #slotOf(channel: number): number {
    const order = this.order();
    if (order === undefined) return channel;
    const slot = order.indexOf(channel);
    return slot < 0 ? channel : slot;
  }

  #draw(): void {
    const layout = this.#layout();
    const viewport = this.#viewport();
    const canvas = this.canvasRef().nativeElement;
    const ratio = globalThis.devicePixelRatio ?? 1;

    canvas.width = Math.max(1, Math.round(viewport.width * ratio));
    canvas.height = Math.max(1, Math.round(viewport.height * ratio));
    const ctx = canvas.getContext('2d');
    if (ctx === null) return;

    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, viewport.width, viewport.height);

    const pixels = this.pixels();
    const board = this.boardSize();
    const area = board.width * board.height;
    if (pixels === undefined || layout.columns <= 0 || area <= 0) return;

    const scratch = this.#ensureScratch(board);
    const scratchCtx = scratch.getContext('2d');
    if (scratchCtx === null) return;

    // Nearest-neighbour: a 19x19 plane blown up to 60px is data, not a
    // photograph, and smoothing it invents values between cells.
    ctx.imageSmoothingEnabled = false;

    for (const slot of visibleChannels(layout, viewport)) {
      const rect = channelRect(layout, slot);
      if (rect === undefined) continue;
      const channel = this.#channelOf(slot);
      const offset = channel * area * 4;
      if (offset + area * 4 > pixels.length) continue;

      const image = new ImageData(pixels.slice(offset, offset + area * 4), board.width, board.height);
      scratchCtx.putImageData(image, 0, 0);
      ctx.drawImage(scratch, rect.x, rect.y, rect.width, rect.height);

      if (channel === this.selected()) {
        ctx.strokeStyle = 'rgba(106, 169, 255, 0.95)';
        ctx.lineWidth = 2;
        ctx.strokeRect(rect.x - 1, rect.y - 1, rect.width + 2, rect.height + 2);
      }

      if (this.selectable()) this.#drawCheckbox(ctx, rect, this.selectedChannels().has(channel));
    }
  }

  /**
   * A tile's selection checkbox.
   *
   * Drawn on the canvas rather than as DOM: there is one canvas for all 384
   * tiles precisely to avoid 384 elements, and 384 checkbox inputs would undo
   * that. The cost is that it needs its own hit-test, which lives beside the
   * layout maths in `grid-layout`.
   */
  #drawCheckbox(ctx: CanvasRenderingContext2D, tile: Rect, checked: boolean): void {
    const box = checkboxRect(tile);
    if (box === undefined) return;

    ctx.fillStyle = checked ? 'rgba(106, 169, 255, 0.95)' : 'rgba(20, 22, 26, 0.55)';
    ctx.fillRect(box.x, box.y, box.width, box.height);
    ctx.lineWidth = Math.max(1, box.width / 10);
    ctx.strokeStyle = 'rgba(235, 238, 245, 0.85)';
    ctx.strokeRect(box.x, box.y, box.width, box.height);

    if (!checked) return;
    // A tick, drawn as two strokes rather than a glyph: text metrics at this
    // size are unreliable and a filled box alone reads as "disabled".
    ctx.beginPath();
    ctx.moveTo(box.x + box.width * 0.22, box.y + box.height * 0.52);
    ctx.lineTo(box.x + box.width * 0.44, box.y + box.height * 0.74);
    ctx.lineTo(box.x + box.width * 0.8, box.y + box.height * 0.28);
    ctx.lineWidth = Math.max(1.5, box.width / 7);
    ctx.strokeStyle = 'rgba(10, 14, 20, 0.95)';
    ctx.stroke();
  }

  #ensureScratch(board: BoardSize): HTMLCanvasElement {
    let scratch = this.#scratch;
    if (scratch === undefined) {
      scratch = document.createElement('canvas');
      this.#scratch = scratch;
    }
    if (scratch.width !== board.width || scratch.height !== board.height) {
      scratch.width = board.width;
      scratch.height = board.height;
    }
    return scratch;
  }
}
