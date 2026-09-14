import { TestBed } from '@angular/core/testing';
import type { BridgeStatus, ConfigStatus, KatascopeApi } from '@katascope/core';
import { DEFAULT_CONFIG, parseSgf } from '@katascope/core';
import { describe, expect, it, vi } from 'vitest';
import { DiagnosticsPage } from './diagnostics-page';
import { KATASCOPE_API } from '../platform/katascope-api';
import { SessionStore } from '../state/session-store';

const STATUS: BridgeStatus = {
  appVersion: '0.1.0',
  electronVersion: '44.3.0',
  nodeVersion: '24.20.0',
  chromeVersion: '152.0.7977.78',
  subsystems: [
    { name: 'analysis-engine', mode: 'fake', ready: true, detail: 'FakeAnalysisEngine fake-0.1.0' },
    { name: 'activation-store', mode: 'live', ready: false, detail: 'sidecar refused to start' },
  ],
};

const CONFIG: ConfigStatus = {
  config: { ...DEFAULT_CONFIG, katagoPath: '/usr/local/bin/katago' },
  path: '/repo/katascope.config.json',
  problems: [{ field: 'modelPath', message: 'must be set when useFakes is false' }],
};

function render(api: Partial<KatascopeApi> | null) {
  TestBed.configureTestingModule({
    providers: [{ provide: KATASCOPE_API, useValue: api as KatascopeApi | null }],
  });
  return TestBed.createComponent(DiagnosticsPage);
}

/**
 * Switches to the Runtime section.
 *
 * Diagnostics opens on Activations -- the grid is the reason to come here, and
 * the runtime report is what you look at when something is wrong -- so the
 * tests that assert on the report have to ask for it.
 */
async function showRuntime(fixture: ReturnType<typeof render>): Promise<void> {
  await fixture.whenStable();
  const tabs = [...fixture.nativeElement.querySelectorAll('.subnav__item')] as HTMLButtonElement[];
  tabs.find((tab) => tab.textContent?.includes('Runtime'))?.click();
  await fixture.whenStable();
}

function text(fixture: { nativeElement: HTMLElement }): string {
  return fixture.nativeElement.textContent ?? '';
}

describe('DiagnosticsPage', () => {
  it('says so when there is no bridge, rather than throwing', async () => {
    const fixture = render(null);
    await showRuntime(fixture);
    expect(text(fixture)).toContain('Not running under Electron');
    expect(fixture.nativeElement.querySelector('.page__reload')?.disabled).toBe(true);
  });

  it('renders runtime versions from the bridge', async () => {
    const fixture = render({
      getStatus: () => Promise.resolve(STATUS),
      getConfig: () => Promise.resolve(CONFIG),
    });
    await showRuntime(fixture);

    const rendered = text(fixture);
    expect(rendered).toContain('44.3.0');
    expect(rendered).toContain('152.0.7977.78');
    expect(rendered).toContain('24.20.0');
  });

  it('shows each subsystem with its readiness', async () => {
    const fixture = render({
      getStatus: () => Promise.resolve(STATUS),
      getConfig: () => Promise.resolve(CONFIG),
    });
    await showRuntime(fixture);

    const rows = [...fixture.nativeElement.querySelectorAll('.subsystem')] as HTMLElement[];
    expect(rows).toHaveLength(2);
    expect(rows[0]?.querySelector('.dot--ok')).not.toBeNull();
    // A failed subsystem must read as failed, not merely be absent.
    expect(rows[1]?.querySelector('.dot--bad')).not.toBeNull();
    expect(rows[1]?.textContent).toContain('sidecar refused to start');
  });

  it('surfaces config problems instead of hiding them', async () => {
    const fixture = render({
      getStatus: () => Promise.resolve(STATUS),
      getConfig: () => Promise.resolve(CONFIG),
    });
    await showRuntime(fixture);

    const rendered = text(fixture);
    expect(rendered).toContain('/repo/katascope.config.json');
    expect(rendered).toContain('must be set when useFakes is false');
  });

  it('renders a rejected status as an error, not a blank panel', async () => {
    const fixture = render({
      getStatus: () => Promise.reject(new Error('main process is not answering')),
      getConfig: () => Promise.resolve(CONFIG),
    });
    await showRuntime(fixture);
    expect(text(fixture)).toContain('main process is not answering');
  });

  it('re-reads the bridge when Reload is pressed', async () => {
    const getStatus = vi.fn(() => Promise.resolve(STATUS));
    const fixture = render({ getStatus, getConfig: () => Promise.resolve(CONFIG) });
    await showRuntime(fixture);
    expect(getStatus).toHaveBeenCalledTimes(1);

    (fixture.nativeElement.querySelector('.page__reload') as HTMLButtonElement).click();
    await fixture.whenStable();
    expect(getStatus).toHaveBeenCalledTimes(2);
  });
});

describe('DiagnosticsPage: the shared session', () => {
  it('follows the move selection the Board tab made', async () => {
    // The selection is app-wide state, so this tab reflects it without either
    // tab knowing about the other.
    const fixture = render({
      getStatus: () => Promise.resolve(STATUS),
      getConfig: () => Promise.resolve(CONFIG),
    });
    const store = TestBed.inject(SessionStore);
    store.setGame({ path: '/games/shared.sgf', game: parseSgf('(;GM[1]FF[4]SZ[19];B[pd];W[dp])') });
    store.setMoveNumber(2);
    await showRuntime(fixture);

    expect(fixture.nativeElement.querySelector('[data-testid="session-game"]')?.textContent).toContain(
      '/games/shared.sgf',
    );
    expect(fixture.nativeElement.querySelector('[data-testid="session-move"]')?.textContent).toContain(
      '2 / 2',
    );
  });

  it('says so when no game is loaded', async () => {
    const fixture = render({
      getStatus: () => Promise.resolve(STATUS),
      getConfig: () => Promise.resolve(CONFIG),
    });
    await showRuntime(fixture);
    expect(fixture.nativeElement.querySelector('[data-testid="session-game"]')?.textContent).toContain(
      'none loaded',
    );
  });
});
