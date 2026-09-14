/** Covers the pure edges of the bridge: wire encoding, decoding, and config resolution. */

import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { pass, play, squareBoardSize, DEFAULT_CONFIG } from '@katascope/core';
import {
  createBridge,
  loadConfig,
  resolvePaths,
  toAnalysisResult,
  toKataGoQuery,
} from '../src/index.js';

const SIZE = squareBoardSize(19);

describe('toKataGoQuery', () => {
  it('encodes moves and setup stones as GTP pairs', () => {
    const query = toKataGoQuery({
      boardSize: SIZE,
      rules: 'chinese',
      komi: 7.5,
      initialStones: [{ color: 'black', vertex: { x: 3, y: 3 } }],
      moves: [play('black', { x: 15, y: 3 }), pass('white')],
      turnNumber: 2,
      maxVisits: 64,
    });
    expect(query['boardXSize']).toBe(19);
    expect(query['initialStones']).toEqual([['B', 'D16']]);
    expect(query['moves']).toEqual([
      ['B', 'Q16'],
      ['W', 'pass'],
    ]);
    expect(query['analyzeTurns']).toEqual([2]);
    expect(query['maxVisits']).toBe(64);
  });

  it('pins ignorePreRootHistory off, whatever the user config says', () => {
    // The analysis engine defaults this to true, which evaluates the root with
    // no history planes. The activation service always encodes the history it
    // is given, so the two would describe different positions. `katagoConfigPath`
    // is the user's file and may be KataGo's stock one, so the guarantee is made
    // per query rather than left to configuration.
    const query = toKataGoQuery({
      boardSize: SIZE,
      rules: 'chinese',
      komi: 7.5,
      initialStones: [],
      moves: [],
      turnNumber: 0,
      maxVisits: 1,
    });
    expect(query['overrideSettings']).toMatchObject({ ignorePreRootHistory: false });
  });

  it('pins whiteHandicapBonus to zero so the komi sent is the komi the net sees', () => {
    const query = toKataGoQuery({
      boardSize: SIZE,
      rules: 'chinese',
      komi: 0.5,
      initialStones: [],
      moves: [],
      turnNumber: 0,
      maxVisits: 1,
    });
    expect(query['whiteHandicapBonus']).toBe('0');
  });
});

describe('toAnalysisResult', () => {
  it('reads a well-formed response', () => {
    const result = toAnalysisResult(
      {
        turnNumber: 3,
        rootInfo: { winrate: 0.52, scoreLead: 1.5, visits: 100 },
        moveInfos: [{ move: 'Q16', visits: 60, winrate: 0.55, scoreLead: 2, prior: 0.3, order: 0, pv: ['Q16', 'D4'] }],
      },
      0,
    );
    expect(result.turnNumber).toBe(3);
    expect(result.rootInfo.visits).toBe(100);
    expect(result.moveInfos[0]?.pv).toEqual(['Q16', 'D4']);
  });

  it('fills in defaults for a sparse response', () => {
    const result = toAnalysisResult({}, 7);
    expect(result.turnNumber).toBe(7);
    expect(result.rootInfo).toEqual({ winrate: 0.5, scoreLead: 0, visits: 0 });
    expect(result.moveInfos).toEqual([]);
  });

  it('drops candidates with no move coordinate', () => {
    const result = toAnalysisResult({ moveInfos: [{ visits: 5 }, { move: 'D4' }] }, 0);
    expect(result.moveInfos.map((m) => m.move)).toEqual(['D4']);
  });
});

describe('resolvePaths', () => {
  it('leaves bare command names alone', () => {
    const resolved = resolvePaths(
      { ...DEFAULT_CONFIG, pythonPath: 'python3', katagoPath: 'katago' },
      '/opt/app',
    );
    expect(resolved.pythonPath).toBe('python3');
    expect(resolved.katagoPath).toBe('katago');
  });

  it('resolves commands that do contain a separator', () => {
    const resolved = resolvePaths({ ...DEFAULT_CONFIG, katagoPath: 'bin/katago' }, '/opt/app');
    expect(resolved.katagoPath).toBe('/opt/app/bin/katago');
  });

  it('resolves file paths against the config directory', () => {
    const resolved = resolvePaths(
      { ...DEFAULT_CONFIG, sidecarPath: 'tools/activation-service/serve.py' },
      '/opt/app',
    );
    expect(resolved.sidecarPath).toBe('/opt/app/tools/activation-service/serve.py');
  });

  it('resolves a bare file name against the config directory, not PATH', () => {
    // A model sitting next to the config is written as a bare name. Treating
    // that as a PATH lookup left it relative, so it resolved against whatever
    // directory Electron happened to start in.
    const resolved = resolvePaths(
      { ...DEFAULT_CONFIG, modelPath: 'b6c96.bin.gz', katagoConfigPath: 'analysis.cfg' },
      '/opt/app',
    );
    expect(resolved.modelPath).toBe('/opt/app/b6c96.bin.gz');
    expect(resolved.katagoConfigPath).toBe('/opt/app/analysis.cfg');
  });

  it('leaves absolute paths and empty strings untouched', () => {
    const resolved = resolvePaths(
      { ...DEFAULT_CONFIG, modelPath: '/abs/model.bin.gz', katagoConfigPath: '' },
      '/opt/app',
    );
    expect(resolved.modelPath).toBe('/abs/model.bin.gz');
    expect(resolved.katagoConfigPath).toBe('');
  });
});

describe('loadConfig', () => {
  it('falls back to defaults when no config file exists', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'katascope-'));
    const status = await loadConfig(dir);
    expect(status.config).toEqual(DEFAULT_CONFIG);
    expect(status.path).toBeUndefined();
    expect(status.problems).toEqual([]);
  });

  it('reads a config file and resolves its paths', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'katascope-'));
    await writeFile(join(dir, 'katascope.config.json'), JSON.stringify({ useFakes: false, modelPath: 'nets/b6.bin.gz' }));
    const status = await loadConfig(dir);
    expect(status.config.useFakes).toBe(false);
    expect(status.config.modelPath).toBe(join(dir, 'nets/b6.bin.gz'));
  });

  it('prefers the local override', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'katascope-'));
    await writeFile(join(dir, 'katascope.config.json'), JSON.stringify({ katagoPath: 'shared' }));
    await writeFile(join(dir, 'katascope.config.local.json'), JSON.stringify({ katagoPath: 'mine' }));
    expect((await loadConfig(dir)).config.katagoPath).toBe('mine');
  });

  it('reports malformed JSON instead of throwing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'katascope-'));
    await writeFile(join(dir, 'katascope.config.json'), '{ not json');
    const status = await loadConfig(dir);
    expect(status.config).toEqual(DEFAULT_CONFIG);
    expect(status.problems[0]?.field).toBe('(root)');
  });
});

describe('createBridge', () => {
  it('builds a fake bridge that probes ready without spawning anything', async () => {
    const bridge = createBridge(DEFAULT_CONFIG);
    expect(bridge.mode).toBe('fake');
    const statuses = await bridge.probe();
    expect(statuses.map((s) => s.ready)).toEqual([true, true]);
    expect(statuses[1]?.detail).toContain('b6c96');
    await bridge.dispose();
  });

  it('builds a live bridge that reports failures rather than throwing', async () => {
    const bridge = createBridge({
      ...DEFAULT_CONFIG,
      useFakes: false,
      katagoPath: '/nonexistent/katago',
      pythonPath: '/nonexistent/python',
      modelPath: '/nonexistent/model.bin.gz',
      katagoConfigPath: '/nonexistent/analysis.cfg',
      sidecarPath: '/nonexistent/sidecar.py',
    });
    expect(bridge.mode).toBe('live');
    const statuses = await bridge.probe();
    expect(statuses.map((s) => s.ready)).toEqual([false, false]);
    expect(statuses[0]?.detail).toMatch(/failed to start/);
    await bridge.dispose();
  });
});
