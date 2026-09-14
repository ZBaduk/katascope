/**
 * The reduce panel: run a head with channels removed, and show what changed.
 *
 * Three boards, always all three. The reduced output on its own is
 * uninterpretable -- a policy that likes the top-left corner means one thing if
 * the full head liked it too and quite another if the reduction invented it --
 * so "full", "reduced" and "difference" are shown together or not at all.
 *
 * Presentation only. The arithmetic is `@katascope/core`'s and runs in the
 * worker; what is decided here is how a logit becomes a colour, which is the
 * one thing this file is allowed to have an opinion about.
 */

import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  signal,
} from '@angular/core';
import {
  policySoftmax,
  squareBoardSize,
  type BoardSize,
  type HeadKind,
  type ReduceMode,
} from '@katascope/core';
import { BoardCanvas } from '../board/board-canvas';
import { SessionStore } from '../state/session-store';
import { topPolicyMoves, type PolicyMove } from '../board/overlays';
import { ReduceStore } from './reduce-store';

/** How many policy candidates the overlay marks. */
const TOP_N = 5;

@Component({
  selector: 'ks-reduce-panel',
  imports: [BoardCanvas],
  template: `
    <section class="reduce" data-testid="reduce-panel">
      <header class="reduce__head">
        <h2 class="reduce__title">Reduce</h2>
        <span class="reduce__count" data-testid="reduce-count">
          {{ store.selectedCount() }} of {{ channels() }} selected
        </span>
      </header>

      @if (store.weightsError(); as error) {
        <p class="reduce__note reduce__note--bad" data-testid="reduce-unavailable">
          Head weights unavailable — {{ error }}. A <code>.kact</code> capture stores planes and
          carries no weights, so a head cannot be re-run from one.
        </p>
      } @else if (!store.available()) {
        <p class="reduce__note">Loading head weights…</p>
      } @else {
        <div class="reduce__controls">
          <label class="field">
            Head
            <select
              [value]="store.head()"
              (change)="setHead($any($event.target).value)"
              aria-label="Reduce head"
            >
              <option value="policy" [selected]="store.head() === 'policy'">policy</option>
              <option value="ownership" [selected]="store.head() === 'ownership'">ownership</option>
            </select>
          </label>

          <label class="field">
            Mode
            <select
              [value]="store.mode()"
              (change)="setMode($any($event.target).value)"
              aria-label="Reduce mode"
            >
              <option value="only" [selected]="store.mode() === 'only'">only these</option>
              <option value="without" [selected]="store.mode() === 'without'">without these</option>
            </select>
          </label>
        </div>

        <div class="reduce__selection">
          <button type="button" class="chip" (click)="store.selectAll(channels())">all</button>
          <button type="button" class="chip" (click)="store.clear()" data-testid="reduce-clear">
            clear
          </button>
          <button type="button" class="chip" (click)="store.invert(channels())">invert</button>
          @if (leans(); as classified) {
            <button type="button" class="chip chip--policy" (click)="store.selectByLean(classified, 'policy')">
              policy-leaning
            </button>
            <button type="button" class="chip chip--value" (click)="store.selectByLean(classified, 'value')">
              value-leaning
            </button>
          }
        </div>

        <p class="reduce__note" data-testid="reduce-status">
          @switch (store.state()) {
            @case ('loading') {
              running the head…
            }
            @case ('error') {
              <span class="reduce__note--bad">{{ store.error() }}</span>
            }
            @case ('ready') {
              {{ describeMode() }}
              @if (passLine(); as line) {
                · {{ line }}
              }
            }
            @default {
              tick a tile’s checkbox to choose channels
            }
          }
        </p>

        @if (store.result(); as result) {
          <div class="reduce__boards" data-testid="reduce-boards">
            <figure class="reduce__board">
              <ks-board-canvas
                [board]="session.board()"
                [size]="boardSize()"
                [showCoordinates]="false"
                [field]="fullField()"
                [policyMoves]="fullMoves()"
              />
              <figcaption>full head</figcaption>
            </figure>
            <figure class="reduce__board">
              <ks-board-canvas
                [board]="session.board()"
                [size]="boardSize()"
                [showCoordinates]="false"
                [field]="reducedField()"
                [policyMoves]="reducedMoves()"
              />
              <figcaption>{{ store.mode() === 'only' ? 'only selected' : 'without selected' }}</figcaption>
            </figure>
            <figure class="reduce__board">
              <ks-board-canvas
                [board]="session.board()"
                [size]="boardSize()"
                [showCoordinates]="false"
                [field]="differenceField()"
              />
              <figcaption>difference (full − reduced)</figcaption>
            </figure>
          </div>
          <p class="reduce__legend">
            {{
              store.head() === 'ownership'
                ? 'Blue: the side to move owns the point. Orange: the opponent does.'
                : 'Blue: higher logit. Orange: lower. Each board is scaled to its own range.'
            }}
          </p>
        }
      }
    </section>
  `,
  styles: `
    :host {
      display: block;
      min-height: 0;
    }

    .reduce {
      display: flex;
      flex-direction: column;
      gap: 8px;
      padding: 10px;
      border-top: 1px solid var(--ks-border);
      background: var(--ks-surface);
      font-size: 12px;
    }

    .reduce__head {
      display: flex;
      align-items: baseline;
      gap: 10px;
    }

    .reduce__title {
      margin: 0;
      font-size: 13px;
      font-weight: 600;
    }

    .reduce__count,
    .reduce__note,
    .reduce__legend {
      margin: 0;
      color: var(--ks-text-dim);
    }

    .reduce__note--bad {
      color: var(--ks-error);
    }

    .reduce__controls,
    .reduce__selection {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
    }

    .field {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      color: var(--ks-text-dim);
    }

    select {
      font: inherit;
      color: var(--ks-text);
      background: var(--ks-surface-raised);
      border: 1px solid var(--ks-border);
      border-radius: var(--ks-radius);
      padding: 2px 4px;
    }

    .chip {
      padding: 2px 8px;
      font: inherit;
      color: var(--ks-text-dim);
      background: var(--ks-surface-raised);
      border: 1px solid var(--ks-border);
      border-radius: var(--ks-radius);
      cursor: pointer;
    }

    .chip:hover {
      border-color: var(--ks-accent);
    }

    .chip--policy {
      color: rgb(120, 205, 160);
    }

    .chip--value {
      color: rgb(185, 150, 235);
    }

    .reduce__boards {
      display: flex;
      gap: 12px;
      flex-wrap: wrap;
    }

    .reduce__board {
      margin: 0;
      display: flex;
      flex-direction: column;
      gap: 4px;
    }

    .reduce__board ks-board-canvas {
      display: block;
      width: 170px;
      height: 170px;
      border: 1px solid var(--ks-border);
      border-radius: var(--ks-radius);
    }

    .reduce__board figcaption {
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: var(--ks-text-muted);
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ReducePanel {
  protected readonly store = inject(ReduceStore);
  protected readonly session = inject(SessionStore);

  readonly channels = input.required<number>();
  /** Head-lean classification for the last block, when it is known. */
  readonly leans = input<readonly ('policy' | 'value' | 'shared')[] | undefined>(undefined);

  protected readonly boardSize = computed<BoardSize>(
    () => this.session.game()?.game.size ?? this.store.planeSize() ?? squareBoardSize(19),
  );

  protected setHead(value: string): void {
    this.store.setHead(value as HeadKind);
  }

  protected setMode(value: string): void {
    this.store.setMode(value as ReduceMode);
  }

  protected readonly describeMode = computed(() => {
    const count = this.store.selectedCount();
    const noun = count === 1 ? 'channel' : 'channels';
    return this.store.mode() === 'only'
      ? `head re-run with only ${count} ${noun}`
      : `head re-run without ${count} ${noun}`;
  });

  /** The pass logit's shift, which the board overlays cannot show. */
  protected readonly passLine = computed(() => {
    const result = this.store.result();
    if (result === undefined || result.passDifference === undefined) return undefined;
    const full = result.full.pass ?? 0;
    const reduced = result.reduced.pass ?? 0;
    return `pass logit ${full.toFixed(2)} → ${reduced.toFixed(2)}`;
  });

  // ---- fields ------------------------------------------------------------

  /**
   * Crops a network-extent field to the game board.
   *
   * The head runs over the network's extent; the board canvas draws the game.
   * For a 19x19 game on the reference net these are the same and the crop is a
   * copy, which is why getting it wrong would go unnoticed until someone opened
   * a 9x9.
   */
  #crop(values: ArrayLike<number> | undefined): readonly number[] | undefined {
    if (values === undefined) return undefined;
    const planes = this.store.planeSize();
    const board = this.boardSize();
    const out: number[] = [];
    for (let y = 0; y < board.height; y++) {
      for (let x = 0; x < board.width; x++) out.push(values[y * planes.width + x] ?? 0);
    }
    return out;
  }

  /**
   * Scales a field into [-1, 1] for the colour ramp.
   *
   * Ownership is already in range and is passed through untouched -- rescaling
   * it would misreport a quiet position as a decided one. Policy logits have no
   * natural range, so they are scaled by the largest absolute value on the
   * board, which makes each board legible at the cost of making the three
   * boards' colours incomparable. The caption says so.
   */
  #normalise(values: ArrayLike<number> | undefined): readonly number[] | undefined {
    const cropped = this.#crop(values);
    if (cropped === undefined) return undefined;
    if (this.store.head() === 'ownership') return cropped;

    let largest = 0;
    for (const value of cropped) {
      const magnitude = Math.abs(value);
      if (Number.isFinite(magnitude) && magnitude > largest) largest = magnitude;
    }
    if (largest <= 0) return cropped.map(() => 0);
    return cropped.map((value) => (Number.isFinite(value) ? value / largest : 0));
  }

  protected readonly fullField = computed(() =>
    this.#normalise(this.store.result()?.full.values),
  );

  protected readonly reducedField = computed(() =>
    this.#normalise(this.store.result()?.reduced.values),
  );

  protected readonly differenceField = computed(() =>
    this.#normalise(this.store.result()?.difference),
  );

  /** Top-N markers, for the policy head only. */
  #moves(values: ArrayLike<number> | undefined, pass: number | undefined): readonly PolicyMove[] {
    if (values === undefined || this.store.head() !== 'policy') return [];
    const probabilities = policySoftmax(values, pass ?? 0);
    const planes = this.store.planeSize();
    const board = this.boardSize();
    // `topPolicyMoves` expects a board-shaped vector with the pass last.
    const cropped: number[] = [];
    for (let y = 0; y < board.height; y++) {
      for (let x = 0; x < board.width; x++) cropped.push(probabilities[y * planes.width + x] ?? 0);
    }
    cropped.push(probabilities[probabilities.length - 1] ?? 0);
    return topPolicyMoves(cropped, board, TOP_N);
  }

  protected readonly fullMoves = computed(() => {
    const result = this.store.result();
    return this.#moves(result?.full.values, result?.full.pass);
  });

  protected readonly reducedMoves = computed(() => {
    const result = this.store.result();
    return this.#moves(result?.reduced.values, result?.reduced.pass);
  });

  protected readonly showSelectionHint = signal(false);
}
