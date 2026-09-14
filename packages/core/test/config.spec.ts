import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, parseConfig, validateConfig } from '../src/index.js';

describe('parseConfig', () => {
  it('returns defaults for an empty object', () => {
    const { config, problems } = parseConfig({});
    expect(config).toEqual(DEFAULT_CONFIG);
    expect(problems).toEqual([]);
  });

  it('merges provided values over the defaults', () => {
    const { config } = parseConfig({ katagoPath: '/usr/local/bin/katago', useFakes: false, modelPath: '/m.bin.gz' });
    expect(config.katagoPath).toBe('/usr/local/bin/katago');
    expect(config.useFakes).toBe(false);
    expect(config.pythonPath).toBe(DEFAULT_CONFIG.pythonPath);
  });

  it('ignores unknown keys', () => {
    const { config, problems } = parseConfig({ nonsense: 1 });
    expect(config).toEqual(DEFAULT_CONFIG);
    expect(problems).toEqual([]);
  });

  it('reports wrongly typed values and falls back', () => {
    const { config, problems } = parseConfig({ katagoPath: 42, useFakes: 'yes' });
    expect(config.katagoPath).toBe(DEFAULT_CONFIG.katagoPath);
    expect(config.useFakes).toBe(true);
    expect(problems.map((p) => p.field)).toEqual(['katagoPath', 'useFakes']);
  });

  it('reports a non-object root', () => {
    for (const input of [null, [], 'string', 3]) {
      const { config, problems } = parseConfig(input);
      expect(config).toEqual(DEFAULT_CONFIG);
      expect(problems[0]?.field).toBe('(root)');
    }
  });
});

describe('validateConfig', () => {
  it('requires no paths while fakes are in use', () => {
    expect(validateConfig(DEFAULT_CONFIG)).toEqual([]);
  });

  it('requires every path once fakes are off', () => {
    const problems = validateConfig({ ...DEFAULT_CONFIG, useFakes: false });
    expect(problems.map((p) => p.field)).toEqual([
      'modelPath',
      'checkpointPath',
      'katagoConfigPath',
    ]);
  });
});
