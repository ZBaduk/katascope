/**
 * Declares the bridge the preload script installs on `window`.
 *
 * The type comes from `@katascope/core` so the renderer and the Electron main
 * process cannot drift apart. It is optional: the app also runs in a plain
 * browser tab via `ng serve`, where nothing is installed.
 */

import type { KatascopeApi } from '@katascope/core';

declare global {
  interface Window {
    readonly katascope?: KatascopeApi;
  }
}

export {};
