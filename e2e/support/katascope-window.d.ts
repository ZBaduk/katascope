/**
 * Declares the preload bridge for code running inside `page.evaluate`.
 *
 * The UI package has its own copy of this for app code. Both take the shape
 * from `KatascopeApi` in `@katascope/core`, so they cannot disagree about what
 * the bridge looks like -- only about whether it is present, which is the point
 * of the optional marker in each.
 */

import type { KatascopeApi } from '@katascope/core';

declare global {
  interface Window {
    readonly katascope?: KatascopeApi;
  }
}

export {};
