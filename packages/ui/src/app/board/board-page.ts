import { ChangeDetectionStrategy, Component } from '@angular/core';

/**
 * Board tab. Placeholder: the goban, move navigation and activation overlays
 * all land here, and none of them are built yet.
 */
@Component({
  selector: 'ks-board-page',
  template: `
    <section class="page">
      <h1 class="page__title">Board</h1>
      <p class="page__note">
        No features yet. The goban, move navigation and per-block activation overlays go here.
      </p>
    </section>
  `,
  styles: `
    .page {
      padding: 24px;
    }

    .page__title {
      margin: 0 0 8px;
      font-size: 18px;
      font-weight: 600;
    }

    .page__note {
      margin: 0;
      color: var(--ks-text-muted);
      max-width: 60ch;
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class BoardPage {}
