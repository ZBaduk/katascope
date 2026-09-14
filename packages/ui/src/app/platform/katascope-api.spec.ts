import { TestBed } from '@angular/core/testing';
import { KATASCOPE_API_KEY, type KatascopeApi } from '@katascope/core';
import { afterEach, describe, expect, it } from 'vitest';
import { KATASCOPE_API } from './katascope-api';

/**
 * The renderer runs in two contexts -- inside Electron, and in a plain browser
 * tab via `ng serve`. Getting `null` in the second case is the contract, not an
 * edge case, so it is tested first.
 */
describe('KATASCOPE_API', () => {
  afterEach(() => {
    delete (globalThis as Record<string, unknown>)[KATASCOPE_API_KEY];
  });

  it('is null when no preload bridge is installed', () => {
    expect(TestBed.runInInjectionContext(() => TestBed.inject(KATASCOPE_API))).toBeNull();
  });

  it('returns the bridge the preload script exposed', () => {
    const bridge = { getConfig: () => Promise.resolve() } as unknown as KatascopeApi;
    (globalThis as Record<string, unknown>)[KATASCOPE_API_KEY] = bridge;
    expect(TestBed.inject(KATASCOPE_API)).toBe(bridge);
  });
});
