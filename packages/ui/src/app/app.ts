import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { TabBar, type TabLink } from './shell/tab-bar';

/**
 * Application shell: a fixed tab bar over a single routed pane.
 *
 * The shell owns layout and nothing else. Features live behind the routes.
 */
@Component({
  selector: 'ks-root',
  imports: [RouterOutlet, TabBar],
  templateUrl: './app.html',
  styleUrl: './app.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class App {
  protected readonly tabs: readonly TabLink[] = [
    { path: '/board', label: 'Board' },
    { path: '/diagnostics', label: 'Diagnostics' },
  ];
}
