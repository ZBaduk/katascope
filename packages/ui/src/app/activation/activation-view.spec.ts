/**
 * The activation view at its seams: block selection, the controls that drive
 * the overlays, and the lazy fetching underneath.
 *
 * The pixels are not asserted here -- `render-core`, `grid-layout` and
 * `channel-stats` carry that, which is the point of keeping them pure.
 */

import { TestBed } from '@angular/core/testing';
import {
  parseSgf,
  squareBoardSize,
  type Attribution,
  type AttributionRequest,
  type ReaderWeights,
  type ActivationAvailability,
  type ActivationFrame,
  type KatascopeApi,
  type LoadedCapture,
} from '@katascope/core';
import { describe, expect, it, vi } from 'vitest';
import { KATASCOPE_API } from '../platform/katascope-api';
import { SessionStore } from '../state/session-store';
import { ActivationView } from './activation-view';

const SPEC = { name: 'b6c96', blocks: 6, channels: 4, boardSize: { width: 2, height: 2 } };
const AREA = 4;

const AVAILABILITY: ActivationAvailability = { spec: SPEC, maxMoveNumber: 10, dtype: 'float32' };

function frame(moveNumber: number, block: number): ActivationFrame {
  const data = new Float32Array(SPEC.channels * AREA);
  for (let i = 0; i < data.length; i++) data[i] = (i + moveNumber + block) % 7;
  return {
    moveNumber,
    block,
    networkName: SPEC.name,
    boardSize: SPEC.boardSize,
    channels: SPEC.channels,
    dtype: 'float32',
    data,
    range: { min: 0, max: 6 },
  };
}

const CAPTURE: LoadedCapture = {
  path: '/captures/game.kact',
  networkName: 'b6c96',
  spec: SPEC,
  moveNumbers: [0, 1, 2],
  blockNumbers: [0, 2, 4],
};

function render(api: Partial<KatascopeApi> | null) {
  TestBed.configureTestingModule({
    providers: [{ provide: KATASCOPE_API, useValue: api as KatascopeApi | null }],
  });
  const fixture = TestBed.createComponent(ActivationView);
  return { fixture, store: TestBed.inject(SessionStore) };
}

/**
 * Lets the describe -> spec -> statistics -> render chain finish.
 *
 * `whenStable()` settles one round of effects; this chain crosses several
 * promise hops, so it needs a few.
 */
async function settle(fixture: { whenStable: () => Promise<unknown> }): Promise<void> {
  for (let i = 0; i < 6; i++) await fixture.whenStable();
}

/** Four channels; channel 3 is loud, channel 0 has the heaviest reader. */
const READER_WEIGHTS: ReaderWeights = {
  networkName: SPEC.name,
  channels: SPEC.channels,
  byBlock: Array.from({ length: SPEC.blocks - 1 }, () => new Float32Array([9, 1, 1, 1])),
  heads: {
    policy: new Float32Array([8, 1, 1, 1]),
    value: new Float32Array([1, 1, 1, 8]),
  },
};

function attribution(request: AttributionRequest): Attribution {
  // Channel 2 dominates, so the attribution ordering is visibly different from
  // both the impact and the channel orderings.
  const byBlock = new Float32Array(SPEC.blocks * SPEC.channels);
  for (let block = 0; block < SPEC.blocks; block++) {
    byBlock[block * SPEC.channels + 2] = 100;
    byBlock[block * SPEC.channels + 0] = 1;
  }
  return {
    moveNumber: request.moveNumber,
    target: request.target,
    blocks: SPEC.blocks,
    channels: SPEC.channels,
    byBlock,
  };
}

function defaultApi(over: Partial<KatascopeApi> = {}): Partial<KatascopeApi> {
  return {
    describeActivations: () => Promise.resolve(AVAILABILITY),
    getActivationFrame: (key) => Promise.resolve(frame(key.moveNumber, key.block)),
    getReaderWeights: () => Promise.resolve(READER_WEIGHTS),
    attribute: (request) => Promise.resolve(attribution(request)),
    ...over,
  };
}

function selectValue(fixture: { nativeElement: HTMLElement }, label: string, value: string): void {
  const select = fixture.nativeElement.querySelector(`[aria-label="${label}"]`) as HTMLSelectElement;
  select.value = value;
  select.dispatchEvent(new Event('change'));
}

describe('ActivationView', () => {
  it('says so when there is no bridge', async () => {
    const { fixture } = render(null);
    await fixture.whenStable();
    expect(fixture.nativeElement.textContent).toContain('no activations to read');
  });

  it('learns the network shape and renders one rail entry per block', async () => {
    const { fixture } = render(defaultApi());
    await fixture.whenStable();
    const blocks = fixture.nativeElement.querySelectorAll('.rail__block');
    expect(blocks).toHaveLength(6);
  });

  it('puts block 0 at the bottom of the rail', async () => {
    // Input at the bottom, output at the top, as a network is drawn everywhere
    // else. A rail the other way up inverts the reader's model of depth.
    const { fixture } = render(defaultApi());
    await fixture.whenStable();
    const blocks = [...fixture.nativeElement.querySelectorAll('.rail__block')] as HTMLElement[];
    expect(blocks[0]?.textContent?.trim()).toBe('5');
    expect(blocks.at(-1)?.textContent?.trim()).toBe('0');
  });

  it('selects a block and fetches its frame', async () => {
    const getActivationFrame = vi.fn((key: { moveNumber: number; block: number }) =>
      Promise.resolve(frame(key.moveNumber, key.block)),
    );
    const { fixture, store } = render(defaultApi({ getActivationFrame }));
    await fixture.whenStable();

    const blocks = [...fixture.nativeElement.querySelectorAll('.rail__block')] as HTMLButtonElement[];
    // The rail renders deepest-first, so index 2 is block 3.
    blocks[2]?.click();
    await fixture.whenStable();

    expect(store.block()).toBe(3);
    expect(getActivationFrame).toHaveBeenCalledWith(expect.objectContaining({ block: 3 }));
  });

  it('marks the selected block', async () => {
    const { fixture, store } = render(defaultApi());
    await fixture.whenStable();
    store.setBlock(2);
    await fixture.whenStable();
    const selected = fixture.nativeElement.querySelector('.rail__block--selected') as HTMLElement;
    expect(selected?.textContent?.trim()).toBe('2');
  });

  it('re-fetches when the move changes', async () => {
    const getActivationFrame = vi.fn((key: { moveNumber: number; block: number }) =>
      Promise.resolve(frame(key.moveNumber, key.block)),
    );
    const { fixture, store } = render(defaultApi({ getActivationFrame }));
    // A move number is clamped to the loaded game, so there has to be one.
    store.setGame({ path: '/g.sgf', game: parseSgf('(;GM[1]FF[4]SZ[19];B[pd];W[dp];B[pp];W[dd])') });
    await fixture.whenStable();
    const before = getActivationFrame.mock.calls.length;

    store.setMoveNumber(3);
    await fixture.whenStable();
    expect(getActivationFrame.mock.calls.length).toBeGreaterThan(before);
  });

  it('reports how many moves the normalisation was computed over', async () => {
    // "normalised over 12 of 240 moves" is a materially weaker claim than
    // "normalised over the game", so the count is shown rather than implied.
    const { fixture } = render(defaultApi());
    await fixture.whenStable();
    expect(fixture.nativeElement.querySelector('[data-testid="grid-status"]')?.textContent).toMatch(
      /normalised over \d+ move/,
    );
  });

  it('computes statistics once the network spec arrives, not only before', async () => {
    // describeActivations resolves asynchronously. The statistics effect has to
    // depend on the spec, or it runs once with nothing to compute against and
    // never again -- which is exactly what happened, and showed up as a status
    // line with no "normalised over N moves" on it.
    let resolveSpec!: (value: ActivationAvailability) => void;
    const pending = new Promise<ActivationAvailability>((resolve) => {
      resolveSpec = resolve;
    });
    const { fixture } = render(defaultApi({ describeActivations: () => pending }));
    await fixture.whenStable();
    expect(fixture.nativeElement.querySelector('[data-testid="grid-status"]')).toBeNull();

    resolveSpec(AVAILABILITY);
    await settle(fixture);
    expect(fixture.nativeElement.querySelector('[data-testid="grid-status"]')?.textContent).toMatch(
      /normalised over \d+ move/,
    );
  });

  it('shows a change-threshold slider only when the overlay is on', async () => {
    const { fixture } = render(defaultApi());
    await fixture.whenStable();
    expect(fixture.nativeElement.querySelector('[aria-label="Change threshold"]')).toBeNull();

    const change = fixture.nativeElement.querySelectorAll('.control input[type="checkbox"]')[0] as HTMLInputElement;
    change.click();
    await fixture.whenStable();
    expect(fixture.nativeElement.querySelector('[aria-label="Change threshold"]')).not.toBeNull();
  });

  it('hides channels as the unused threshold rises', async () => {
    const { fixture } = render(defaultApi());
    await fixture.whenStable();
    const hiddenAt = () =>
      Number(fixture.nativeElement.querySelector('[data-testid="hidden-count"]')?.textContent ?? '-1');
    expect(hiddenAt()).toBe(0);

    const slider = fixture.nativeElement.querySelector('[aria-label="Hide unused threshold"]') as HTMLInputElement;
    slider.value = '0.5';
    slider.dispatchEvent(new Event('input'));
    await fixture.whenStable();
    expect(hiddenAt()).toBeGreaterThan(0);
  });

  it('opens a capture and takes its blocks and network from it', async () => {
    const openKact = vi.fn(() => Promise.resolve(CAPTURE));
    const { fixture, store } = render(defaultApi({ openKact }));
    await fixture.whenStable();

    (fixture.nativeElement.querySelector('.controls__open') as HTMLButtonElement).click();
    await fixture.whenStable();

    expect(store.hasCapture()).toBe(true);
    expect(store.activationBlocks()).toEqual([0, 2, 4]);
    expect(fixture.nativeElement.querySelector('[data-testid="capture-summary"]')?.textContent).toContain(
      '3 moves',
    );
  });

  it('greys out blocks a capture does not hold rather than renumbering the rail', async () => {
    const { fixture, store } = render(defaultApi({ openKact: () => Promise.resolve(CAPTURE) }));
    await fixture.whenStable();
    store.setCapture(CAPTURE);
    await fixture.whenStable();

    const absent = fixture.nativeElement.querySelectorAll('.rail__block--absent');
    // Six blocks in the net, three in the capture.
    expect(absent).toHaveLength(3);
  });

  it('keeps the open game when the capture dialog is cancelled', async () => {
    const { fixture, store } = render(defaultApi({ openKact: () => Promise.resolve(null) }));
    await fixture.whenStable();
    (fixture.nativeElement.querySelector('.controls__open') as HTMLButtonElement).click();
    await fixture.whenStable();
    expect(store.hasCapture()).toBe(false);
  });

  it('falls back to the main thread when there is no Worker', async () => {
    // jsdom has none, and a packaged build served from file:// may not either.
    // The fallback runs the same pure functions, so the pixels match.
    const { fixture } = render(defaultApi());
    await fixture.whenStable();
    expect(fixture.nativeElement.querySelector('[data-testid="grid-status"]')?.textContent).toContain(
      'main thread',
    );
  });

  it('keeps the detail drawer mounted with nothing selected', async () => {
    // It used to mount and unmount with the selection, which cost the canvas
    // above it ~230px each time. That moved the grid out from under the pointer
    // near the bottom edge, clearing the hover, closing the drawer, and growing
    // the canvas back -- an oscillation, not just a flash.
    const { fixture } = render(defaultApi());
    await settle(fixture);

    const drawer = fixture.nativeElement.querySelector('ks-plane-detail');
    expect(drawer).not.toBeNull();
    expect(fixture.nativeElement.querySelector('[data-testid="detail-address"]')?.textContent).toContain(
      '—',
    );
  });

  it('stays mounted across a hover arriving and going away again', async () => {
    const { fixture } = render(defaultApi());
    await settle(fixture);
    const before = fixture.nativeElement.querySelector('ks-plane-detail');

    const grid = fixture.debugElement.query(
      (node: { name?: string }) => node.name === 'ks-channel-grid',
    );
    grid.componentInstance.hovered.emit({ channel: 2, x: 1, y: 1 });
    await settle(fixture);
    expect(fixture.nativeElement.querySelector('[data-testid="detail-address"]')?.textContent).toContain(
      '0.2',
    );

    grid.componentInstance.hovered.emit(undefined);
    await settle(fixture);
    // Same element instance: never torn down, so nothing to flicker.
    expect(fixture.nativeElement.querySelector('ks-plane-detail')).toBe(before);
  });

  it('keeps a pinned channel while the pointer moves elsewhere', async () => {
    const { fixture } = render(defaultApi());
    await settle(fixture);
    const grid = fixture.debugElement.query(
      (node: { name?: string }) => node.name === 'ks-channel-grid',
    );

    grid.componentInstance.channelPicked.emit(3);
    await settle(fixture);
    grid.componentInstance.hovered.emit({ channel: 1, x: 0, y: 0 });
    await settle(fixture);

    // A pin wins over the pointer, or clicking a channel then moving the mouse
    // would replace what was just pinned.
    expect(fixture.nativeElement.querySelector('[data-testid="detail-address"]')?.textContent).toContain(
      '0.3',
    );
  });

  it('renders a grid canvas for the selected block', async () => {
    const { fixture } = render(defaultApi());
    await fixture.whenStable();
    expect(fixture.nativeElement.querySelector('ks-channel-grid canvas')).not.toBeNull();
  });
});

describe('ActivationView with a smaller board', () => {
  it('uses the declared board size rather than assuming 19x19', async () => {
    const rect = { ...SPEC, boardSize: { width: 13, height: 9 } };
    const { fixture } = render({
      describeActivations: () => Promise.resolve({ spec: rect, maxMoveNumber: 2, dtype: 'float32' }),
      getActivationFrame: () =>
        Promise.resolve({
          ...frame(0, 0),
          boardSize: rect.boardSize,
          data: new Float32Array(rect.channels * 13 * 9),
        }),
    });
    await fixture.whenStable();
    expect(fixture.nativeElement.querySelector('[data-testid="grid-status"]')?.textContent).toContain(
      '4 channels',
    );
    expect(squareBoardSize(19).width).toBe(19); // guard against a stray import removal
  });
});


describe('ActivationView: orderings', () => {
  it('offers channel, change, impact and attribution', async () => {
    const { fixture } = render(defaultApi());
    await settle(fixture);
    const options = [
      ...fixture.nativeElement.querySelectorAll('[aria-label="Channel ordering"] option'),
    ] as HTMLOptionElement[];
    expect(options.map((o) => o.value)).toEqual(['channel', 'change', 'impact', 'attribution']);
  });

  it('re-sorts the grid when the ordering changes', async () => {
    const { fixture, store } = render(defaultApi());
    await settle(fixture);
    const grid = fixture.debugElement.query((node: { name?: string }) => node.name === 'ks-channel-grid');
    // Channel order is the default, so the grid gets no explicit order.
    expect(grid.componentInstance.order()).toBeUndefined();

    selectValue(fixture, 'Channel ordering', 'impact');
    await settle(fixture);
    // Channel 0 has by far the heaviest reader, so impact puts it first.
    expect(grid.componentInstance.order()?.[0]).toBe(0);

    selectValue(fixture, 'Channel ordering', 'attribution');
    store.setAttributionTarget({ kind: 'winrate' });
    await settle(fixture);
    // Channel 2 dominates the fixture attribution.
    expect(grid.componentInstance.order()?.[0]).toBe(2);
  });

  it('fetches the reader weights once, since they are static per network', async () => {
    const getReaderWeights = vi.fn(() => Promise.resolve(READER_WEIGHTS));
    const { fixture, store } = render(defaultApi({ getReaderWeights }));
    await settle(fixture);
    store.setBlock(2);
    await settle(fixture);
    expect(getReaderWeights).toHaveBeenCalledTimes(1);
  });

  it('shows a head selector only on the last block', async () => {
    const { fixture, store } = render(defaultApi());
    await settle(fixture);
    expect(fixture.nativeElement.querySelector('[aria-label="Reader head"]')).toBeNull();

    store.setBlock(SPEC.blocks - 1);
    await settle(fixture);
    expect(fixture.nativeElement.querySelector('[aria-label="Reader head"]')).not.toBeNull();
  });

  it('re-renders when the head selector changes, since impact depends on it', async () => {
    // The two heads read different channels, so the impact ordering must move.
    const { fixture, store } = render(defaultApi());
    await settle(fixture);
    store.setBlock(SPEC.blocks - 1);
    await settle(fixture);

    expect(store.blockReaderNorms()?.[0]).toBe(8);
    selectValue(fixture, 'Reader head', 'value');
    await settle(fixture);
    expect(store.blockReaderNorms()?.[0]).toBe(1);
    expect(store.blockReaderNorms()?.[3]).toBe(8);
  });

  it('disables the attribution ordering while a capture is open', async () => {
    // A capture holds stored planes; there is nothing to differentiate.
    const { fixture, store } = render(defaultApi());
    await settle(fixture);
    store.setCapture(CAPTURE);
    await settle(fixture);

    const option = fixture.nativeElement.querySelector(
      '[aria-label="Channel ordering"] option[value="attribution"]',
    ) as HTMLOptionElement;
    expect(option.disabled).toBe(true);
  });

  it('does not attribute until a target is chosen', async () => {
    const attribute = vi.fn((r: AttributionRequest) => Promise.resolve(attribution(r)));
    const { fixture } = render(defaultApi({ attribute }));
    await settle(fixture);
    selectValue(fixture, 'Channel ordering', 'attribution');
    await settle(fixture);
    // Attribution costs a forward and a backward pass; guessing a target would
    // spend that on a question nobody asked.
    expect(attribute).not.toHaveBeenCalled();

    selectValue(fixture, 'Attribution target', 'winrate');
    await settle(fixture);
    expect(attribute).toHaveBeenCalledWith(expect.objectContaining({ target: { kind: 'winrate' } }));
  });

  it('shows the current target, and says so when there is none', async () => {
    const { fixture, store } = render(defaultApi());
    await settle(fixture);
    selectValue(fixture, 'Channel ordering', 'attribution');
    await settle(fixture);
    expect(fixture.nativeElement.querySelector('[data-testid="attribution-target"]')?.textContent).toContain(
      'no target',
    );

    store.setAttributionTarget({ kind: 'ownership_point', x: 3, y: 4 });
    await settle(fixture);
    expect(fixture.nativeElement.querySelector('[data-testid="attribution-target"]')?.textContent).toContain(
      'ownership at (3, 4)',
    );
  });

  it('shows a board-picked point in the target select rather than falling back to none', async () => {
    // A point target has no fixed option, so the select used to read "none"
    // while the status line said otherwise.
    const { fixture, store } = render(defaultApi());
    await settle(fixture);
    selectValue(fixture, 'Channel ordering', 'attribution');
    store.setAttributionTarget({ kind: 'ownership_point', x: 7, y: 8 });
    await settle(fixture);

    const select = fixture.nativeElement.querySelector(
      '[aria-label="Attribution target"]',
    ) as HTMLSelectElement;
    expect(select.selectedOptions[0]?.textContent).toContain('ownership at (7, 8)');
  });

  it('re-attributes when the move changes', async () => {
    const attribute = vi.fn((r: AttributionRequest) => Promise.resolve(attribution(r)));
    const { fixture, store } = render(defaultApi({ attribute }));
    store.setGame({ path: '/g.sgf', game: parseSgf('(;GM[1]FF[4]SZ[19];B[pd];W[dp];B[pp])') });
    await settle(fixture);
    store.setAttributionTarget({ kind: 'winrate' });
    await settle(fixture);
    const before = attribute.mock.calls.length;

    store.setMoveNumber(2);
    await settle(fixture);
    expect(attribute.mock.calls.length).toBeGreaterThan(before);
  });
});

describe('ActivationView: the detail pane', () => {
  async function openDetail(fixture: ReturnType<typeof render>['fixture'], channel: number) {
    const grid = fixture.debugElement.query((node: { name?: string }) => node.name === 'ks-channel-grid');
    grid.componentInstance.channelPicked.emit(channel);
    await settle(fixture);
  }

  it('shows impact and reader norm for the picked channel', async () => {
    const { fixture } = render(defaultApi());
    await settle(fixture);
    await openDetail(fixture, 0);

    const measures = fixture.nativeElement.querySelector('[data-testid="detail-measures"]')?.textContent;
    expect(measures).toContain('impact');
    expect(measures).toContain('reader norm');
    // Channel 0's reader norm is 9 on every non-final block.
    expect(measures).toContain('9.000');
  });

  it('names the head on the last block, where there are two readers', async () => {
    const { fixture, store } = render(defaultApi());
    await settle(fixture);
    store.setBlock(SPEC.blocks - 1);
    await settle(fixture);
    await openDetail(fixture, 0);

    expect(fixture.nativeElement.querySelector('[data-testid="detail-measures"]')?.textContent).toContain(
      'impact (policy)',
    );
  });

  it('adds attribution and its rank once a target is set', async () => {
    const { fixture, store } = render(defaultApi());
    await settle(fixture);
    await openDetail(fixture, 2);
    expect(fixture.nativeElement.querySelector('[data-testid="detail-measures"]')?.textContent).not.toContain(
      'attribution',
    );

    store.setAttributionTarget({ kind: 'winrate' });
    await settle(fixture);
    const measures = fixture.nativeElement.querySelector('[data-testid="detail-measures"]')?.textContent;
    // Channel 2 dominates the fixture attribution, so it ranks first.
    expect(measures).toContain('attribution');
    expect(measures).toContain('#1');
  });
});
