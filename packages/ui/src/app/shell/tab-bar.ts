import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { RouterLink, RouterLinkActive } from '@angular/router';

export interface TabLink {
  readonly path: string;
  readonly label: string;
}

/** Top-level tab navigation. Presentational: it renders links and nothing else. */
@Component({
  selector: 'ks-tab-bar',
  imports: [RouterLink, RouterLinkActive],
  template: `
    <nav class="tabs" role="tablist">
      @for (tab of tabs(); track tab.path) {
        <a
          class="tabs__tab"
          role="tab"
          [routerLink]="tab.path"
          routerLinkActive="tabs__tab--active"
          #active="routerLinkActive"
          [attr.aria-selected]="active.isActive"
        >
          {{ tab.label }}
        </a>
      }
    </nav>
  `,
  styles: `
    .tabs {
      display: flex;
      gap: 4px;
    }

    .tabs__tab {
      padding: 12px 16px;
      color: var(--ks-text-muted);
      text-decoration: none;
      border-bottom: 2px solid transparent;
      user-select: none;
    }

    .tabs__tab:hover {
      color: var(--ks-text);
    }

    .tabs__tab--active {
      color: var(--ks-text);
      border-bottom-color: var(--ks-accent);
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TabBar {
  readonly tabs = input.required<readonly TabLink[]>();
}
