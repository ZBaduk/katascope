/**
 * Access to the Electron bridge from the renderer.
 *
 * The renderer must not assume it is running inside Electron: `ng serve` in a
 * plain browser tab is a supported way to work on layout, and there
 * `window.katascope` is absent. Injecting the token yields `null` in that case,
 * and callers are expected to handle it.
 */

import { inject, InjectionToken } from '@angular/core';
import { KATASCOPE_API_KEY, type KatascopeApi } from '@katascope/core';

export const KATASCOPE_API = new InjectionToken<KatascopeApi | null>('KATASCOPE_API', {
  providedIn: 'root',
  factory: () => {
    const api = (globalThis as Record<string, unknown>)[KATASCOPE_API_KEY];
    return (api as KatascopeApi | undefined) ?? null;
  },
});

/** True when running inside Electron with the preload bridge installed. */
export function hasBridge(): boolean {
  return inject(KATASCOPE_API) !== null;
}
