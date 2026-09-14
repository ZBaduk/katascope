/**
 * Turns a transcript fixture into an executable the bridge can spawn.
 *
 * `KataGoAnalysisEngine` and `SidecarActivationStore` build their own argv, so
 * tests cannot pass a command through them. Instead each test gets a throwaway
 * executable shim -- a real file with a shebang -- and points `katagoPath` or
 * `pythonPath` at it. The engine spawns it exactly as it would spawn the real
 * thing, argv included, which is what makes these tests worth having.
 *
 * POSIX only: the shim relies on a shebang. CI runs Linux and macOS.
 */

import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const RUNNER = join(HERE, 'scripted-process.mjs');
const TRANSCRIPTS = join(HERE, '../../fixtures/transcripts');

export interface ScriptedBinary {
  /** Absolute path to the executable. Use as `katagoPath` or `pythonPath`. */
  readonly path: string;
  /** argv the shim was spawned with, once it has started. Empty before that. */
  receivedArgv(): readonly string[];
  /** Removes the temporary directory. Call from `afterEach`. */
  cleanup(): void;
}

export function transcriptPath(name: string): string {
  return join(TRANSCRIPTS, name.endsWith('.json') ? name : `${name}.json`);
}

/** Creates an executable that replays `transcriptName` when spawned. */
export function scriptedBinary(transcriptName: string): ScriptedBinary {
  const directory = mkdtempSync(join(tmpdir(), 'katascope-scripted-'));
  const argvFile = join(directory, 'argv.json');
  // `.mjs` so Node treats the shim as ESM; the shebang makes it directly
  // executable, which is what `spawn` needs.
  const shim = join(directory, 'shim.mjs');

  writeFileSync(
    shim,
    [
      '#!/usr/bin/env node',
      `import { run } from ${JSON.stringify(pathToFileURL(RUNNER).href)};`,
      `await run(${JSON.stringify(transcriptPath(transcriptName))}, process.argv.slice(2), ${JSON.stringify(argvFile)});`,
      '',
    ].join('\n'),
    'utf8',
  );
  chmodSync(shim, 0o755);

  return {
    path: shim,
    receivedArgv: () => {
      try {
        return JSON.parse(readFileSync(argvFile, 'utf8')) as readonly string[];
      } catch {
        return [];
      }
    },
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  };
}

/** Polls until `predicate` holds, so tests need not guess at process timing. */
export async function waitFor(
  predicate: () => boolean,
  { timeoutMs = 5_000, intervalMs = 20 } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`condition not met within ${timeoutMs}ms`);
}
