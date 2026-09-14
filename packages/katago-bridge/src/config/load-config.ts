/**
 * Reads `katascope.config.json` from disk.
 *
 * Parsing and validation live in `@katascope/core`; this module only does the
 * filesystem half, because core must stay free of Node built-ins.
 *
 * Resolution order, first hit wins:
 *   1. `katascope.config.local.json` -- gitignored, for machine-specific paths
 *   2. `katascope.config.json`       -- checked in, sensible defaults
 * A missing file is not an error: the app falls back to `DEFAULT_CONFIG`,
 * which runs entirely on fakes.
 */

import { readFile } from 'node:fs/promises';
import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { DEFAULT_CONFIG, parseConfig, type ConfigProblem, type ConfigStatus, type KatascopeConfig } from '@katascope/core';

export const CONFIG_FILENAMES = ['katascope.config.local.json', 'katascope.config.json'] as const;

/**
 * Loads config from `directory`. Relative paths inside the file are resolved
 * against that directory, so a config is portable between checkouts.
 */
export async function loadConfig(directory: string): Promise<ConfigStatus> {
  for (const filename of CONFIG_FILENAMES) {
    const path = resolve(directory, filename);
    let text: string;
    try {
      text = await readFile(path, 'utf8');
    } catch {
      continue;
    }
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch (error) {
      return {
        config: DEFAULT_CONFIG,
        path,
        problems: [
          { field: '(root)', message: `${filename} is not valid JSON: ${messageOf(error)}; using defaults` },
        ],
      };
    }
    const { config, problems } = parseConfig(json);
    return { config: resolvePaths(config, directory), path, problems };
  }
  return { config: DEFAULT_CONFIG, problems: [] };
}

/**
 * Makes the paths in a config absolute, relative to the config's own directory.
 *
 * Commands and files are treated differently on purpose. A bare `katago` or
 * `python3` means "find it on PATH", so it is left alone. A bare `model.bin.gz`
 * means the file sitting next to the config -- resolving it against PATH would
 * be meaningless, and leaving it relative would resolve it against the
 * process's working directory, which is wherever Electron happened to start.
 */
export function resolvePaths(config: KatascopeConfig, directory: string): KatascopeConfig {
  const command = (value: string): string => {
    if (value === '' || isAbsolute(value)) return value;
    // No separator: a PATH lookup, not a path.
    if (!value.includes('/') && !value.includes('\\')) return value;
    return resolve(directory, value);
  };
  const file = (value: string): string =>
    value === '' || isAbsolute(value) ? value : resolve(directory, value);

  return {
    ...config,
    katagoPath: command(config.katagoPath),
    pythonPath: command(config.pythonPath),
    modelPath: file(config.modelPath),
    checkpointPath: file(config.checkpointPath),
    katagoConfigPath: file(config.katagoConfigPath),
    sidecarPath: file(config.sidecarPath),
  };
}

/**
 * Checks that the files a live config points at actually exist. Only meaningful
 * once `useFakes` is off; returns nothing otherwise.
 */
export async function checkConfigPaths(config: KatascopeConfig): Promise<readonly ConfigProblem[]> {
  if (config.useFakes) return [];
  const fields = ['modelPath', 'checkpointPath', 'katagoConfigPath', 'sidecarPath'] as const;
  const problems: ConfigProblem[] = [];
  await Promise.all(
    fields.map(async (field) => {
      const path = config[field];
      if (path === '') return;
      try {
        await access(path, constants.R_OK);
      } catch {
        problems.push({ field, message: `no readable file at ${path}` });
      }
    }),
  );
  return problems;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
