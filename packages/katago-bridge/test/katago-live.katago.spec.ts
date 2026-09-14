/**
 * Integration tests against a real KataGo binary.
 *
 * Tagged `@katago` and **skipped** -- never failed -- when no binary, model and
 * analysis config are configured. Point `katascope.config.local.json` at your
 * install to enable them.
 *
 * These cover what the scripted-process tests deliberately cannot: that the
 * query katascope builds is one KataGo accepts, that the fields it reads are
 * ones KataGo sends, and that the lifecycle survives a real process.
 *
 * `.katago.spec.ts` in the filename so CI can exclude the file by glob as well
 * as by tag; the skip is the safety net, the exclusion is the intent.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { gtpToVertex, play, squareBoardSize } from '@katascope/core';
import { KataGoAnalysisEngine } from '../src/index.js';
import { KATAGO } from './support/katago-env.js';

if (!KATAGO.available) {
  console.info(`[@katago] skipping live engine tests -- ${KATAGO.reason}`);
}

const SIZE = squareBoardSize(19);
// A cold engine loads a model and may build a GPU plan; be patient.
const SLOW = 300_000;

function newEngine(): KataGoAnalysisEngine {
  return new KataGoAnalysisEngine({
    katagoPath: KATAGO.config.katagoPath,
    modelPath: KATAGO.config.modelPath,
    configPath: KATAGO.config.katagoConfigPath,
    timeoutMs: SLOW,
  });
}

describe.skipIf(!KATAGO.available)('@katago KataGoAnalysisEngine against a real binary', () => {
  let engine: KataGoAnalysisEngine;

  beforeAll(async () => {
    engine = newEngine();
    await engine.start();
  }, SLOW);

  afterAll(async () => {
    await engine?.dispose();
  });

  it('reports its version and reaches the ready state', async () => {
    expect(await engine.version()).toMatch(/^\d+\.\d+/);
    expect(engine.state).toBe('ready');
  });

  it('analyses the empty board', async () => {
    const result = await engine.analyze({
      boardSize: SIZE,
      rules: 'chinese',
      komi: 7.5,
      initialStones: [],
      moves: [],
      turnNumber: 0,
      // One visit is a raw-net read and reports no candidate moves, so ask for
      // a handful to exercise the moveInfos path as well.
      maxVisits: 8,
    });

    expect(result.turnNumber).toBe(0);
    expect(result.rootInfo.winrate).toBeGreaterThanOrEqual(0);
    expect(result.rootInfo.winrate).toBeLessThanOrEqual(1);
    expect(result.rootInfo.visits).toBeGreaterThan(0);
    expect(result.moveInfos.length).toBeGreaterThan(0);

    for (const info of result.moveInfos) {
      // Every candidate must be a coordinate katascope can read back; the
      // round trip is the thing most likely to rot.
      if (info.move !== 'pass') expect(gtpToVertex(SIZE, info.move)).toBeDefined();
      expect(info.winrate).toBeGreaterThanOrEqual(0);
      expect(info.winrate).toBeLessThanOrEqual(1);
      expect(info.prior).toBeGreaterThanOrEqual(0);
    }
  }, SLOW);

  it('returns policy and ownership when asked', async () => {
    const result = await engine.analyze({
      boardSize: SIZE,
      rules: 'chinese',
      komi: 7.5,
      initialStones: [],
      moves: [play('black', { x: 15, y: 3 }), play('white', { x: 3, y: 15 })],
      turnNumber: 2,
      maxVisits: 1,
      includePolicy: true,
      includeOwnership: true,
    });

    const area = SIZE.width * SIZE.height;
    expect(result.policy).toHaveLength(area + 1);
    expect(result.ownership).toHaveLength(area);

    // Illegal moves are reported as -1 and preserved, not zeroed.
    const policy = result.policy ?? [];
    const legal = policy.filter((p) => p >= 0);
    expect(legal.length).toBe(area + 1 - 2); // the two played points
    expect(legal.reduce((sum, p) => sum + p, 0)).toBeCloseTo(1, 2);

    // The two occupied points must be the illegal ones, which pins orientation.
    expect(policy[3 * SIZE.width + 15]).toBeLessThan(0); // Q16
    expect(policy[15 * SIZE.width + 3]).toBeLessThan(0); // D4

    for (const value of result.ownership ?? []) {
      expect(value).toBeGreaterThanOrEqual(-1);
      expect(value).toBeLessThanOrEqual(1);
    }
  }, SLOW);

  it('omits policy and ownership when not asked', async () => {
    const result = await engine.analyze({
      boardSize: SIZE,
      rules: 'chinese',
      komi: 7.5,
      initialStones: [],
      moves: [],
      turnNumber: 0,
      maxVisits: 1,
    });
    expect(result.policy).toBeUndefined();
    expect(result.ownership).toBeUndefined();
  }, SLOW);

  it('handles setup stones without treating them as moves', async () => {
    const result = await engine.analyze({
      boardSize: SIZE,
      rules: 'chinese',
      komi: 0.5,
      initialStones: [
        { color: 'black', vertex: { x: 3, y: 3 } },
        { color: 'black', vertex: { x: 15, y: 3 } },
        { color: 'black', vertex: { x: 3, y: 15 } },
        { color: 'black', vertex: { x: 15, y: 15 } },
      ],
      moves: [],
      turnNumber: 0,
      maxVisits: 1,
      includePolicy: true,
      // Four black stones and no moves: White answers a handicap.
      initialPlayer: 'W',
    });

    const policy = result.policy ?? [];
    for (const [x, y] of [
      [3, 3],
      [15, 3],
      [3, 15],
      [15, 15],
    ] as const) {
      expect(policy[y * SIZE.width + x]).toBeLessThan(0);
    }
  }, SLOW);

  it('is deterministic, which the golden test depends on', async () => {
    const query = {
      boardSize: SIZE,
      rules: 'chinese',
      komi: 7.5,
      initialStones: [],
      moves: [play('black', { x: 15, y: 3 })],
      turnNumber: 1,
      maxVisits: 1,
      includePolicy: true,
      includeOwnership: true,
    } as const;

    const first = await engine.analyze(query);
    const second = await engine.analyze(query);
    // If this fails, configs/analysis-deterministic.cfg has stopped suppressing
    // random symmetries and every measured tolerance is meaningless.
    expect(second.policy).toEqual(first.policy);
    expect(second.ownership).toEqual(first.ownership);
  }, SLOW);
});

describe.skipIf(!KATAGO.available)('@katago engine lifecycle', () => {
  it('restarts in place, keeping the existing reference usable', async () => {
    const engine = newEngine();
    try {
      expect(await engine.version()).toMatch(/^\d+\.\d+/);
      await engine.restart();
      expect(engine.state).toBe('ready');
      // The point of restart(): the object survives, so the bridge need not be
      // rebuilt and the IPC layer keeps the reference it was handed at startup.
      expect(await engine.version()).toMatch(/^\d+\.\d+/);
    } finally {
      await engine.dispose();
    }
  }, SLOW);

  it('reports failed after a start that cannot work, without throwing on state', async () => {
    const engine = new KataGoAnalysisEngine({
      katagoPath: '/nonexistent/katago',
      modelPath: KATAGO.config.modelPath,
      configPath: KATAGO.config.katagoConfigPath,
    });
    await expect(engine.start()).rejects.toThrow(/is "\/nonexistent\/katago" installed/);
    expect(engine.state).toBe('failed');
    await engine.dispose();
  });

  it('refuses to work after dispose', async () => {
    const engine = newEngine();
    await engine.start();
    await engine.dispose();
    await expect(engine.start()).rejects.toThrow(/disposed/);
  }, SLOW);
});
