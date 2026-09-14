/**
 * The search driver.
 *
 * The scoring it calls is tested in `@katascope/core`; what is tested here is
 * everything around it -- which frames get read, what happens when the user
 * cancels halfway, and whether a late reply from an abandoned search can still
 * land in the results. Those are the failures that produce a table full of
 * plausible rows describing the wrong search.
 */

import { TestBed } from '@angular/core/testing';
import {
  FakeActivationStore,
  plantedRegion,
  squareBoardSize,
  type ActivationFrame,
  type KatascopeApi,
  type LoadedCapture,
  type NetworkSpec,
} from '@katascope/core';
import { beforeEach, describe, expect, it } from 'vitest';
import { KATASCOPE_API } from '../platform/katascope-api';
import { SessionStore } from '../state/session-store';
import { ChannelSearch, MAX_SEARCH_FRAMES, type SearchPlan } from './channel-search';

const SPEC: NetworkSpec = {
  name: 'b6c96',
  blocks: 6,
  channels: 96,
  boardSize: squareBoardSize(19),
};

const REGION = plantedRegion(SPEC.boardSize);

function capture(moveNumbers: readonly number[]): LoadedCapture {
  return {
    path: '/tmp/game.kact',
    networkName: SPEC.name,
    spec: SPEC,
    moveNumbers,
    blockNumbers: [0, 1, 2, 3, 4, 5],
  };
}

function plan(overrides: Partial<SearchPlan> = {}): SearchPlan {
  return {
    region: REGION,
    direction: 'either',
    threshold: 3,
    specific: false,
    specificThreshold: 0.5,
    scope: 'move',
    blocks: [0],
    ...overrides,
  };
}

/** A deferred, so a test can hold a frame request open. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

let store: FakeActivationStore;

/** Frames come from the real fake store, so the planted channels are present. */
function makeApi(overrides: Partial<KatascopeApi> = {}): Partial<KatascopeApi> {
  return {
    getActivationFrame: (key) => store.frame(key),
    ...overrides,
  };
}

function make(api: Partial<KatascopeApi> | null): {
  search: ChannelSearch;
  session: SessionStore;
} {
  TestBed.configureTestingModule({
    providers: [{ provide: KATASCOPE_API, useValue: api as KatascopeApi | null }],
  });
  const session = TestBed.inject(SessionStore);
  session.setNetworkSpec(SPEC);
  return { search: TestBed.inject(ChannelSearch), session };
}

beforeEach(() => {
  store = new FakeActivationStore({ spec: SPEC });
});

describe('ChannelSearch: running a search', () => {
  it('finds the planted channels on the current move', async () => {
    const { search } = make(makeApi());
    await search.run(plan());

    expect(search.state()).toBe('done');
    const channels = new Set(search.hits().map((hit) => hit.channel));
    for (const planted of [7, 11, 23, 42]) expect(channels.has(planted)).toBe(true);
  });

  it('reports the direction each planted channel responds in', async () => {
    const { search } = make(makeApi());
    await search.run(plan());

    const byChannel = new Map(search.hits().map((hit) => [hit.channel, hit.direction]));
    expect(byChannel.get(7)).toBe('high');
    expect(byChannel.get(11)).toBe('low');
  });

  it('respects the direction filter', async () => {
    const { search } = make(makeApi());
    await search.run(plan({ direction: 'high' }));

    const channels = new Set(search.hits().map((hit) => hit.channel));
    expect(channels.has(7)).toBe(true);
    // The low-planted channel must not appear in a high-only search.
    expect(channels.has(11)).toBe(false);
  });

  it('ranks results best first', async () => {
    const { search } = make(makeApi());
    await search.run(plan());

    const scores = search.hits().map((hit) => hit.score);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
  });

  it('searches only the blocks asked for', async () => {
    const { search } = make(makeApi());
    await search.run(plan({ blocks: [2, 4] }));

    const blocks = new Set(search.hits().map((hit) => hit.block));
    expect([...blocks].sort()).toEqual([2, 4]);
    expect(search.total()).toBe(2);
  });

  it('refuses an empty region rather than matching everything', async () => {
    const { search } = make(makeApi());
    await search.run(plan({ region: [] }));

    expect(search.state()).toBe('error');
    expect(search.error()).toContain('at least one intersection');
    expect(search.hits()).toEqual([]);
  });

  it('does nothing without a bridge', async () => {
    const { search } = make(null);
    await search.run(plan());
    expect(search.state()).toBe('idle');
    expect(search.hits()).toEqual([]);
  });

  it('summarises how many moves each channel qualified on', async () => {
    const { search, session } = make(makeApi());
    session.setCapture(capture([0, 1, 2, 3]));
    session.setNetworkSpec(SPEC);

    await search.run(plan({ scope: 'all', blocks: [0] }));

    const planted = search.summaries().find((s) => s.channel === 7);
    // Planted at every move, so it qualifies on all four.
    expect(planted?.moves).toBe(4);
  });

  it('counts every hit in the summary, not just the ranked table', async () => {
    const { search, session } = make(makeApi());
    session.setCapture(capture([0, 1, 2]));
    session.setNetworkSpec(SPEC);
    await search.run(plan({ scope: 'all', blocks: [0, 1] }));

    const total = search.summaries().reduce((sum, entry) => sum + entry.moves, 0);
    expect(total).toBe(search.hits().length);
  });
});

describe('ChannelSearch: scope', () => {
  it('covers only the current move without a capture', () => {
    const { search, session } = make(makeApi());
    session.setGame({
      path: '/tmp/g.sgf',
      game: {
        size: squareBoardSize(19),
        info: { komi: 7.5, handicap: 0 },
        setup: [],
        moves: [],
      },
    });
    expect(search.canSearchAllMoves()).toBe(false);
    // Even asked for "all", a live model has only the move on screen.
    expect(search.movesFor('all')).toEqual([0]);
  });

  it("covers the capture's move numbers when one is open", () => {
    const { search, session } = make(makeApi());
    session.setCapture(capture([0, 4, 9]));
    expect(search.canSearchAllMoves()).toBe(true);
    expect(search.movesFor('all')).toEqual([0, 4, 9]);
    expect(search.movesFor('move')).toEqual([0]);
  });

  it('forces the scope back to the current move without a capture', async () => {
    const seen: number[] = [];
    const { search } = make(
      makeApi({
        getActivationFrame: (key) => {
          seen.push(key.moveNumber);
          return store.frame(key);
        },
      }),
    );
    await search.run(plan({ scope: 'all' }));
    expect(seen).toEqual([0]);
  });
});

describe('ChannelSearch: cancellation', () => {
  it('stops reading frames once cancelled', async () => {
    const gate = deferred<ActivationFrame>();
    let requests = 0;
    const { search, session } = make(
      makeApi({
        getActivationFrame: (key) => {
          requests++;
          return requests === 1 ? gate.promise : store.frame(key);
        },
      }),
    );
    session.setCapture(capture([0, 1, 2, 3, 4]));
    session.setNetworkSpec(SPEC);

    const running = search.run(plan({ scope: 'all', blocks: [0] }));
    expect(search.state()).toBe('running');

    search.cancel();
    gate.resolve(await store.frame({ moveNumber: 0, block: 0 }));
    await running;

    // The first frame was already in flight; nothing after it was requested.
    expect(requests).toBe(1);
    expect(search.state()).toBe('done');
  });

  it('discards a frame that arrives after cancellation', async () => {
    const gate = deferred<ActivationFrame>();
    const { search } = make(makeApi({ getActivationFrame: () => gate.promise }));

    const running = search.run(plan());
    search.cancel();
    gate.resolve(await store.frame({ moveNumber: 0, block: 0 }));
    await running;

    // A late reply from an abandoned search must not populate the table.
    expect(search.hits()).toEqual([]);
  });

  it('lets a newer search supersede an older one', async () => {
    const first = deferred<ActivationFrame>();
    let call = 0;
    const { search } = make(
      makeApi({
        getActivationFrame: (key) => {
          call++;
          return call === 1 ? first.promise : store.frame(key);
        },
      }),
    );

    const stale = search.run(plan({ blocks: [0] }));
    const fresh = search.run(plan({ blocks: [3] }));
    first.resolve(await store.frame({ moveNumber: 0, block: 0 }));
    await Promise.all([stale, fresh]);

    // Only the newer search's block may appear.
    const blocks = new Set(search.hits().map((hit) => hit.block));
    expect([...blocks]).toEqual([3]);
  });

  it('keeps results found so far when cancelled', async () => {
    const { search, session } = make(makeApi());
    session.setCapture(capture([0, 1]));
    session.setNetworkSpec(SPEC);
    await search.run(plan({ scope: 'all', blocks: [0] }));
    const found = search.hits().length;
    expect(found).toBeGreaterThan(0);

    search.cancel();
    expect(search.hits()).toHaveLength(found);
  });

  it('clears everything on reset', async () => {
    const { search } = make(makeApi());
    await search.run(plan());
    expect(search.hits().length).toBeGreaterThan(0);

    search.reset();
    expect(search.hits()).toEqual([]);
    expect(search.summaries()).toEqual([]);
    expect(search.state()).toBe('idle');
    expect(search.scanned()).toBe(0);
  });
});

describe('ChannelSearch: failure and limits', () => {
  it('reports a failed frame read but keeps what it found', async () => {
    let call = 0;
    const { search, session } = make(
      makeApi({
        getActivationFrame: (key) => {
          call++;
          if (call > 2) return Promise.reject(new Error('sidecar died'));
          return store.frame(key);
        },
      }),
    );
    session.setCapture(capture([0, 1, 2, 3]));
    session.setNetworkSpec(SPEC);

    await search.run(plan({ scope: 'all', blocks: [0] }));

    expect(search.state()).toBe('error');
    expect(search.error()).toContain('sidecar died');
    // Two frames were scored before the failure; their hits are still useful.
    expect(search.hits().length).toBeGreaterThan(0);
  });

  it('stops at the frame budget and says so', async () => {
    // 400 moves x 6 blocks = 2,400 targets, over the 2,000 budget. Moves
    // rather than more blocks would not do it: the fake store serves only
    // 0..400, so the search would fail before it reached the cap.
    const moves = Array.from({ length: 400 }, (_, i) => i);
    const requested = new Set<string>();
    const { search, session } = make(
      makeApi({
        getActivationFrame: (key) => {
          requested.add(`${key.moveNumber}:${key.block}`);
          return store.frame(key);
        },
      }),
    );
    session.setCapture(capture(moves));
    session.setNetworkSpec(SPEC);

    await search.run(plan({ scope: 'all', blocks: [0, 1, 2, 3, 4, 5], threshold: 99 }));

    expect(search.truncated()).toBe(true);
    expect(search.total()).toBe(MAX_SEARCH_FRAMES);
    expect(requested.size).toBe(MAX_SEARCH_FRAMES);
  });

  it('does not flag truncation for a search that fits', async () => {
    const { search, session } = make(makeApi());
    session.setCapture(capture([0, 1]));
    session.setNetworkSpec(SPEC);
    await search.run(plan({ scope: 'all', blocks: [0] }));
    expect(search.truncated()).toBe(false);
  });

  it('reports progress as it goes', async () => {
    const seen: number[] = [];
    const { search, session } = make(
      makeApi({
        getActivationFrame: (key) => {
          seen.push(search.scanned());
          return store.frame(key);
        },
      }),
    );
    session.setCapture(capture([0, 1, 2]));
    session.setNetworkSpec(SPEC);

    await search.run(plan({ scope: 'all', blocks: [0] }));

    // Counted up as the frames were read, not set once at the end.
    expect(seen).toEqual([0, 1, 2]);
    expect(search.scanned()).toBe(3);
    expect(search.total()).toBe(3);
  });
});

describe('ChannelSearch: the specific flag', () => {
  it('keeps a planted channel, which is quiet outside its region', async () => {
    const { search } = make(makeApi());
    await search.run(plan({ specific: true, specificThreshold: 0.5 }));
    const channels = new Set(search.hits().map((hit) => hit.channel));
    expect(channels.has(7)).toBe(true);
  });

  it('can only ever narrow the result set, never widen it', async () => {
    const { search } = make(makeApi());
    await search.run(plan({ threshold: 1 }));
    const loose = new Set(search.hits().map((hit) => hit.channel));

    await search.run(plan({ threshold: 1, specific: true, specificThreshold: 0.3 }));
    const strict = new Set(search.hits().map((hit) => hit.channel));

    // An extra condition on the same threshold is a filter, so the strict set
    // has to be a subset. It need not be a proper one: on this fake every
    // channel that clears the threshold happens to be quiet elsewhere too.
    for (const channel of strict) expect(loose.has(channel)).toBe(true);
  });

  it('rejects everything under an unreachable ceiling', async () => {
    const { search } = make(makeApi());
    await search.run(plan({ threshold: 1, specific: true, specificThreshold: 0.001 }));
    expect(search.hits()).toEqual([]);
  });
});

describe('ChannelSearch: the worker fallback', () => {
  it('scores on the main thread when no Worker exists', async () => {
    // jsdom has no Worker, so this suite has been exercising the fallback all
    // along -- asserted explicitly so a regression in it cannot hide.
    expect(typeof Worker).toBe('undefined');
    const { search } = make(makeApi());
    await search.run(plan());
    expect(search.hits().length).toBeGreaterThan(0);
  });

  it("does not detach the caller's buffer", async () => {
    const frames: ActivationFrame[] = [];
    const { search } = make(
      makeApi({
        getActivationFrame: async (key) => {
          const frame = await store.frame(key);
          frames.push(frame);
          return frame;
        },
      }),
    );
    await search.run(plan());

    // A transferred buffer would come back with length 0, and the grid would
    // then draw an empty tile for a frame it still holds.
    for (const frame of frames) expect(frame.data.length).toBeGreaterThan(0);
  });
});

