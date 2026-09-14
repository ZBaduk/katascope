/**
 * The channel selection and the reduction it drives.
 *
 * The head arithmetic is core's and is tested there against the real model.
 * What is tested here is everything around it: which set the buttons produce,
 * that a result for a move the user has left cannot land, and that the cache is
 * keyed on everything the answer depends on -- a cache keyed on too little
 * would serve a policy computed for a different selection, which looks entirely
 * plausible and is entirely wrong.
 */

import { TestBed } from '@angular/core/testing';
import {
  FakeActivationStore,
  squareBoardSize,
  type ActivationFrame,
  type HeadWeights,
  type KatascopeApi,
  type NetworkSpec,
} from '@katascope/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { KATASCOPE_API } from '../platform/katascope-api';
import { SessionStore } from '../state/session-store';
import { ReduceStore } from './reduce-store';

const SPEC: NetworkSpec = {
  name: 'b6c96',
  blocks: 6,
  channels: 96,
  boardSize: squareBoardSize(19),
};

let store: FakeActivationStore;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function makeApi(overrides: Partial<KatascopeApi> = {}): Partial<KatascopeApi> {
  return {
    getHeadWeights: () => store.headWeights(),
    getActivationFrame: (key) => store.frame(key),
    ...overrides,
  };
}

function make(api: Partial<KatascopeApi> | null = makeApi()): {
  reduce: ReduceStore;
  session: SessionStore;
} {
  TestBed.configureTestingModule({
    providers: [{ provide: KATASCOPE_API, useValue: api as KatascopeApi | null }],
  });
  const session = TestBed.inject(SessionStore);
  session.setNetworkSpec(SPEC);
  return { reduce: TestBed.inject(ReduceStore), session };
}

async function frameData(): Promise<Float32Array> {
  const frame: ActivationFrame = await store.frame({ moveNumber: 0, block: SPEC.blocks - 1 });
  return frame.data instanceof Float32Array ? frame.data : Float32Array.from(frame.data);
}

beforeEach(() => {
  store = new FakeActivationStore({ spec: SPEC });
});

describe('ReduceStore: the selection', () => {
  it('starts empty', () => {
    const { reduce } = make();
    expect(reduce.selectedCount()).toBe(0);
    expect(reduce.hasSelection()).toBe(false);
  });

  it('toggles a channel on and off', () => {
    const { reduce } = make();
    reduce.toggle(7);
    expect([...reduce.selected()]).toEqual([7]);
    reduce.toggle(7);
    expect([...reduce.selected()]).toEqual([]);
  });

  it('selects every channel', () => {
    const { reduce } = make();
    reduce.selectAll(96);
    expect(reduce.selectedCount()).toBe(96);
    expect(reduce.selected().has(95)).toBe(true);
  });

  it('inverts the selection', () => {
    const { reduce } = make();
    reduce.toggle(0);
    reduce.toggle(5);
    reduce.invert(8);
    expect([...reduce.selected()].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 6, 7]);
  });

  it('inverts an empty selection into everything', () => {
    const { reduce } = make();
    reduce.invert(4);
    expect([...reduce.selected()].sort((a, b) => a - b)).toEqual([0, 1, 2, 3]);
  });

  it('clears', () => {
    const { reduce } = make();
    reduce.selectAll(10);
    reduce.clear();
    expect(reduce.selectedCount()).toBe(0);
  });

  it('selects by tint, which is the question the tint invites', () => {
    const { reduce } = make();
    const leans = ['policy', 'value', 'shared', 'policy'] as const;
    reduce.selectByLean(leans, 'policy');
    expect([...reduce.selected()].sort((a, b) => a - b)).toEqual([0, 3]);
    reduce.selectByLean(leans, 'value');
    expect([...reduce.selected()]).toEqual([1]);
  });

  it('replaces the set rather than mutating it, so signals notify', () => {
    const { reduce } = make();
    const before = reduce.selected();
    reduce.toggle(1);
    expect(reduce.selected()).not.toBe(before);
    expect(before.size).toBe(0);
  });
});

describe('ReduceStore: weights', () => {
  it('fetches them once and caches', async () => {
    const getHeadWeights = vi.fn(() => store.headWeights());
    const { reduce } = make(makeApi({ getHeadWeights }));

    await reduce.ensureWeights();
    await reduce.ensureWeights();
    expect(getHeadWeights).toHaveBeenCalledTimes(1);
    expect(reduce.available()).toBe(true);
  });

  it('reports why they are unavailable rather than offering a dead control', async () => {
    const { reduce } = make(
      makeApi({
        getHeadWeights: () => Promise.reject(new Error('the active source has no head weights')),
      }),
    );
    await reduce.ensureWeights();
    expect(reduce.available()).toBe(false);
    expect(reduce.weightsError()).toContain('no head weights');
  });

  it('does nothing without a bridge', async () => {
    const { reduce } = make(null);
    await reduce.ensureWeights();
    expect(reduce.available()).toBe(false);
  });

  it('drops everything on reset, so a new source cannot inherit the old one', async () => {
    const { reduce } = make();
    await reduce.ensureWeights();
    expect(reduce.available()).toBe(true);
    reduce.reset();
    expect(reduce.available()).toBe(false);
    expect(reduce.result()).toBeUndefined();
  });
});

describe('ReduceStore: running', () => {
  it('produces a full output, a reduced one and their difference', async () => {
    const { reduce } = make();
    await reduce.ensureWeights();
    reduce.toggle(3);

    const data = await frameData();
    await reduce.run(data, { planes: SPEC.boardSize, board: SPEC.boardSize });

    const result = reduce.result();
    expect(reduce.state()).toBe('ready');
    expect(result).toBeDefined();
    expect(result?.full.values.length).toBe(19 * 19);
    expect(result?.reduced.values.length).toBe(19 * 19);
    expect(result?.difference.length).toBe(19 * 19);
    expect([...(result?.full.values ?? [])].every(Number.isFinite)).toBe(true);
  });

  it('changes the output when the selection changes', async () => {
    const { reduce } = make();
    await reduce.ensureWeights();
    const data = await frameData();
    const geometry = { planes: SPEC.boardSize, board: SPEC.boardSize };

    reduce.toggle(1);
    await reduce.run(data, geometry);
    const first = [...(reduce.result()?.reduced.values ?? [])];

    reduce.toggle(2);
    await reduce.run(data, geometry);
    const second = [...(reduce.result()?.reduced.values ?? [])];

    // If these matched, the selection would not be reaching the head at all.
    expect(first).not.toEqual(second);
  });

  it('gives the full output back when "without" selects nothing', async () => {
    const { reduce } = make();
    await reduce.ensureWeights();
    reduce.setMode('without');
    await reduce.run(await frameData(), { planes: SPEC.boardSize, board: SPEC.boardSize });

    const result = reduce.result();
    expect([...(result?.difference ?? [])].every((v) => Math.abs(v) < 1e-5)).toBe(true);
  });

  it('does nothing without weights', async () => {
    const { reduce } = make();
    await reduce.run(await frameData(), { planes: SPEC.boardSize, board: SPEC.boardSize });
    expect(reduce.result()).toBeUndefined();
    expect(reduce.state()).toBe('idle');
  });

  it('runs the ownership head when asked, giving values in [-1, 1]', async () => {
    const { reduce } = make();
    await reduce.ensureWeights();
    reduce.setHead('ownership');
    reduce.toggle(0);
    await reduce.run(await frameData(), { planes: SPEC.boardSize, board: SPEC.boardSize });

    const values = [...(reduce.result()?.full.values ?? [])];
    expect(values.length).toBeGreaterThan(0);
    expect(values.every((v) => v >= -1 && v <= 1)).toBe(true);
    // Ownership has no pass; policy does.
    expect(reduce.result()?.reduced.pass).toBeUndefined();
  });

  it('reports a pass shift for the policy head', async () => {
    const { reduce } = make();
    await reduce.ensureWeights();
    reduce.toggle(0);
    await reduce.run(await frameData(), { planes: SPEC.boardSize, board: SPEC.boardSize });
    expect(reduce.result()?.passDifference).toBeDefined();
  });
});

describe('ReduceStore: caching and cancellation', () => {
  it('keys the cache on the head, so switching heads recomputes', async () => {
    const { reduce } = make();
    await reduce.ensureWeights();
    const data = await frameData();
    const geometry = { planes: SPEC.boardSize, board: SPEC.boardSize };

    reduce.toggle(1);
    await reduce.run(data, geometry);
    const policy = [...(reduce.result()?.full.values ?? [])];

    reduce.setHead('ownership');
    await reduce.run(data, geometry);
    const ownership = [...(reduce.result()?.full.values ?? [])];

    // A cache keyed on the selection alone would serve the policy here.
    expect(ownership).not.toEqual(policy);
  });

  it('keys the cache on the mode', async () => {
    const { reduce } = make();
    await reduce.ensureWeights();
    const data = await frameData();
    const geometry = { planes: SPEC.boardSize, board: SPEC.boardSize };

    reduce.toggle(1);
    await reduce.run(data, geometry);
    const only = [...(reduce.result()?.reduced.values ?? [])];

    reduce.setMode('without');
    await reduce.run(data, geometry);
    const without = [...(reduce.result()?.reduced.values ?? [])];

    expect(without).not.toEqual(only);
  });

  it('treats the same set reached two ways as one cache entry', async () => {
    const { reduce } = make();
    await reduce.ensureWeights();
    const data = await frameData();
    const geometry = { planes: SPEC.boardSize, board: SPEC.boardSize };

    reduce.toggle(5);
    reduce.toggle(2);
    await reduce.run(data, geometry);
    const first = [...(reduce.result()?.reduced.values ?? [])];

    reduce.clear();
    reduce.toggle(2);
    reduce.toggle(5);
    await reduce.run(data, geometry);
    expect([...(reduce.result()?.reduced.values ?? [])]).toEqual(first);
  });

  it('discards a result for a run that was cancelled', async () => {
    const gate = deferred<HeadWeights>();
    const { reduce } = make(makeApi({ getHeadWeights: () => gate.promise }));
    const weights = await store.headWeights();

    const pending = reduce.ensureWeights();
    gate.resolve(weights);
    await pending;

    reduce.toggle(1);
    const data = await frameData();
    const running = reduce.run(data, { planes: SPEC.boardSize, board: SPEC.boardSize });
    reduce.cancel();
    await running;

    // A reply for a move or selection the user has left must not be painted.
    expect(reduce.result()).toBeUndefined();
    expect(reduce.state()).toBe('idle');
  });
});

describe('ReduceStore: geometry', () => {
  it('uses the game board inside the network extent', () => {
    const { reduce, session } = make();
    session.setGame({
      path: '/tmp/g.sgf',
      game: {
        size: { width: 9, height: 9 },
        info: { komi: 7, handicap: 0 },
        setup: [],
        moves: [],
      },
    });
    const geometry = reduce.geometryFor(SPEC.boardSize);
    // The pooled branch divides by the on-board count; getting this wrong
    // scales every pooled feature by 81/361 and quietly moves the pass logit.
    expect(geometry.planes).toEqual(SPEC.boardSize);
    expect(geometry.board).toEqual({ width: 9, height: 9 });
  });

  it('falls back to the extent when no game is loaded', () => {
    const { reduce } = make();
    const geometry = reduce.geometryFor(SPEC.boardSize);
    expect(geometry.board).toEqual(SPEC.boardSize);
  });
});
