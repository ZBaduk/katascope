/**
 * The shared store.
 *
 * Replaces the placeholder `activation-view-store.spec.ts`; the store grew to
 * own the app-wide move selection as well as the activation view, and the name
 * followed. Every `it.todo` from that file is implemented here.
 */

import { TestBed } from '@angular/core/testing';
import {
  parseSgf,
  type ActivationFrame,
  type GameRecord,
  type KatascopeApi,
  type PositionAnalysis,
} from '@katascope/core';
import { describe, expect, it, vi } from 'vitest';
import { KATASCOPE_API } from '../platform/katascope-api';
import { FRAME_CACHE_LIMIT, SessionStore } from './session-store';

const GAME: GameRecord = parseSgf('(;GM[1]FF[4]SZ[19]KM[7.5];B[pd];W[dp];B[pp];W[dd])');
const HANDICAP: GameRecord = parseSgf('(;GM[1]FF[4]SZ[19]HA[2]KM[0.5]AB[pd][dp];W[dd])');

function analysis(moveNumber: number): PositionAnalysis {
  return { moveNumber, winrate: 0.5, scoreLead: 0, visits: 1 };
}

function frame(moveNumber: number, block: number, channels = 8): ActivationFrame {
  return {
    moveNumber,
    block,
    networkName: 'test',
    boardSize: { width: 2, height: 2 },
    channels,
    dtype: 'float32',
    data: new Float32Array(channels * 4),
    range: { min: 0, max: 1 },
  };
}

/** A deferred, so a test can control exactly when a request resolves. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function make(api: Partial<KatascopeApi> | null = {}): SessionStore {
  TestBed.configureTestingModule({
    providers: [{ provide: KATASCOPE_API, useValue: api as KatascopeApi | null }],
  });
  return TestBed.inject(SessionStore);
}

describe('SessionStore: game and move selection', () => {
  it('starts with no game loaded and every selection at its default', () => {
    const store = make();
    expect(store.hasGame()).toBe(false);
    expect(store.game()).toBeUndefined();
    expect(store.moveNumber()).toBe(0);
    expect(store.lastMoveNumber()).toBe(0);
    expect(store.board()).toBeUndefined();
    expect(store.block()).toBe(0);
    expect(store.channel()).toBe(0);
    expect(store.analysisState()).toBe('idle');
  });

  it('loads a GameRecord and exposes its move count', () => {
    const store = make();
    store.setGame({ path: '/g.sgf', game: GAME });
    expect(store.hasGame()).toBe(true);
    expect(store.lastMoveNumber()).toBe(4);
    expect(store.game()?.path).toBe('/g.sgf');
  });

  it('clamps the move number to the loaded game, refusing to go past either end', () => {
    const store = make();
    store.setGame({ path: '/g.sgf', game: GAME });

    store.setMoveNumber(99);
    expect(store.moveNumber()).toBe(4);
    store.setMoveNumber(-5);
    expect(store.moveNumber()).toBe(0);

    store.stepMove(-1);
    expect(store.moveNumber()).toBe(0);
    store.lastMove();
    store.stepMove(1);
    expect(store.moveNumber()).toBe(4);
  });

  it('exposes the board at the selected move', () => {
    const store = make();
    store.setGame({ path: '/g.sgf', game: GAME });
    expect(store.board()?.get({ x: 15, y: 3 })).toBe('empty');
    store.setMoveNumber(1);
    expect(store.board()?.get({ x: 15, y: 3 })).toBe('black');
  });

  it('places handicap setup stones at move 0', () => {
    const store = make();
    store.setGame({ path: '/h.sgf', game: HANDICAP });
    expect(store.board()?.get({ x: 15, y: 3 })).toBe('black');
    expect(store.board()?.get({ x: 3, y: 15 })).toBe('black');
  });

  it('reports the move that produced the current position', () => {
    const store = make();
    store.setGame({ path: '/g.sgf', game: GAME });
    expect(store.lastPlayedMove()).toBeUndefined();
    store.setMoveNumber(2);
    expect(store.lastPlayedMove()).toMatchObject({ player: 'white', vertex: { x: 3, y: 15 } });
  });

  it('resets the selection when a different game is loaded', () => {
    const store = make();
    store.setGame({ path: '/g.sgf', game: GAME });
    store.lastMove();
    store.setGame({ path: '/h.sgf', game: HANDICAP });
    expect(store.moveNumber()).toBe(0);
    expect(store.lastMoveNumber()).toBe(1);
  });

  it('ignores a non-finite move number rather than corrupting the selection', () => {
    const store = make();
    store.setGame({ path: '/g.sgf', game: GAME });
    store.setMoveNumber(Number.NaN);
    expect(store.moveNumber()).toBe(0);
  });
});

describe('SessionStore: clamping the activation selection', () => {
  it('clamps the block index to the network spec from describeActivations()', () => {
    const store = make();
    store.setBlock(7);
    expect(store.block()).toBe(7); // no spec yet, nothing to clamp against

    store.setNetworkSpec({ name: 'b6c96', blocks: 6, channels: 96, boardSize: { width: 19, height: 19 } });
    // Setting the spec re-clamps what was already selected.
    expect(store.block()).toBe(5);
    store.setBlock(99);
    expect(store.block()).toBe(5);
    store.setBlock(-1);
    expect(store.block()).toBe(0);
  });

  it('clamps the channel index to the frame it actually received', async () => {
    const store = make({ getActivationFrame: () => Promise.resolve(frame(0, 0, 8)) });
    store.setChannel(500);
    expect(store.channel()).toBe(500); // no frame yet

    await store.ensureFrame();
    // Arrival of a frame re-clamps the selection to the data that exists.
    expect(store.channel()).toBe(7);
    store.setChannel(99);
    expect(store.channel()).toBe(7);
  });
});

describe('SessionStore: lazy activation frames', () => {
  it('fetches a frame when the move changes', async () => {
    const getActivationFrame = vi.fn((key: { moveNumber: number; block: number }) =>
      Promise.resolve(frame(key.moveNumber, key.block)),
    );
    const store = make({ getActivationFrame });
    store.setGame({ path: '/g.sgf', game: GAME });

    await store.ensureFrame();
    store.setMoveNumber(2);
    await store.ensureFrame();

    expect(getActivationFrame).toHaveBeenCalledTimes(2);
    expect(store.frame()?.moveNumber).toBe(2);
  });

  it('fetches a frame when the block changes', async () => {
    const getActivationFrame = vi.fn((key: { moveNumber: number; block: number }) =>
      Promise.resolve(frame(key.moveNumber, key.block)),
    );
    const store = make({ getActivationFrame });
    store.setNetworkSpec({ name: 'n', blocks: 6, channels: 8, boardSize: { width: 2, height: 2 } });

    await store.ensureFrame();
    store.setBlock(3);
    await store.ensureFrame();

    expect(getActivationFrame).toHaveBeenCalledTimes(2);
    expect(store.frame()?.block).toBe(3);
  });

  it('does not refetch when only the channel changes, since one frame holds every channel', async () => {
    const getActivationFrame = vi.fn(() => Promise.resolve(frame(0, 0)));
    const store = make({ getActivationFrame });

    await store.ensureFrame();
    store.setChannel(3);
    store.setChannel(5);
    await store.ensureFrame();

    expect(getActivationFrame).toHaveBeenCalledTimes(1);
    expect(store.channel()).toBe(5);
  });

  it('serves a cached frame for a (move, block) pair it already fetched', async () => {
    const getActivationFrame = vi.fn((key: { moveNumber: number; block: number }) =>
      Promise.resolve(frame(key.moveNumber, key.block)),
    );
    const store = make({ getActivationFrame });
    store.setGame({ path: '/g.sgf', game: GAME });

    await store.ensureFrame();
    store.setMoveNumber(3);
    await store.ensureFrame();
    store.setMoveNumber(0);
    await store.ensureFrame();

    expect(getActivationFrame).toHaveBeenCalledTimes(2);
    expect(store.frame()?.moveNumber).toBe(0);
  });

  it('evicts from the cache rather than growing without bound', async () => {
    const store = make({
      getActivationFrame: (key: { moveNumber: number; block: number }) =>
        Promise.resolve(frame(key.moveNumber, key.block)),
    });
    const long = parseSgf(`(;GM[1]FF[4]SZ[19]${';B[aa];W[bb]'.repeat(40)})`);
    store.setGame({ path: '/long.sgf', game: long });

    for (let move = 0; move <= FRAME_CACHE_LIMIT + 5; move++) {
      store.setMoveNumber(move);
      await store.ensureFrame();
    }
    expect(store.cacheSizes().frames).toBe(FRAME_CACHE_LIMIT);
  });

  it('ignores a response that arrives after a newer request, so stepping fast cannot show a stale frame', async () => {
    const slow = deferred<ActivationFrame>();
    const fast = deferred<ActivationFrame>();
    const calls = [slow, fast];
    let index = 0;
    const store = make({ getActivationFrame: () => calls[index++]!.promise });
    store.setGame({ path: '/g.sgf', game: GAME });

    const first = store.ensureFrame(); // move 0
    store.setMoveNumber(2);
    const second = store.ensureFrame(); // move 2

    // Move 2 answers first, then the abandoned move-0 request finally lands.
    fast.resolve(frame(2, 0));
    await second;
    slow.resolve(frame(0, 0));
    await first;

    expect(store.frame()?.moveNumber).toBe(2);
  });

  it('surfaces a rejected frame request as an error state without discarding the last good frame', async () => {
    let shouldFail = false;
    const store = make({
      getActivationFrame: (key: { moveNumber: number; block: number }) =>
        shouldFail ? Promise.reject(new Error('sidecar died')) : Promise.resolve(frame(key.moveNumber, key.block)),
    });
    store.setGame({ path: '/g.sgf', game: GAME });

    await store.ensureFrame();
    expect(store.frameState()).toBe('ready');

    shouldFail = true;
    store.setMoveNumber(1);
    await store.ensureFrame();

    expect(store.frameState()).toBe('error');
    expect(store.frameError()).toContain('sidecar died');
    // The last good frame is still there: a stale heatmap plus a visible error
    // beats a blank panel.
    expect(store.frame()?.moveNumber).toBe(0);
  });

  it('reports a not-loaded state rather than throwing when the bridge is absent', async () => {
    const store = make(null);
    store.setGame({ path: '/g.sgf', game: GAME });
    await expect(store.ensureFrame()).resolves.toBeUndefined();
    await expect(store.ensureAnalysis()).resolves.toBeUndefined();
    expect(store.frameState()).toBe('idle');
    expect(store.analysisState()).toBe('idle');
    expect(store.frame()).toBeUndefined();
  });
});

describe('SessionStore: lazy analysis for the board overlays', () => {
  it('does not fetch until asked', async () => {
    const analyzePosition = vi.fn(() => Promise.resolve(analysis(0)));
    const store = make({ analyzePosition });
    store.setGame({ path: '/g.sgf', game: GAME });
    store.setMoveNumber(1);
    store.setMoveNumber(2);
    expect(analyzePosition).not.toHaveBeenCalled();

    await store.ensureAnalysis();
    expect(analyzePosition).toHaveBeenCalledTimes(1);
    expect(analyzePosition).toHaveBeenCalledWith({ moveNumber: 2, maxVisits: 1 });
  });

  it('caches per move index', async () => {
    const analyzePosition = vi.fn((r: { moveNumber: number }) => Promise.resolve(analysis(r.moveNumber)));
    const store = make({ analyzePosition });
    store.setGame({ path: '/g.sgf', game: GAME });

    await store.ensureAnalysis();
    store.setMoveNumber(1);
    await store.ensureAnalysis();
    store.setMoveNumber(0);
    await store.ensureAnalysis();

    expect(analyzePosition).toHaveBeenCalledTimes(2);
    expect(store.analysis()?.moveNumber).toBe(0);
  });

  it('discards an analysis for a move the user has already left', async () => {
    const slow = deferred<PositionAnalysis>();
    const fast = deferred<PositionAnalysis>();
    const calls = [slow, fast];
    let index = 0;
    const store = make({ analyzePosition: () => calls[index++]!.promise });
    store.setGame({ path: '/g.sgf', game: GAME });

    const first = store.ensureAnalysis();
    store.setMoveNumber(3);
    const second = store.ensureAnalysis();

    fast.resolve(analysis(3));
    await second;
    slow.resolve(analysis(0));
    await first;

    expect(store.analysis()?.moveNumber).toBe(3);
    // The abandoned reply must not have been cached either.
    expect(store.cacheSizes().analysis).toBe(1);
  });

  it('cancels an in-flight analysis when asked', async () => {
    const pending = deferred<PositionAnalysis>();
    const store = make({ analyzePosition: () => pending.promise });
    store.setGame({ path: '/g.sgf', game: GAME });

    const inFlight = store.ensureAnalysis();
    expect(store.analysisState()).toBe('loading');
    store.cancelAnalysis();
    expect(store.analysisState()).toBe('idle');

    pending.resolve(analysis(0));
    await inFlight;
    expect(store.analysis()).toBeUndefined();
  });

  it('does nothing without a game, since there is no position to analyse', async () => {
    const analyzePosition = vi.fn(() => Promise.resolve(analysis(0)));
    const store = make({ analyzePosition });
    await store.ensureAnalysis();
    expect(analyzePosition).not.toHaveBeenCalled();
  });

  it('passes the requested visit budget through', async () => {
    const analyzePosition = vi.fn(() => Promise.resolve(analysis(0)));
    const store = make({ analyzePosition });
    store.setGame({ path: '/g.sgf', game: GAME });
    await store.ensureAnalysis(64);
    expect(analyzePosition).toHaveBeenCalledWith({ moveNumber: 0, maxVisits: 64 });
  });
});


describe('SessionStore: which frame the change overlay compares against', () => {
  it('picks the last position with the same player to move, not the previous one', async () => {
    // KataGo's planes are relative to whoever is on move, so consecutive
    // positions have every stone swapped between the "mine" and "theirs"
    // planes. Measured on kata1-b18c384nbt, that flip made the delta against
    // the previous position 4.5x the delta against two back at block 0, with
    // 376 of 384 channels moving more -- almost all of it the flip rather than
    // the move.
    const store = make();
    store.setGame({ path: '/g.sgf', game: GAME });
    store.setMoveNumber(4);
    expect(store.comparisonMove()).toBe(2);
    store.setMoveNumber(3);
    expect(store.comparisonMove()).toBe(1);
  });

  it('has nothing to compare against in the opening positions', async () => {
    const store = make();
    store.setGame({ path: '/g.sgf', game: GAME });
    store.setMoveNumber(0);
    expect(store.comparisonMove()).toBeUndefined();
    store.setMoveNumber(1);
    expect(store.comparisonMove()).toBeUndefined();
  });

  it('follows the player rather than parity, so handicap games work', () => {
    // HANDICAP places two black setup stones, so White moves first: the side
    // to move at move 0 is White, at move 1 Black. Parity would agree here,
    // but only by luck -- the rule is keyed on the actual player.
    const store = make();
    store.setGame({ path: '/h.sgf', game: HANDICAP });
    store.setMoveNumber(1);
    expect(store.comparisonMove()).toBeUndefined();
  });

  it('fetches the comparison frame and caches it', async () => {
    const getActivationFrame = vi.fn((key: { moveNumber: number; block: number }) =>
      Promise.resolve(frame(key.moveNumber, key.block)),
    );
    const store = make({ getActivationFrame });
    store.setGame({ path: '/g.sgf', game: GAME });
    store.setMoveNumber(4);

    const first = await store.comparisonFrame();
    expect(first?.moveNumber).toBe(2);
    await store.comparisonFrame();
    // Second call is served from the cache.
    expect(getActivationFrame).toHaveBeenCalledTimes(1);
  });

  it('returns nothing rather than failing the repaint when the fetch rejects', async () => {
    const store = make({ getActivationFrame: () => Promise.reject(new Error('gone')) });
    store.setGame({ path: '/g.sgf', game: GAME });
    store.setMoveNumber(4);
    await expect(store.comparisonFrame()).resolves.toBeUndefined();
  });

  it('skips frames a sparse capture does not hold', async () => {
    // A capture written with --blocks or --max-moves may hold gaps; stepping
    // back a fixed two would land on a frame that is not there.
    const store = make({ getActivationFrame: (k) => Promise.resolve(frame(k.moveNumber, k.block)) });
    store.setGame({ path: '/g.sgf', game: GAME });
    store.setCapture({
      path: '/c.kact',
      networkName: 'n',
      spec: { name: 'n', blocks: 2, channels: 8, boardSize: { width: 2, height: 2 } },
      moveNumbers: [0, 2, 4],
      blockNumbers: [0, 1],
    });
    store.setMoveNumber(4);
    // Move 3 is absent, so the same-side predecessor it holds is 2.
    expect(store.comparisonMove()).toBe(2);

    store.setMoveNumber(2);
    expect(store.comparisonMove()).toBe(0);
  });

  it('falls back to parity when no game is loaded', () => {
    const store = make();
    store.setCapture({
      path: '/c.kact',
      networkName: 'n',
      spec: { name: 'n', blocks: 2, channels: 8, boardSize: { width: 2, height: 2 } },
      moveNumbers: [0, 1, 2, 3, 4],
      blockNumbers: [0],
    });
    store.setMoveNumber(4);
    expect(store.comparisonMove()).toBe(2);
  });
});


describe('SessionStore: attribution', () => {
  const TARGET = { kind: 'winrate' } as const;

  function attribution(moveNumber: number): import('@katascope/core').Attribution {
    return {
      moveNumber,
      target: TARGET,
      blocks: 2,
      channels: 3,
      byBlock: new Float32Array([1, 2, 3, 4, 5, 6]),
    };
  }

  it('does nothing until a target is set', async () => {
    const attribute = vi.fn(() => Promise.resolve(attribution(0)));
    const store = make({ attribute });
    await store.ensureAttribution();
    expect(attribute).not.toHaveBeenCalled();
    expect(store.attributionState()).toBe('idle');
  });

  it('caches per move and target', async () => {
    const attribute = vi.fn((r: { moveNumber: number }) => Promise.resolve(attribution(r.moveNumber)));
    const store = make({ attribute });
    store.setGame({ path: '/g.sgf', game: GAME });
    store.setAttributionTarget(TARGET);

    await store.ensureAttribution();
    store.setMoveNumber(2);
    await store.ensureAttribution();
    store.setMoveNumber(0);
    await store.ensureAttribution();
    expect(attribute).toHaveBeenCalledTimes(2);

    // A different target is a different question, so it is not a cache hit.
    store.setAttributionTarget({ kind: 'ownership_total' });
    await store.ensureAttribution();
    expect(attribute).toHaveBeenCalledTimes(3);
  });

  it('treats a request with planes as distinct from one without', async () => {
    // A plane request returns strictly more, so serving the cheaper cached
    // answer would silently drop the planes the caller asked for.
    const attribute = vi.fn((r: { moveNumber: number }) => Promise.resolve(attribution(r.moveNumber)));
    const store = make({ attribute });
    store.setGame({ path: '/g.sgf', game: GAME });
    store.setAttributionTarget(TARGET);

    await store.ensureAttribution();
    await store.ensureAttribution(1);
    expect(attribute).toHaveBeenCalledTimes(2);
  });

  it('discards a reply for a target the user has left', async () => {
    const slow = deferred<import('@katascope/core').Attribution>();
    const store = make({ attribute: () => slow.promise });
    store.setGame({ path: '/g.sgf', game: GAME });
    store.setAttributionTarget(TARGET);

    const inFlight = store.ensureAttribution();
    store.setAttributionTarget({ kind: 'ownership_total' });
    slow.resolve(attribution(0));
    await inFlight;

    expect(store.attribution()).toBeUndefined();
  });

  it('surfaces a rejection without claiming a result', async () => {
    const store = make({ attribute: () => Promise.reject(new Error('no gradients here')) });
    store.setGame({ path: '/g.sgf', game: GAME });
    store.setAttributionTarget(TARGET);
    await store.ensureAttribution();
    expect(store.attributionState()).toBe('error');
    expect(store.attributionError()).toContain('no gradients here');
  });

  it('leaves reader weights undefined when the source has none', async () => {
    // A capture has no weights to measure; impact falls back to raw loudness.
    const store = make({ getReaderWeights: () => Promise.reject(new Error('capture')) });
    await store.ensureReaderWeights();
    expect(store.readerWeights()).toBeUndefined();
    expect(store.blockReaderNorms()).toBeUndefined();
  });

  it('resolves reader norms per block, and per head on the last one', async () => {
    const weights = {
      networkName: 'n',
      channels: 2,
      byBlock: [new Float32Array([1, 2]), new Float32Array([3, 4])],
      heads: { policy: new Float32Array([5, 6]), value: new Float32Array([7, 8]) },
    };
    const store = make({ getReaderWeights: () => Promise.resolve(weights) });
    store.setNetworkSpec({ name: 'n', blocks: 3, channels: 2, boardSize: { width: 2, height: 2 } });
    await store.ensureReaderWeights();

    store.setBlock(0);
    expect([...(store.blockReaderNorms() ?? [])]).toEqual([1, 2]);
    store.setBlock(2);
    expect(store.isLastBlock()).toBe(true);
    expect([...(store.blockReaderNorms() ?? [])]).toEqual([5, 6]);
    store.setReaderHead('value');
    expect([...(store.blockReaderNorms() ?? [])]).toEqual([7, 8]);
  });
});

describe('SessionStore: the channel-search region', () => {
  it('starts empty', () => {
    const store = make();
    expect(store.searchRegion()).toEqual([]);
    expect(store.hasSearchRegion()).toBe(false);
  });

  it('adds points in click order', () => {
    const store = make();
    store.toggleRegionPoint({ x: 3, y: 3 });
    store.toggleRegionPoint({ x: 1, y: 0 });
    expect(store.searchRegion()).toEqual([
      { x: 3, y: 3 },
      { x: 1, y: 0 },
    ]);
    expect(store.hasSearchRegion()).toBe(true);
  });

  it('removes a point that is clicked again, rather than adding it twice', () => {
    const store = make();
    store.toggleRegionPoint({ x: 3, y: 3 });
    store.toggleRegionPoint({ x: 4, y: 4 });
    store.toggleRegionPoint({ x: 3, y: 3 });
    expect(store.searchRegion()).toEqual([{ x: 4, y: 4 }]);
  });

  it('compares points by coordinate, not by identity', () => {
    const store = make();
    store.toggleRegionPoint({ x: 2, y: 2 });
    // A different object with the same coordinates is the same intersection.
    store.toggleRegionPoint({ x: 2, y: 2 });
    expect(store.searchRegion()).toEqual([]);
  });

  it('clears the whole region', () => {
    const store = make();
    store.toggleRegionPoint({ x: 0, y: 0 });
    store.toggleRegionPoint({ x: 1, y: 1 });
    store.clearSearchRegion();
    expect(store.searchRegion()).toEqual([]);
  });

  it('keeps the region when a game is loaded', () => {
    // Unlike a move number, an intersection means the same thing in every
    // game, so loading one must not silently discard the selection.
    const store = make();
    store.toggleRegionPoint({ x: 3, y: 3 });
    store.setGame({ path: '/tmp/game.sgf', game: GAME });
    expect(store.searchRegion()).toEqual([{ x: 3, y: 3 }]);
  });

  it('replaces the array rather than mutating it, so signals notify', () => {
    const store = make();
    const before = store.searchRegion();
    store.toggleRegionPoint({ x: 5, y: 5 });
    expect(store.searchRegion()).not.toBe(before);
    expect(before).toEqual([]);
  });
});
