/**
 * One channel enlarged, beside the board position that produced it.
 *
 * The board is the point. A plane on its own is a texture; next to the stones
 * and coordinates it becomes a claim about a place -- "this channel is looking
 * at the bottom-left corner" -- which is the kind of thing the tab exists to
 * let someone check.
 *
 * **Always mounted, even with nothing selected.** It used to appear and
 * disappear with the selection, which cost the canvas above it about 230px
 * every time. That was not merely a flash: the pointer sits over the grid, the
 * drawer opens underneath it, the canvas shrinks, and a pointer that was near
 * the bottom is suddenly over the drawer instead -- which clears the hover,
 * closes the drawer, grows the canvas back under the pointer, and starts again.
 * Reserving the space unconditionally removes the oscillation and the flicker
 * with it.
 */

import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  afterRenderEffect,
  computed,
  effect,
  input,
  signal,
  viewChild,
} from '@angular/core';
import type { Board, BoardSize, Move, Vertex } from '@katascope/core';
import { BoardCanvas } from '../board/board-canvas';
import { columnLabel, rowLabel } from '../board/board-geometry';
import type { PlaneStats } from './channel-stats';
import { cellAtPlanePoint, planeCellRect } from './grid-layout';

@Component({
  selector: 'ks-plane-detail',
  imports: [BoardCanvas],
  template: `
    <div class="detail">
      <header class="detail__head">
        <!--
          Tested against undefined, not for truthiness. Channel 0 is a
          perfectly good channel and a falsy number, and the truthiness form
          sent every hover over the first tile to the empty state -- which made
          the top-left channel of every block permanently uninspectable.
        -->
        @if (channel() !== undefined) {
          <span class="detail__address" data-testid="detail-address">{{ block() }}.{{ channel() }}</span>
        } @else {
          <span class="detail__address detail__address--empty" data-testid="detail-address">
            {{ block() }}.—
          </span>
        }
        @if (stats(); as s) {
          <span class="detail__stats">
            min {{ s.min.toFixed(3) }} · max {{ s.max.toFixed(3) }} · mean {{ s.mean.toFixed(3) }}
            @if (s.delta > 0) {
              · Δ {{ s.delta.toFixed(2) }}
            }
          </span>
        } @else {
          <span class="detail__stats detail__stats--empty">
            hover a channel to preview it, click to keep it here
          </span>
        }
      </header>

      @if (hasChannel()) {
        <dl class="detail__measures" data-testid="detail-measures">
          @if (impact(); as value) {
            <dt>impact{{ readerHead() ? ' (' + readerHead() + ')' : '' }}</dt>
            <dd>{{ value.value.toPrecision(4) }} · #{{ value.rank + 1 }}</dd>
          }
          @if (readerNorm() !== undefined) {
            <dt>reader norm</dt>
            <dd>{{ readerNorm()!.toPrecision(4) }}</dd>
          }
          @if (attribution(); as value) {
            <dt>attribution{{ attributionTarget() ? ' → ' + attributionTarget() : '' }}</dt>
            <dd>{{ value.value.toPrecision(4) }} · #{{ value.rank + 1 }}</dd>
          }
        </dl>
      }

      <div class="detail__panes">
        <figure class="detail__pane">
          <canvas
            #plane
            class="detail__plane"
            [class.detail__plane--empty]="!hasChannel()"
            (pointermove)="onPlanePointerMove($event)"
            (pointerleave)="onPlanePointerLeave()"
          ></canvas>
          <figcaption>
            @if (channel() !== undefined) {
              channel {{ channel() }}
            } @else {
              no channel
            }
          </figcaption>
        </figure>
        <figure class="detail__pane">
          <div class="detail__board">
            <ks-board-canvas
              [board]="board()"
              [size]="boardSize()"
              [lastMove]="lastMove()"
              [highlight]="crossHighlight()"
              (vertexHovered)="onBoardHover($event)"
            />
          </div>
          <figcaption>position</figcaption>
        </figure>
      </div>

      <p class="detail__hover">{{ hoverLabel() ?? '\u00a0' }}</p>
    </div>
  `,
  styles: `
    :host {
      display: block;
      min-height: 0;
    }

    .detail {
      display: flex;
      flex-direction: column;
      gap: 8px;
      padding: 10px;
      background: var(--ks-surface);
      border-top: 1px solid var(--ks-border);
    }

    .detail__head {
      display: flex;
      align-items: baseline;
      gap: 12px;
      flex-wrap: wrap;
    }

    .detail__address {
      font-family: var(--ks-font-mono);
      font-weight: 600;
      color: var(--ks-accent);
    }

    .detail__address--empty {
      color: var(--ks-text-muted);
      font-weight: 400;
    }

    .detail__stats--empty {
      font-style: italic;
    }

    /* A visible frame rather than a blank gap, so the reserved space reads as
       "nothing selected" rather than as a rendering failure. */
    .detail__plane--empty {
      background: var(--ks-surface-raised);
    }

    .detail__stats {
      font-family: var(--ks-font-mono);
      font-size: 11px;
      color: var(--ks-text-muted);
      font-variant-numeric: tabular-nums;
    }

    .detail__measures {
      display: grid;
      grid-template-columns: max-content max-content;
      gap: 2px 14px;
      margin: 0;
      font-size: 11px;
      font-family: var(--ks-font-mono);
      font-variant-numeric: tabular-nums;
    }

    .detail__measures dt {
      color: var(--ks-text-muted);
    }

    .detail__measures dd {
      margin: 0;
    }

    .detail__panes {
      display: flex;
      gap: 12px;
      align-items: flex-start;
    }

    .detail__pane {
      margin: 0;
      display: flex;
      flex-direction: column;
      gap: 4px;
    }

    .detail__pane figcaption {
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: var(--ks-text-muted);
    }

    .detail__plane,
    .detail__board {
      width: 190px;
      height: 190px;
      border: 1px solid var(--ks-border);
      border-radius: var(--ks-radius);
    }

    .detail__plane {
      display: block;
      image-rendering: pixelated;
    }

    .detail__hover {
      margin: 0;
      font-family: var(--ks-font-mono);
      font-size: 11px;
      color: var(--ks-text-muted);
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PlaneDetail {
  readonly block = input.required<number>();
  /** `undefined` when nothing is selected; the drawer then shows its empty state. */
  readonly channel = input<number | undefined>(undefined);
  readonly boardSize = input.required<BoardSize>();
  readonly board = input<Board | undefined>(undefined);
  readonly lastMove = input<Move | undefined>(undefined);
  readonly stats = input<PlaneStats | undefined>(undefined);
  /** RGBA for this channel alone: `area * 4` bytes. */
  readonly pixels = input<Uint8ClampedArray | undefined>(undefined);
  readonly hover = input<{ readonly x: number; readonly y: number } | undefined>(undefined);
  /** `sum|activation| x reader norm` for this channel, and its rank in the block. */
  readonly impact = input<{ readonly value: number; readonly rank: number } | undefined>(undefined);
  /** The static reader norm for this channel, under the selected head. */
  readonly readerNorm = input<number | undefined>(undefined);
  /** Which head the reader norm and impact are measured against, if it matters. */
  readonly readerHead = input<string | undefined>(undefined);
  /** Attribution for this channel against the current target, and its rank. */
  readonly attribution = input<{ readonly value: number; readonly rank: number } | undefined>(
    undefined,
  );
  readonly attributionTarget = input<string | undefined>(undefined);

  private readonly planeRef = viewChild.required<ElementRef<HTMLCanvasElement>>('plane');
  readonly #ready = signal(false);

  protected readonly hasChannel = computed(() => this.channel() !== undefined);

  /** The pointer's own position over each of the two canvases. */
  readonly #planeHover = signal<Vertex | undefined>(undefined);
  readonly #boardHover = signal<Vertex | undefined>(undefined);

  /**
   * The one intersection both canvases mark.
   *
   * Bi-directional highlighting is really a single shared "point of interest"
   * that any of three things can name: the pointer over the enlarged plane, the
   * pointer over the board beside it, or the pointer over a tile up in the grid.
   * Resolving them to one value here means the two canvases cannot disagree
   * about where the pointer is, and neither needs to know about the other.
   *
   * The local hovers win over the grid's because they are the more recent
   * intent: once the pointer is down in the drawer it is no longer over a tile,
   * but the grid's last hover lingers until something replaces it.
   */
  protected readonly crossHighlight = computed<Vertex | undefined>(
    () => this.#planeHover() ?? this.#boardHover() ?? this.hover(),
  );

  protected readonly hoverLabel = computed(() => {
    const at = this.crossHighlight();
    if (at === undefined) return undefined;
    const size = this.boardSize();
    return `${columnLabel(at.x)}${rowLabel(size, at.y)}  (x ${at.x}, y ${at.y})`;
  });

  protected onPlanePointerMove(event: PointerEvent): void {
    const canvas = this.planeRef().nativeElement;
    const rect = canvas.getBoundingClientRect();
    this.#planeHover.set(
      cellAtPlanePoint(
        { x: event.clientX - rect.left, y: event.clientY - rect.top },
        { width: rect.width, height: rect.height },
        this.boardSize(),
      ),
    );
  }

  protected onPlanePointerLeave(): void {
    this.#planeHover.set(undefined);
  }

  protected onBoardHover(vertex: Vertex | undefined): void {
    this.#boardHover.set(vertex);
  }

  constructor() {
    afterRenderEffect(() => {
      this.planeRef();
      this.#ready.set(true);
    });
    effect(() => this.#draw());
  }

  #draw(): void {
    if (!this.#ready()) return;
    const canvas = this.planeRef().nativeElement;
    const size = this.boardSize();
    const pixels = this.pixels();

    const ratio = globalThis.devicePixelRatio ?? 1;
    const css = 190;
    canvas.width = Math.round(css * ratio);
    canvas.height = Math.round(css * ratio);
    const ctx = canvas.getContext('2d');
    if (ctx === null) return;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (
      this.channel() === undefined ||
      pixels === undefined ||
      pixels.length < size.width * size.height * 4
    ) {
      return;
    }

    const scratch = document.createElement('canvas');
    scratch.width = size.width;
    scratch.height = size.height;
    const scratchCtx = scratch.getContext('2d');
    if (scratchCtx === null) return;
    scratchCtx.putImageData(new ImageData(pixels.slice(), size.width, size.height), 0, 0);

    // Nearest-neighbour: each cell is a value, not a sample of a continuum.
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(scratch, 0, 0, canvas.width, canvas.height);

    this.#drawHighlight(ctx, canvas, size);
  }

  /** Rings the cell the board beside it is also ringing. */
  #drawHighlight(
    ctx: CanvasRenderingContext2D,
    canvas: HTMLCanvasElement,
    size: BoardSize,
  ): void {
    const cell = this.crossHighlight();
    if (cell === undefined) return;
    const rect = planeCellRect(cell, { width: canvas.width, height: canvas.height }, size);
    if (rect === undefined) return;

    // Drawn twice: the planes run light to dark, so a single stroke of either
    // tone disappears against half the values it might land on.
    ctx.lineWidth = Math.max(2, canvas.width / size.width / 6);
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.55)';
    ctx.strokeRect(rect.x, rect.y, rect.width, rect.height);
    ctx.lineWidth = Math.max(1, canvas.width / size.width / 12);
    ctx.strokeStyle = 'rgba(106, 169, 255, 0.95)';
    ctx.strokeRect(rect.x, rect.y, rect.width, rect.height);
  }
}
