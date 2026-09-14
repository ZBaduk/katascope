import { ChangeDetectionStrategy, Component, inject, resource, signal } from '@angular/core';
import type { BridgeStatus, ConfigStatus } from '@katascope/core';
import { KATASCOPE_API } from '../platform/katascope-api';

/**
 * Diagnostics tab.
 *
 * Deliberately thin, but not empty: it reads the bridge over IPC, which is what
 * makes an end-to-end wiring failure visible immediately rather than at the
 * point some feature first needs data.
 */
@Component({
  selector: 'ks-diagnostics-page',
  templateUrl: './diagnostics-page.html',
  styleUrl: './diagnostics-page.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class DiagnosticsPage {
  readonly #api = inject(KATASCOPE_API);

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
