/**
 * The block rail: one tile per residual block, block 0 at the bottom.
 *
 * Bottom-up because that is how a network is drawn everywhere else -- input at
 * the bottom, output at the top -- and a rail that ran the other way would
 * quietly invert the reader's mental model of depth.
 *
 * Scrolls: b18c384 is eighteen blocks, and nets with sixty exist.
 */

import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';

@Component({
  selector: 'ks-block-rail',
  template: `
    <nav class="rail" aria-label="Residual blocks">
      <ol class="rail__list">
        @for (block of blocksTopFirst(); track block) {
          <li>
            <button
              type="button"
              class="rail__block"
              [class.rail__block--selected]="block === selected()"
              [class.rail__block--absent]="!available().has(block)"
              [attr.aria-current]="block === selected() ? 'true' : null"
              [attr.data-block]="block"
              [disabled]="!available().has(block)"
              [title]="label(block)"
              (click)="blockSelected.emit(block)"
            >
              {{ block }}
            </button>
          </li>
        }
      </ol>
      <p class="rail__legend">block</p>
    </nav>
  `,
  styles: `
    :host {
      display: block;
      min-height: 0;
      height: 100%;
    }

    .rail {
      display: flex;
      flex-direction: column;
      height: 100%;
      min-height: 0;
      gap: 6px;
      padding: 6px;
      background: var(--ks-surface);
      border-right: 1px solid var(--ks-border);
    }

    .rail__list {
      list-style: none;
      margin: 0;
      padding: 0;
      display: flex;
      flex-direction: column;
      gap: 3px;
      overflow-y: auto;
      min-height: 0;
      flex: 1;
    }

    .rail__block {
      width: 38px;
      padding: 5px 0;
      font: inherit;
      font-size: 11px;
      font-variant-numeric: tabular-nums;
      color: var(--ks-text-muted);
      background: var(--ks-surface-raised);
      border: 1px solid var(--ks-border);
      border-radius: var(--ks-radius);
      cursor: pointer;
    }

    .rail__block:hover:not(:disabled) {
      color: var(--ks-text);
      border-color: var(--ks-accent);
    }

    .rail__block--selected {
      color: var(--ks-bg);
      background: var(--ks-accent);
      border-color: var(--ks-accent);
      font-weight: 600;
    }

    /* A block the capture does not hold is shown, not omitted: the gap is
       information, and hiding it would silently renumber the rail. */
    .rail__block--absent {
      opacity: 0.3;
      cursor: default;
    }

    .rail__legend {
      margin: 0;
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: var(--ks-text-muted);
      text-align: center;
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class BlockRail {
  readonly blocks = input.required<number>();
  readonly selected = input.required<number>();
  /** Blocks that actually have data. Undefined means all of them. */
  readonly present = input<readonly number[] | undefined>(undefined);
  readonly channels = input<number | undefined>(undefined);

  readonly blockSelected = output<number>();

  /** Deepest block first, so block 0 renders at the bottom of the column. */
  protected readonly blocksTopFirst = computed(() =>
    Array.from({ length: Math.max(0, this.blocks()) }, (_, i) => this.blocks() - 1 - i),
  );

  protected readonly available = computed<ReadonlySet<number>>(() => {
    const present = this.present();
    return present === undefined
      ? new Set(Array.from({ length: this.blocks() }, (_, i) => i))
      : new Set(present);
  });

  protected label(block: number): string {
    const channels = this.channels();
    const suffix = channels === undefined ? '' : ` · ${channels} channels`;
    return this.available().has(block)
      ? `Block ${block}${suffix}`
      : `Block ${block} — not in this capture`;
  }
}
