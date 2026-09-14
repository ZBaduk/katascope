/**
 * The bridge against a scripted peer.
 *
 * These spawn a real child process with real pipes; only the far end is a
 * fixture. That is the point -- the code under test is framing, correlation,
 * and failure handling, none of which a mocked `child_process` would exercise.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { parseSgf, play, squareBoardSize, type GameRecord } from '@katascope/core';
import {
  KataGoAnalysisEngine,
  SidecarActivationStore,
  SidecarProtocolError,
} from '../src/index.js';
import { scriptedBinary, type ScriptedBinary } from './support/scripted-process.js';

const SIZE = squareBoardSize(19);
const open: ScriptedBinary[] = [];
const disposers: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose();
  for (const binary of open.splice(0)) binary.cleanup();
});

function katago(transcript: string): KataGoAnalysisEngine {
  const binary = scriptedBinary(transcript);
  open.push(binary);
  const engine = new KataGoAnalysisEngine({
    katagoPath: binary.path,
    modelPath: '/fixtures/model.bin.gz',
    configPath: '/fixtures/analysis.cfg',
    timeoutMs: 4_000,
  });
  disposers.push(() => engine.dispose());
  return engine;
}

/** A two-move game, so the store has positions to build. */
const GAME: GameRecord = parseSgf('(;GM[1]FF[4]SZ[19]KM[7.5]RU[Chinese];B[pd];W[dp])');

// `null` means "deliberately no game"; an omitted argument gets the default.
function sidecar(transcript: string, game: GameRecord | null = GAME): SidecarActivationStore {
  const binary = scriptedBinary(transcript);
  open.push(binary);
  const store = new SidecarActivationStore({
    pythonPath: binary.path,
    sidecarPath: '/fixtures/serve.py',
    modelPath: '/fixtures/model.ckpt',
    timeoutMs: 4_000,
  });
  if (game !== null) store.setGame(game);
  disposers.push(() => store.dispose());
  return store;
}

describe('KataGoAnalysisEngine', () => {
  it('reads a version over real stdio', async () => {
    await expect(katago('katago-version').version()).resolves.toBe('1.15.3');
  });

  it('spawns the binary with the arguments KataGo expects', async () => {
    const binary = scriptedBinary('katago-version');
    open.push(binary);
    const engine = new KataGoAnalysisEngine({
      katagoPath: binary.path,
      modelPath: '/fixtures/model.bin.gz',
      configPath: '/fixtures/analysis.cfg',
    });
    disposers.push(() => engine.dispose());
    await engine.version();
    expect(binary.receivedArgv()).toEqual([
      'analysis',
      '-model',
      '/fixtures/model.bin.gz',
      '-config',
      '/fixtures/analysis.cfg',
    ]);
  });

  it('encodes a query and decodes the analysis', async () => {
    // The transcript asserts the outgoing encoding; a mismatch kills the child
    // with a message, so a wire-format regression fails here rather than in
    // production against a real engine.
    const result = await katago('katago-analysis').analyze({
      boardSize: SIZE,
      rules: 'chinese',
      komi: 7.5,
      initialStones: [{ color: 'black', vertex: { x: 3, y: 3 } }],
      moves: [play('black', { x: 15, y: 3 }), play('white', { x: 3, y: 15 })],
      turnNumber: 2,
      maxVisits: 64,
    });

    expect(result.turnNumber).toBe(2);
    expect(result.rootInfo).toEqual({ winrate: 0.4831, scoreLead: -1.25, visits: 64 });
    expect(result.moveInfos).toHaveLength(3);
    expect(result.moveInfos[0]).toMatchObject({ move: 'Q4', order: 0, pv: ['Q4', 'D16', 'R14'] });
    expect(result.moveInfos[2]?.move).toBe('pass');
  });

  it('surfaces an engine-side query rejection', async () => {
    await expect(katago('katago-query-error').version()).rejects.toThrow(/Unknown rules \(rules\)/);
  });

  it('skips non-JSON chatter on stdout', async () => {
    await expect(katago('katago-noisy-stdout').version()).resolves.toBe('1.15.3');
  });

  it('rejects in-flight requests when the engine dies, with its stderr', async () => {
    const engine = katago('katago-crash');
    await expect(engine.version()).rejects.toThrow(/exited with exit code 3/);
    await expect(engine.version()).rejects.toThrow(/CUDA error: out of memory/);
  });

  it('reports a binary that cannot be executed', async () => {
    const engine = new KataGoAnalysisEngine({
      katagoPath: '/nonexistent/katago',
      modelPath: '/m',
      configPath: '/c',
    });
    disposers.push(() => engine.dispose());
    await expect(engine.version()).rejects.toThrow(/is "\/nonexistent\/katago" installed and on your PATH/);
  });

  it('times out instead of hanging on a silent engine', async () => {
    const binary = scriptedBinary('katago-silent');
    open.push(binary);
    const engine = new KataGoAnalysisEngine({
      katagoPath: binary.path,
      modelPath: '/m',
      configPath: '/c',
      timeoutMs: 250,
    });
    disposers.push(() => engine.dispose());
    await expect(engine.version()).rejects.toThrow(/timed out after 250ms/);
  });
});

describe('SidecarActivationStore', () => {
  it('spawns Python unbuffered with the model argument', async () => {
    const binary = scriptedBinary('sidecar-describe-frame');
    open.push(binary);
    const store = new SidecarActivationStore({
      pythonPath: binary.path,
      sidecarPath: '/fixtures/serve.py',
      modelPath: '/fixtures/model.ckpt',
    });
    disposers.push(() => store.dispose());
    await store.describe();
    // -u matters: a buffered sidecar would stall every response.
    expect(binary.receivedArgv()).toEqual([
      '-u',
      '/fixtures/serve.py',
      '--model',
      '/fixtures/model.ckpt',
    ]);
  });

  it('decodes a describe response into a NetworkSpec', async () => {
    await expect(sidecar('sidecar-describe-frame').describe()).resolves.toEqual({
      spec: {
        name: 'tiny-b2c2',
        blocks: 2,
        channels: 2,
        boardSize: { width: 2, height: 2 },
      },
      maxMoveNumber: 40,
      dtype: 'float32',
    });
  });

  it('decodes a float32 frame from the binary payload, preserving values exactly', async () => {
    const frame = await sidecar('sidecar-describe-frame').frame({ moveNumber: 1, block: 1 });
    expect(frame.data).toBeInstanceOf(Float32Array);
    expect([...frame.data]).toEqual([0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5]);
    expect(frame).toMatchObject({
      moveNumber: 1,
      block: 1,
      networkName: 'tiny-b2c2',
      channels: 2,
      dtype: 'float32',
      range: { min: 0, max: 3.5 },
    });
  });

  it('caches describe rather than asking twice', async () => {
    // The transcript has exactly one describe step; a second round trip would
    // run it out of steps and kill the child.
    const store = sidecar('sidecar-describe-frame');
    await store.describe();
    await store.describe();
    await expect(store.frame({ moveNumber: 1, block: 1 })).resolves.toBeDefined();
  });

  it('surfaces a sidecar-side error', async () => {
    // One assertion, one round trip: the transcript scripts a single error
    // reply, and asking twice would (correctly) run it out of steps.
    const error = await sidecar('sidecar-frame-error')
      .frame({ moveNumber: 0, block: 1 })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SidecarProtocolError);
    expect((error as Error).message).toMatch(/block 9 out of range/);
  });

  it('rejects a frame whose size contradicts the declared network', async () => {
    await expect(sidecar('sidecar-short-frame').frame({ moveNumber: 0, block: 0 })).rejects.toThrow(
      /is 8 bytes, expected 32/,
    );
  });

  it('rejects a describe response missing the network block', async () => {
    await expect(sidecar('sidecar-bad-describe').describe()).rejects.toThrow(/missing "network"/);
  });

  it('rejects a frame reply that arrives with no binary payload', async () => {
    await expect(sidecar('sidecar-no-payload').frame({ moveNumber: 0, block: 0 })).rejects.toThrow(
      /arrived with no binary payload/,
    );
  });

  it('reads the raw heads for the golden-test path', async () => {
    const heads = await sidecar('sidecar-heads').heads(1);
    expect(heads.policy).toEqual([0.1, 0.2, 0.3, 0.35, 0.05]);
    expect(heads.ownership).toEqual([-1, -0.5, 0.5, 1]);
    expect(heads.scoreLead).toBe(1.75);
  });

  it('decodes reader weights into per-block and per-head vectors', async () => {
    const weights = await sidecar('sidecar-reader-weights').readerWeights();
    // One vector per block but the last, which the heads read instead.
    expect(weights.byBlock).toHaveLength(1);
    expect([...(weights.byBlock[0] ?? [])]).toEqual([1.5, 0.5]);
    expect([...weights.heads.policy]).toEqual([9, 1]);
    expect([...weights.heads.value]).toEqual([1, 9]);
    expect(weights.channels).toBe(2);
  });

  it('caches reader weights rather than asking twice', async () => {
    // Static per network; the transcript has exactly one reader_weights step,
    // so a second round trip would run it out of steps and kill the child.
    const store = sidecar('sidecar-reader-weights');
    const first = await store.readerWeights();
    expect(await store.readerWeights()).toBe(first);
  });

  it('decodes attribution totals and planes', async () => {
    const result = await sidecar('sidecar-attribute').attribute({
      moveNumber: 1,
      target: { kind: 'winrate' },
      planeBlock: 1,
    });
    expect(result.blocks).toBe(2);
    expect(result.channels).toBe(2);
    expect([...result.byBlock]).toEqual([1, 2, 3, 4]);
    expect(result.planeBlock).toBe(1);
    // Signed: the totals drop the sign, the planes keep it.
    expect([...(result.planes ?? [])]).toEqual([-1, 0.5, -0.25, 1, 2, -2, 0.5, -0.5]);
  });

  it('rejects an attribution payload that claims planes it did not send', async () => {
    await expect(
      sidecar('sidecar-attribute-short').attribute({
        moveNumber: 0,
        target: { kind: 'ownership_total' },
        planeBlock: 0,
      }),
    ).rejects.toThrow(/expected 12 with planes/);
  });

  it('refuses to build a position without a game', () => {
    // The store turns a move number into a position, so it needs the game. The
    // check is on positionAt directly, which is where the requirement lives.
    const store = sidecar('sidecar-describe-frame', null);
    expect(() => store.positionAt(0)).toThrow(/no game loaded/);
  });

  it('rejects a move number the game does not reach', async () => {
    expect(() => sidecar('sidecar-describe-frame').positionAt(99)).toThrow(RangeError);
  });

  it('sends setup stones as initialStones, never as moves', async () => {
    // Handicap stones are not moves. Replaying them as moves would fill the
    // network's recent-play planes with five imaginary moves.
    const handicap = parseSgf('(;GM[1]FF[4]SZ[19]HA[2]KM[0.5]AB[pd][dp];W[dd])');
    const store = sidecar('sidecar-describe-frame', handicap);
    const position = store.positionAt(1);
    expect(position.initialStones).toEqual([
      ['B', 'Q16'],
      ['B', 'D4'],
    ]);
    expect(position.moves).toEqual([['W', 'D16']]);
    // Two black setup stones and no moves yet means White answers.
    expect(position.initialPlayer).toBe('W');
  });
});
