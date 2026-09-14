import { ChangeDetectionStrategy, Component, inject, resource, signal } from '@angular/core';
import type { BridgeStatus, ConfigStatus } from '@katascope/core';
import { KATASCOPE_API } from '../platform/katascope-api';
import { SessionStore } from '../state/session-store';
import { ActivationView } from '../activation/activation-view';

/**
 * Diagnostics tab.
 *
 * Deliberately thin, but not empty: it reads the bridge over IPC, which is what
 * makes an end-to-end wiring failure visible immediately rather than at the
 * point some feature first needs data.
 */
@Component({
  selector: 'ks-diagnostics-page',
  imports: [ActivationView],
  templateUrl: './diagnostics-page.html',
  styleUrl: './diagnostics-page.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class DiagnosticsPage {
  readonly #api = inject(KATASCOPE_API);

  /**
   * The same store the Board tab writes to.
   *
   * Shown here so "the move selection is app-wide" is something you can see
   * rather than something the architecture document claims: step a move on the
   * Board tab, switch here, and the number has followed.
   */
  protected readonly session = inject(SessionStore);

  /**
   * Which half of Diagnostics is showing.
   *
   * The activation grid is the reason to open this tab; the runtime and config
   * report is what you look at when something is wrong. Activations first.
   */
  protected readonly section = signal<'activations' | 'runtime'>('activations');

  /** Absent outside Electron, e.g. when the app is opened via `ng serve`. */
  protected readonly connected = this.#api !== null;

  /** Bumped to re-run both resources. */
  readonly #reloadToken = signal(0);

  protected readonly status = resource<BridgeStatus | null, number>({
    params: () => this.#reloadToken(),
    loader: async () => this.#api?.getStatus() ?? null,
  });

  protected readonly config = resource<ConfigStatus | null, number>({
    params: () => this.#reloadToken(),
    loader: async () => this.#api?.getConfig() ?? null,
  });

  protected reload(): void {
    this.#reloadToken.update((n) => n + 1);
  }

  protected errorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
