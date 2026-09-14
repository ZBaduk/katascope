/**
 * Playing against the reduced head.
 *
 * The rules are core's and the head arithmetic is core's; what is tested here
 * is the loop around them. Two failures matter most and neither would be
 * visible on screen: a move generated for a position the game has already left,
 * and the bridge falling out of step with the record -- after which every frame
 * fetched describes a different position from the one on the board.
 */

import { TestBed } from '@angular/core/testing';
import {
  emptyGame,
  FakeActivationStore,
  parseSgf,
  squareBoardSize,
  type GameRecord,
  type KatascopeApi,
  type LoadedGame,
  type NetworkSpec,
} from '@katascope/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { KATASCOPE_API } from '../platform/katascope-api';
import { SessionStore } from '../state/session-store';
import { PlaySession } from './play-session';
import { ReduceStore } from './reduce-store';

const SPEC: NetworkSpec = {
  name: 'b6c96',
  blocks: 6,
  channels: 96,
  boardSize: squareBoardSize(19),
};

let store: FakeActivationStore;
/** What the fake bridge believes the game is. The real one holds this in main. */
let bridgeGame: GameRecord | undefined;

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
    setGame: async (game: GameRecord): Promise<LoadedGame> => {
      bridgeGame = game;
      return { path: '(played)', game };
    },
    ...overrides,
  };
}

async function make(api: Partial<KatascopeApi> | null = makeApi(), game?: GameRecord) {
  // Two runs in one test compare one selection against another, and TestBed
  // refuses to be reconfigured once instantiated.
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [{ provide: KATASCOPE_API, useValue: api as KatascopeApi | null }],
  });
  const session = TestBed.inject(SessionStore);
  session.setNetworkSpec(SPEC);
  session.setGame({ path: '/tmp/g.sgf', game: game ?? emptyGame(squareBoardSize(19)) });
  const reduce = TestBed.inject(ReduceStore);
  await reduce.ensureWeights();
  return { play: TestBed.inject(PlaySession), session, reduce };
}

beforeEach(() => {
  store = new FakeActivationStore({ spec: SPEC });
  bridgeGame = undefined;
});

describe('PlaySession: whose turn', () => {
  it('knows the network is not playing when it is off', async () => {
    const { play } = await make();
    expect(play.side()).toBe('off');
    expect(play.netToPlay()).toBe(false);
  });

  it('claims only its own colour', async () => {
    const { play } = await make();
    play.setSide('white');
    // An empty game starts with black, so white is not to play.
    expect(play.toPlay()).toBe('black');
    expect(play.netToPlay()).toBe(false);

    play.setSide('black');
    expect(play.netToPlay()).toBe(true);
  });

  it('claims both colours in self-play', async () => {
    const { play } = await make();
    play.setSide('both');
    expect(play.netToPlay()).toBe(true);
  });

  it('follows the move number rather than assuming alternation', async () => {
    // A handicap game starts with White, and a side selector keyed on parity
    // would have the network playing the wrong colour for the whole game.
    const handicap = parseSgf('(;GM[1]FF[4]SZ[19]HA[2]AB[pd][dp])');
    const { play } = await make(makeApi(), handicap);
    play.setSide('white');
    expect(play.toPlay()).toBe('white');
    expect(play.netToPlay()).toBe(true);
  });
});

describe('PlaySession: stepping', () => {
  it('plays one legal move', async () => {
    const { play, session } = await make();
    play.setSide('black');
    await play.step();

    expect(session.game()?.game.moves).toHaveLength(1);
    const move = session.game()?.game.moves[0];
    expect(move?.player).toBe('black');
    expect(play.played()).toBe(1);
  });

  it('tells the bridge before the board moves', async () => {
    // Everything downstream turns a move number into a position using the
    // record the bridge holds. If the renderer advanced first, a frame fetched
    // in the gap would describe a position the sidecar has never seen.
    const { play, session } = await make();
    play.setSide('black');
    await play.step();

    expect(bridgeGame?.moves).toHaveLength(1);
    expect(bridgeGame?.moves[0]).toEqual(session.game()?.game.moves[0]);
  });

  it('advances the selected move so the board shows the new stone', async () => {
    const { play, session } = await make();
    play.setSide('black');
    await play.step();
    expect(session.moveNumber()).toBe(1);
  });

  it('does nothing when it is not the network’s turn', async () => {
    const { play, session } = await make();
    play.setSide('white'); // black to play
    await play.step();
    expect(session.game()?.game.moves).toHaveLength(0);
  });

  it('does nothing when it is off', async () => {
    const { play, session } = await make();
    await play.step();
    expect(session.game()?.game.moves).toHaveLength(0);
  });

  it('never repeats a point, because it only plays legal moves', async () => {
    const { play, session } = await make();
    play.setSide('both');
    for (let i = 0; i < 8; i++) await play.step();

    const moves = session.game()?.game.moves ?? [];
    const seen = new Set<string>();
    for (const move of moves) {
      if (move.kind !== 'play') continue;
      const key = `${move.vertex.x},${move.vertex.y}`;
      // Playing an occupied point would mean the legality filter is not
      // running at all; the head itself knows nothing about legality.
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
    expect(moves.length).toBe(8);
  });

  it('alternates colours', async () => {
    const { play, session } = await make();
    play.setSide('both');
    for (let i = 0; i < 4; i++) await play.step();
    expect((session.game()?.game.moves ?? []).map((m) => m.player)).toEqual([
      'black',
      'white',
      'black',
      'white',
    ]);
  });
});

describe('PlaySession: the loop', () => {
  it('plays on until stopped', async () => {
    const { play, session } = await make();
    play.setSide('both');
    play.setDelay(0);

    const running = play.start();
    // Let a few moves land, then stop.
    await new Promise((resolve) => setTimeout(resolve, 50));
    play.stop();
    await running;

    const played = session.game()?.game.moves.length ?? 0;
    expect(played).toBeGreaterThan(0);
    expect(play.running()).toBe(false);
  });

  it('stops when the human owns the turn', async () => {
    const { play, session } = await make();
    play.setSide('black');
    play.setDelay(0);
    await play.start();

    // One move for black, then it is white's turn and white is the human.
    expect(session.game()?.game.moves).toHaveLength(1);
    expect(play.state()).toBe('waiting');
    expect(play.running()).toBe(false);
  });

  it('is deterministic: the same selection plays the same game', async () => {
    const first = await make();
    first.play.setSide('both');
    first.play.setDelay(0);
    for (let i = 0; i < 6; i++) await first.play.step();
    const a = JSON.stringify(first.session.game()?.game.moves);

    store = new FakeActivationStore({ spec: SPEC });
    const second = await make();
    second.play.setSide('both');
    second.play.setDelay(0);
    for (let i = 0; i < 6; i++) await second.play.step();
    const b = JSON.stringify(second.session.game()?.game.moves);

    // Greedy rather than sampled, so a difference between two runs is a
    // difference in the selection and never a difference in the dice.
    expect(a).toEqual(b);
  });

  it('plays a different game for a different selection', async () => {
    const first = await make();
    first.play.setSide('both');
    for (let i = 0; i < 4; i++) await first.play.step();
    const a = JSON.stringify(first.session.game()?.game.moves);

    store = new FakeActivationStore({ spec: SPEC });
    const second = await make();
    second.reduce.toggle(3);
    second.reduce.toggle(9);
    second.play.setSide('both');
    for (let i = 0; i < 4; i++) await second.play.step();
    const b = JSON.stringify(second.session.game()?.game.moves);

    // If these matched, the selection would not be reaching the head at all,
    // and the whole feature would be showing the full head under another name.
    expect(a).not.toEqual(b);
  });

  it('refuses to start without head weights', async () => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        {
          provide: KATASCOPE_API,
          useValue: makeApi({
            getHeadWeights: () => Promise.reject(new Error('no weights')),
          }) as KatascopeApi,
        },
      ],
    });
    const session = TestBed.inject(SessionStore);
    session.setNetworkSpec(SPEC);
    session.setGame({ path: '/tmp/g.sgf', game: emptyGame(squareBoardSize(19)) });
    const play = TestBed.inject(PlaySession);
    play.setSide('both');

    await play.start();
    expect(play.state()).toBe('error');
    expect(play.error()).toContain('Reduce');
  });

  it('reports a failed frame read rather than stalling', async () => {
    const { play } = await make(
      makeApi({ getActivationFrame: () => Promise.reject(new Error('sidecar died')) }),
    );
    play.setSide('both');
    await play.start();
    expect(play.state()).toBe('error');
    expect(play.error()).toContain('sidecar died');
    expect(play.running()).toBe(false);
  });
});

describe('PlaySession: cancellation', () => {
  it('discards a move chosen for a position the game has left', async () => {
    const gate = deferred<Awaited<ReturnType<FakeActivationStore['frame']>>>();
    let calls = 0;
    const { play, session } = await make(
      makeApi({
        getActivationFrame: (key) => {
          calls++;
          return calls === 1 ? gate.promise : store.frame(key);
        },
      }),
    );
    play.setSide('both');

    const stepping = play.step();
    play.stop();
    gate.resolve(await store.frame({ moveNumber: 0, block: SPEC.blocks - 1 }));
    await stepping;

    // A move decided for a position that is no longer on the board must not be
    // appended; it would be a move from a different game.
    expect(session.game()?.game.moves).toHaveLength(0);
  });

  it('stops the loop without leaving it running', async () => {
    const { play } = await make();
    play.setSide('both');
    play.setDelay(1000);
    const running = play.start();
    play.stop();
    await running;
    expect(play.running()).toBe(false);
  });

  it('turning the network off stops it', async () => {
    const { play } = await make();
    play.setSide('both');
    play.setDelay(1000);
    const running = play.start();
    play.setSide('off');
    await running;
    expect(play.running()).toBe(false);
  });
});

describe('PlaySession: a move chosen for a stale position', () => {
  it('is discarded when someone else played while it was thinking', async () => {
    const gate = deferred<Awaited<ReturnType<FakeActivationStore['frame']>>>();
    let calls = 0;
    const { play, session } = await make(
      makeApi({
        getActivationFrame: (key) => {
          calls++;
          return calls === 1 ? gate.promise : store.frame(key);
        },
      }),
    );
    play.setSide('both');

    // The network starts thinking about move 0...
    const stepping = play.step();
    // ...and a human plays in the meantime.
    await session.playMove({ kind: 'play', player: 'black', vertex: { x: 3, y: 3 } });
    gate.resolve(await store.frame({ moveNumber: 0, block: SPEC.blocks - 1 }));
    await stepping;

    // Only the human's move. The reply was a reply to a board that no longer
    // exists -- and was checked for legality against that board, so it need not
    // even be legal on this one.
    expect(session.game()?.game.moves).toHaveLength(1);
    expect(session.game()?.game.moves[0]).toEqual({
      kind: 'play',
      player: 'black',
      vertex: { x: 3, y: 3 },
    });
  });

  it('keeps going from the position that is actually on the board', async () => {
    const { play, session } = await make();
    play.setSide('both');
    await play.step();
    await session.playMove({ kind: 'pass', player: 'white' });
    await play.step();

    // The network's second move answers the human's pass, not its own move.
    expect(session.game()?.game.moves).toHaveLength(3);
    expect(session.game()?.game.moves[2]?.player).toBe('black');
  });
});

describe('PlaySession: settings', () => {
  it('reports the move limit as a limit, not as a finished game', async () => {
    // "Game over" would claim the network decided the game was over, which at
    // the cap it did not.
    const { play } = await make();
    play.setSide('both');
    play.setDelay(0);
    await play.start();
    expect(play.state()).toBe('capped');
    expect(play.played()).toBe(400);
  });

  it('clamps the delay to something sane', async () => {
    const { play } = await make();
    play.setDelay(-100);
    expect(play.delayMs()).toBe(0);
    play.setDelay(999_999);
    expect(play.delayMs()).toBe(5_000);
  });

  it('keeps its own eyes by default, and can be told not to', async () => {
    const { play } = await make();
    expect(play.avoidEyes()).toBe(true);
    play.setAvoidEyes(false);
    expect(play.avoidEyes()).toBe(false);
  });

  it('resets its counters without touching the game', async () => {
    const { play, session } = await make();
    play.setSide('both');
    await play.step();
    expect(play.played()).toBe(1);

    play.reset();
    expect(play.played()).toBe(0);
    expect(play.state()).toBe('idle');
    // The move stays: reset is about the run, not the record.
    expect(session.game()?.game.moves).toHaveLength(1);
  });
});

describe('SessionStore: playing', () => {
  it('truncates a branch rather than keeping the old continuation', async () => {
    const game = parseSgf('(;GM[1]FF[4]SZ[19];B[pd];W[dp];B[pp];W[dd])');
    const { session } = await make(makeApi(), game);
    session.setMoveNumber(2);

    await session.playMove({ kind: 'pass', player: 'black' });

    // Keeping moves 3 and 4 would leave a record whose board does not match
    // its own move list.
    expect(session.game()?.game.moves).toHaveLength(3);
    expect(session.moveNumber()).toBe(3);
  });

  it('starts a new game and tells the bridge', async () => {
    const { session } = await make();
    await session.newGame(squareBoardSize(13));
    expect(session.game()?.game.size).toEqual(squareBoardSize(13));
    expect(bridgeGame?.size).toEqual(squareBoardSize(13));
    expect(session.moveNumber()).toBe(0);
  });

  it('refuses to play with no game open', async () => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [{ provide: KATASCOPE_API, useValue: makeApi() as KatascopeApi }],
    });
    const session = TestBed.inject(SessionStore);
    await expect(session.playMove({ kind: 'pass', player: 'black' })).rejects.toThrow(/no game/);
  });

  it('drops cached frames beyond the branch point', async () => {
    const game = parseSgf('(;GM[1]FF[4]SZ[19];B[pd];W[dp];B[pp];W[dd])');
    const frames = vi.fn((key: { moveNumber: number; block: number }) => store.frame(key));
    const { session } = await make(makeApi({ getActivationFrame: frames }), game);

    session.setMoveNumber(3);
    await session.ensureFrame();
    const before = frames.mock.calls.length;

    session.setMoveNumber(1);
    await session.playMove({ kind: 'pass', player: 'white' });
    session.setMoveNumber(2);
    await session.ensureFrame();

    // Move 2 of the new branch is a different position from move 2 of the old
    // one; serving the cached frame would describe the wrong board.
    expect(frames.mock.calls.length).toBeGreaterThan(before);
  });
});
