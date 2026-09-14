/**
 * Detects whether a real KataGo is configured on this machine.
 *
 * Integration tests tagged `@katago` need a binary, a model and an analysis
 * config. Almost nowhere has all three -- not CI, not a fresh clone -- so the
 * tests **skip**, loudly but harmlessly. A skipped integration test is
 * information; a failing one on a machine that was never going to have a GPU is
 * noise that teaches people to ignore red.
 *
 * Configuration comes from the same `katascope.config.json` the app uses, so
 * pointing the app at KataGo also enables these tests. `useFakes` is ignored:
 * it says what the app should do, not what is installed.
 */

import { accessSync, constants, readFileSync, statSync } from 'node:fs';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseConfig, type KatascopeConfig } from '@katascope/core';
import { resolvePaths } from '../../src/index.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

export interface KatagoEnvironment {
  readonly available: boolean;
  /** Why the tests are skipping, for the console. */
  readonly reason: string;
  readonly config: KatascopeConfig;
}

function configDirectory(): string {
  const override = process.env['KATASCOPE_CONFIG_DIR'];
  return override !== undefined && override !== '' ? resolve(override) : REPO_ROOT;
}

function loadConfigSync(directory: string): KatascopeConfig {
  for (const filename of ['katascope.config.local.json', 'katascope.config.json']) {
    try {
      const raw = JSON.parse(readFileSync(join(directory, filename), 'utf8')) as unknown;
      return resolvePaths(parseConfig(raw).config, directory);
    } catch {
      continue;
    }
  }
  return resolvePaths(parseConfig({}).config, directory);
}

/** Resolves a command to an executable file, searching PATH for bare names. */
function findExecutable(command: string): string | undefined {
  if (command === '') return undefined;
  const candidates = isAbsolute(command) || command.includes('/')
    ? [command]
    : (process.env['PATH'] ?? '').split(delimiter).filter(Boolean).map((dir) => join(dir, command));
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK);
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      continue;
    }
  }
  return undefined;
}

function isReadableFile(path: string): boolean {
  if (path === '') return false;
  try {
    accessSync(path, constants.R_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function detect(): KatagoEnvironment {
  const config = loadConfigSync(configDirectory());
  const binary = findExecutable(config.katagoPath);
  const missing: string[] = [];
  if (binary === undefined) missing.push(`katagoPath (${config.katagoPath || 'unset'})`);
  if (!isReadableFile(config.modelPath)) missing.push(`modelPath (${config.modelPath || 'unset'})`);
  if (!isReadableFile(config.katagoConfigPath)) {
    missing.push(`katagoConfigPath (${config.katagoConfigPath || 'unset'})`);
  }

  return missing.length === 0
    ? { available: true, reason: `using ${binary ?? config.katagoPath}`, config }
    : { available: false, reason: `not configured: ${missing.join(', ')}`, config };
}

export const KATAGO: KatagoEnvironment = detect();

/**
 * Suite names must start with `@katago` so `vitest -t @katago` selects them and
 * CI can exclude them by filter. Use as:
 *
 *   describe.skipIf(!KATAGO.available)('@katago something live', () => { ... })
 */
export const KATAGO_TAG = '@katago';
