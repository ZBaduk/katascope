/**
 * Move navigation: buttons and a slider over the shared move selection.
 *
 * Presentational -- it reads and writes `SessionStore` and holds no state of
 * its own, so the Diagnostics tab follows along without either tab knowing
 * about the other.
 */

import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { SessionStore } from '../state/session-store';

@Component({
  selector: 'ks-move-navigator',
  template: `
    <div class="nav">
      <div class="nav__buttons" role="group" aria-label="Move navigation">
        <button type="button" (click)="store.firstMove()" [disabled]="atStart()" title="First move (Home)">⏮</button>
        <button type="button" (click)="store.stepMove(-1)" [disabled]="atStart()" title="Previous move (←)">◀</button>
        <button type="button" (click)="store.stepMove(1)" [disabled]="atEnd()" title="Next move (→)">▶</button>
        <button type="button" (click)="store.lastMove()" [disabled]="atEnd()" title="Last move (End)">⏭</button>
      </div>

      <input
        class="nav__slider"
        type="range"
        min="0"
        [max]="store.lastMoveNumber()"
        [value]="store.moveNumber()"
        [disabled]="!store.hasGame()"
        aria-label="Move number"
        (input)="onSlide($event)"
      />

      <span class="nav__counter" data-testid="move-number">{{ store.moveNumber() }}</span>
      <span class="nav__total">/ {{ store.lastMoveNumber() }}</span>
    </div>
  `,
  styles: `
    .nav {
      display: flex;
      align-items: center;
      gap: 12px;
    }

    .nav__buttons {
      display: flex;
      gap: 4px;
    }

    button {
      min-width: 34px;
      padding: 5px 8px;
      font: inherit;
      color: var(--ks-text);
      background: var(--ks-surface-raised);
      border: 1px solid var(--ks-border);
      border-radius: var(--ks-radius);
      cursor: pointer;
    }

    button:hover:not(:disabled) {
      border-color: var(--ks-accent);
    }

    button:disabled {
      opacity: 0.4;
      cursor: default;
    }

    .nav__slider {
      flex: 1;
      min-width: 120px;
      accent-color: var(--ks-accent);
    }

    .nav__counter {
      font-family: var(--ks-font-mono);
      font-variant-numeric: tabular-nums;
      min-width: 3ch;
      text-align: right;
    }

    .nav__total {
      color: var(--ks-text-muted);
      font-family: var(--ks-font-mono);
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MoveNavigator {
  protected readonly store = inject(SessionStore);

  protected readonly atStart = computed(() => !this.store.hasGame() || this.store.moveNumber() <= 0);
  protected readonly atEnd = computed(
    () => !this.store.hasGame() || this.store.moveNumber() >= this.store.lastMoveNumber(),
  );

  protected onSlide(event: Event): void {
    const target = event.target as HTMLInputElement;
    this.store.setMoveNumber(Number(target.value));
  }
}
