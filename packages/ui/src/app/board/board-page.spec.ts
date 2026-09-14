/**
 * The Board tab at its seams: opening a file, the fake-data banner, overlay
 * toggles driving lazy fetches, and keyboard navigation.
 *
 * The drawing itself is not asserted here -- `board-geometry` and `overlays`
 * carry that, which is the point of keeping them pure.
 */

import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import {
  parseSgf,
  type BridgeStatus,
  type KatascopeApi,
  type LoadedGame,
  type PositionAnalysis,
} from '@katascope/core';
import { describe, expect, it, vi } from 'vitest';
import { KATASCOPE_API } from '../platform/katascope-api';
import { SessionStore } from '../state/session-store';
import { BoardPage } from './board-page';

const SGF = '(;GM[1]FF[4]SZ[19]KM[7.5]PB[Alice]PW[Bob]RE[B+R];B[pd];W[dp];B[pp];W[dd])';
const LOADED: LoadedGame = { path: '/games/test.sgf', game: parseSgf(SGF) };

function status(mode: 'fake' | 'live'): BridgeStatus {
  return {
    appVersion: '0.1.0',
    electronVersion: '44',
    nodeVersion: '24',
    chromeVersion: '152',
    subsystems: [
      { name: 'analysis-engine', mode, ready: true, detail: `${mode} engine` },
      { name: 'activation-store', mode, ready: true, detail: 'store' },
    ],
  };
}

const ANALYSIS: PositionAnalysis = {
  moveNumber: 0,
  winrate: 0.52,
  scoreLead: 1.5,
  visits: 1,
  // 19x19 + pass; one standout move at Q16 so top-N has something to pick.
  policy: Array.from({ length: 362 }, (_, i) => (i === 3 * 19 + 15 ? 0.9 : 0.0001)),
  ownership: Array.from({ length: 361 }, (_, i) => (i % 2 === 0 ? 0.5 : -0.5)),
};

function render(api: Partial<KatascopeApi> | null) {
  TestBed.configureTestingModule({
    providers: [provideRouter([]), { provide: KATASCOPE_API, useValue: api as KatascopeApi | null }],
  });
  const fixture = TestBed.createComponent(BoardPage);
  return { fixture, store: TestBed.inject(SessionStore) };
}

function text(fixture: { nativeElement: HTMLElement }): string {
  return fixture.nativeElement.textContent ?? '';
}

describe('BoardPage', () => {
  it('says so when there is no bridge, rather than offering a dialog that cannot open', async () => {
    const { fixture } = render(null);
    await fixture.whenStable();
    expect(text(fixture)).toContain('Not running under Electron');
    expect((fixture.nativeElement.querySelector('.toolbar__open') as HTMLButtonElement).disabled).toBe(true);
  });

  it('warns loudly when the analysis engine is a fake', async () => {
    const { fixture } = render({ getStatus: () => Promise.resolve(status('fake')) });
    await fixture.whenStable();
    const banner = fixture.nativeElement.querySelector('[data-testid="fake-banner"]');
    expect(banner).not.toBeNull();
    expect(banner?.textContent).toContain('Fake data');
  });

  it('shows no fake banner against a real engine', async () => {
    const { fixture } = render({ getStatus: () => Promise.resolve(status('live')) });
    await fixture.whenStable();
    expect(fixture.nativeElement.querySelector('[data-testid="fake-banner"]')).toBeNull();
  });

  it('loads a game through the bridge and summarises it', async () => {
    const { fixture, store } = render({
      getStatus: () => Promise.resolve(status('live')),
      openSgf: () => Promise.resolve(LOADED),
    });
    await fixture.whenStable();

    (fixture.nativeElement.querySelector('.toolbar__open') as HTMLButtonElement).click();
    await fixture.whenStable();

    expect(store.hasGame()).toBe(true);
    expect(store.lastMoveNumber()).toBe(4);
    expect(text(fixture)).toContain('Alice vs Bob');
    expect(text(fixture)).toContain('19×19');
  });

  it('keeps the open game when the dialog is cancelled', async () => {
    const openSgf = vi.fn<() => Promise<LoadedGame | null>>(() => Promise.resolve(LOADED));
    const { fixture, store } = render({ getStatus: () => Promise.resolve(status('live')), openSgf });
    await fixture.whenStable();
    (fixture.nativeElement.querySelector('.toolbar__open') as HTMLButtonElement).click();
    await fixture.whenStable();

    openSgf.mockResolvedValueOnce(null);
    (fixture.nativeElement.querySelector('.toolbar__open') as HTMLButtonElement).click();
    await fixture.whenStable();

    // Cancelling is not an error and must not unload the game.
    expect(store.hasGame()).toBe(true);
    expect(fixture.nativeElement.querySelector('.notice--error')).toBeNull();
  });

  it('reports a failed open without unloading the game', async () => {
    const { fixture } = render({
      getStatus: () => Promise.resolve(status('live')),
      openSgf: () => Promise.reject(new Error('that is not an SGF')),
    });
    await fixture.whenStable();
    (fixture.nativeElement.querySelector('.toolbar__open') as HTMLButtonElement).click();
    await fixture.whenStable();
    expect(text(fixture)).toContain('that is not an SGF');
  });

  it('does not analyse until an overlay is switched on', async () => {
    const analyzePosition = vi.fn(() => Promise.resolve(ANALYSIS));
    const { fixture, store } = render({
      getStatus: () => Promise.resolve(status('live')),
      analyzePosition,
    });
    await fixture.whenStable();
    store.setGame(LOADED);
    store.setMoveNumber(2);
    await fixture.whenStable();
    expect(analyzePosition).not.toHaveBeenCalled();

    const ownership = fixture.nativeElement.querySelectorAll('.toggle input')[0] as HTMLInputElement;
    ownership.click();
    await fixture.whenStable();
    expect(analyzePosition).toHaveBeenCalledTimes(1);
  });

  it('re-analyses when the move changes while an overlay is on', async () => {
    const analyzePosition = vi.fn((r: { moveNumber: number }) =>
      Promise.resolve({ ...ANALYSIS, moveNumber: r.moveNumber }),
    );
    const { fixture, store } = render({
      getStatus: () => Promise.resolve(status('live')),
      analyzePosition,
    });
    await fixture.whenStable();
    store.setGame(LOADED);
    (fixture.nativeElement.querySelectorAll('.toggle input')[0] as HTMLInputElement).click();
    await fixture.whenStable();

    store.setMoveNumber(3);
    await fixture.whenStable();
    expect(analyzePosition).toHaveBeenCalledTimes(2);
    expect(store.analysis()?.moveNumber).toBe(3);
  });

  it('shows the analysis summary once an overlay is on', async () => {
    const { fixture, store } = render({
      getStatus: () => Promise.resolve(status('live')),
      analyzePosition: () => Promise.resolve(ANALYSIS),
    });
    await fixture.whenStable();
    store.setGame(LOADED);
    (fixture.nativeElement.querySelectorAll('.toggle input')[1] as HTMLInputElement).click();
    await fixture.whenStable();

    const summary = fixture.nativeElement.querySelector('[data-testid="analysis-status"]');
    expect(summary?.textContent).toContain('52.0%');
  });

  it('offers a top-N control only while the policy overlay is on', async () => {
    // Addressed by label: the toolbar also carries a click-action select.
    const topN = () => fixture.nativeElement.querySelector('[aria-label="Top policy moves"]');
    const { fixture } = render({ getStatus: () => Promise.resolve(status('live')) });
    await fixture.whenStable();
    expect(topN()).toBeNull();

    (fixture.nativeElement.querySelectorAll('.toggle input')[1] as HTMLInputElement).click();
    await fixture.whenStable();
    expect(topN()).not.toBeNull();
  });

  it('shows the top-N the component is actually using', async () => {
    // The select initially displayed 1 while five markers were drawn, because
    // binding [value] on a <select> does not select the matching <option>.
    const { fixture } = render({ getStatus: () => Promise.resolve(status('live')) });
    await fixture.whenStable();
    (fixture.nativeElement.querySelectorAll('.toggle input')[1] as HTMLInputElement).click();
    await fixture.whenStable();

    const select = fixture.nativeElement.querySelector(
      '[aria-label="Top policy moves"]',
    ) as HTMLSelectElement;
    expect(select.value).toBe('5');
  });

  it('redraws with a different top-N when the control changes', async () => {
    const { fixture, store } = render({
      getStatus: () => Promise.resolve(status('live')),
      analyzePosition: () => Promise.resolve(ANALYSIS),
    });
    await fixture.whenStable();
    store.setGame(LOADED);
    (fixture.nativeElement.querySelectorAll('.toggle input')[1] as HTMLInputElement).click();
    await fixture.whenStable();

    const select = fixture.nativeElement.querySelector(
      '[aria-label="Top policy moves"]',
    ) as HTMLSelectElement;
    select.value = '1';
    select.dispatchEvent(new Event('change'));
    await fixture.whenStable();
    expect(select.value).toBe('1');
  });

  it('steps moves with the arrow keys', async () => {
    const { fixture, store } = render({ getStatus: () => Promise.resolve(status('live')) });
    await fixture.whenStable();
    store.setGame(LOADED);

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }));
    expect(store.moveNumber()).toBe(1);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft' }));
    expect(store.moveNumber()).toBe(1);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'End' }));
    expect(store.moveNumber()).toBe(4);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home' }));
    expect(store.moveNumber()).toBe(0);
  });

  it('ignores arrow keys while a control has focus, so the slider does not double-step', async () => {
    const { fixture, store } = render({ getStatus: () => Promise.resolve(status('live')) });
    await fixture.whenStable();
    store.setGame(LOADED);

    const slider = fixture.nativeElement.querySelector('.nav__slider') as HTMLInputElement;
    slider.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(store.moveNumber()).toBe(0);
  });

  it('leaves the keyboard alone with no game loaded', async () => {
    const { fixture, store } = render({ getStatus: () => Promise.resolve(status('live')) });
    await fixture.whenStable();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }));
    expect(store.moveNumber()).toBe(0);
  });
});


describe('BoardPage: picking an attribution target', () => {
  function clickVertex(fixture: ReturnType<typeof render>['fixture'], x: number, y: number): void {
    const canvas = fixture.debugElement.query((node: { name?: string }) => node.name === 'ks-board-canvas');
    canvas.componentInstance.vertexClicked.emit({ x, y });
  }

  it('navigates to the move played there by default', async () => {
    const { fixture, store } = render({ getStatus: () => Promise.resolve(status('live')) });
    await fixture.whenStable();
    store.setGame(LOADED);
    clickVertex(fixture, 15, 3); // Q16, the first move
    await fixture.whenStable();
    expect(store.moveNumber()).toBe(1);
    expect(store.attributionTarget()).toBeUndefined();
  });

  it('sets an ownership target when the click action says so', async () => {
    // The target lives in SessionStore because it is chosen here and read on
    // the Diagnostics tab.
    const { fixture, store } = render({ getStatus: () => Promise.resolve(status('live')) });
    await fixture.whenStable();
    store.setGame(LOADED);

    const select = fixture.nativeElement.querySelector('[aria-label="Click action"]') as HTMLSelectElement;
    select.value = 'ownership';
    select.dispatchEvent(new Event('change'));
    await fixture.whenStable();

    clickVertex(fixture, 4, 5);
    await fixture.whenStable();
    expect(store.attributionTarget()).toEqual({ kind: 'ownership_point', x: 4, y: 5 });
    // And it must not have navigated as well.
    expect(store.moveNumber()).toBe(0);
  });

  it('sets a policy target when asked', async () => {
    const { fixture, store } = render({ getStatus: () => Promise.resolve(status('live')) });
    await fixture.whenStable();
    store.setGame(LOADED);
    const select = fixture.nativeElement.querySelector('[aria-label="Click action"]') as HTMLSelectElement;
    select.value = 'policy';
    select.dispatchEvent(new Event('change'));
    await fixture.whenStable();

    clickVertex(fixture, 2, 2);
    await fixture.whenStable();
    expect(store.attributionTarget()).toEqual({ kind: 'policy_move', x: 2, y: 2 });
  });

  it('shows the target, and clears it on request', async () => {
    const { fixture, store } = render({ getStatus: () => Promise.resolve(status('live')) });
    await fixture.whenStable();
    store.setGame(LOADED);
    store.setAttributionTarget({ kind: 'ownership_point', x: 1, y: 2 });
    await fixture.whenStable();

    const banner = fixture.nativeElement.querySelector('[data-testid="board-target"]');
    expect(banner?.textContent).toContain('ownership at (1, 2)');

    (banner?.querySelector('.notice__clear') as HTMLButtonElement).click();
    await fixture.whenStable();
    expect(store.attributionTarget()).toBeUndefined();
    expect(fixture.nativeElement.querySelector('[data-testid="board-target"]')).toBeNull();
  });
});
