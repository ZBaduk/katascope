#!/usr/bin/env node
/**
 * `npm run dump -- game.sgf out.kact`
 *
 * Runs every position of an SGF through the activation service and writes a
 * `.kact` capture.
 *
 * Streams rather than buffering. A 200-move game of a b18c384 net is roughly
 * 2 GB of float32 frames; holding them to call `encodeKact` would need all of
 * it resident. Every frame in a capture is the same size, so `planKact` lays
 * the whole file out from the keys alone, the header goes down first, and each
 * frame is written as it arrives. Ranges are patched into the index afterwards.
 */

import { open, readFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import {
  encodeKactFrameData,
  KACT_INDEX_ENTRY_BYTES,
  kactIndexEntryBytes,
  parseSgf,
  planKact,
  playerToMoveAt,
  positionCount,
  type ActivationKey,
  type KactMetadata,
} from '@katascope/core';
import { loadConfig } from '../config/load-config.js';
import { SidecarActivationStore } from '../activations/sidecar-activation-store.js';

interface Options {
  readonly sgfPath: string;
  readonly outputPath: string;
  readonly configDirectory: string;
  /** Restrict to these blocks. Empty means every block in the network. */
  readonly blocks: readonly number[];
  /** Stop after this many moves. Undefined means the whole game. */
  readonly maxMoves: number | undefined;
  readonly quiet: boolean;
}

const USAGE = `Usage: npm run dump -- <game.sgf> <out.kact> [options]

  --blocks 0,3,7     only these blocks (default: every block)
  --max-moves N      stop after N moves (default: the whole game)
  --config-dir DIR   where to read katascope.config.json (default: repo root)
  --quiet            no progress output
`;

export function parseArgs(argv: readonly string[]): Options {
  const positional: string[] = [];
  let blocks: number[] = [];
  let maxMoves: number | undefined;
  let configDirectory = process.cwd();
  let quiet = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg === '--blocks') {
      blocks = (argv[++i] ?? '')
        .split(',')
        .map((part) => Number.parseInt(part.trim(), 10))
        .filter((n) => Number.isInteger(n));
    } else if (arg === '--max-moves') {
      const value = Number.parseInt(argv[++i] ?? '', 10);
      if (!Number.isInteger(value) || value < 0) throw new Error('--max-moves needs a non-negative integer');
      maxMoves = value;
    } else if (arg === '--config-dir') {
      configDirectory = resolve(argv[++i] ?? '.');
    } else if (arg === '--quiet') {
      quiet = true;
    } else if (arg === '--help' || arg === '-h') {
      throw new Error(USAGE);
    } else if (arg.startsWith('--')) {
      throw new Error(`unknown option ${arg}\n\n${USAGE}`);
    } else {
      positional.push(arg);
    }
  }

  const [sgfPath, outputPath] = positional;
  if (sgfPath === undefined || outputPath === undefined) {
    throw new Error(`expected an SGF and an output path\n\n${USAGE}`);
  }
  return {
    sgfPath: resolve(sgfPath),
    outputPath: resolve(outputPath),
    configDirectory,
    blocks,
    maxMoves,
    quiet,
  };
}

export async function dump(options: Options): Promise<void> {
  const log = options.quiet ? () => {} : (message: string) => console.error(message);

  const { config, path: configPath } = await loadConfig(options.configDirectory);
  if (config.useFakes) {
    // Writing a capture of synthetic data would be worse than refusing: the
    // file would look exactly like a real one.
    throw new Error(
      'useFakes is true, so there is no model to dump. Set it to false in ' +
        `${configPath ?? 'katascope.config.json'} and point checkpointPath at a .ckpt.`,
    );
  }
  if (config.checkpointPath === '') {
    throw new Error('checkpointPath is not set; the activation service needs a KataGo .ckpt');
  }

  const game = parseSgf(await readFile(options.sgfPath, 'utf8'));
  log(
    `${basename(options.sgfPath)}: ${game.moves.length} moves, ` +
      `${game.size.width}x${game.size.height}, komi ${game.info.komi}, ` +
      `${game.setup.length} setup stones, ${playerToMoveAt(game, 0)} to play`,
  );

  const store = new SidecarActivationStore({
    pythonPath: config.pythonPath,
    sidecarPath: config.sidecarPath,
    modelPath: config.checkpointPath,
    onLog: (line) => log(`  [service] ${line}`),
  });
  store.setGame(game);

  try {
    const { spec } = await store.describe();
    const blocks = options.blocks.length > 0 ? options.blocks : [...Array(spec.blocks).keys()];
    for (const block of blocks) {
      if (block < 0 || block >= spec.blocks) {
        throw new Error(`block ${block} outside 0..${spec.blocks - 1} for ${spec.name}`);
      }
    }

    const moveCount = Math.min(positionCount(game), (options.maxMoves ?? Infinity) + 1);
    const keys: ActivationKey[] = [];
    for (let moveNumber = 0; moveNumber < moveCount; moveNumber++) {
      for (const block of blocks) keys.push({ moveNumber, block });
    }

    const metadata: KactMetadata = {
      networkName: spec.name,
      blocks: spec.blocks,
      channels: spec.channels,
      boardSize: spec.boardSize,
      source: basename(options.sgfPath),
      createdAt: new Date().toISOString(),
    };
    const plan = planKact(metadata, keys);
    log(
      `${spec.name}: ${moveCount} positions x ${blocks.length} blocks = ${keys.length} frames, ` +
        `${(plan.totalBytes / 1024 / 1024).toFixed(1)} MiB`,
    );

    const handle = await open(options.outputPath, 'w');
    try {
      await handle.write(plan.header, 0, plan.header.length, 0);

      for (const [i, key] of keys.entries()) {
        const frame = await store.frame(key);
        const payload = encodeKactFrameData(frame);
        const entry = plan.entries[i];
        if (entry === undefined) throw new Error(`missing plan entry ${i}`);
        if (payload.length !== entry.byteLength) {
          throw new Error(
            `frame (${key.moveNumber}, ${key.block}) encoded to ${payload.length} bytes, ` +
              `plan reserved ${entry.byteLength}`,
          );
        }
        await handle.write(payload, 0, payload.length, entry.byteOffset);

        // The real range is only known once the frame exists, so patch it in.
        const patched = kactIndexEntryBytes({ ...entry, min: frame.range.min, max: frame.range.max });
        await handle.write(patched, 0, patched.length, plan.indexOffset + i * KACT_INDEX_ENTRY_BYTES);

        if (!options.quiet && (i % 25 === 0 || i === keys.length - 1)) {
          const percent = (((i + 1) / keys.length) * 100).toFixed(0);
          log(`  ${i + 1}/${keys.length} frames (${percent}%)`);
        }
      }
    } finally {
      await handle.close();
    }
    log(`wrote ${options.outputPath}`);
  } finally {
    await store.dispose();
  }
}

async function main(): Promise<void> {
  try {
    await dump(parseArgs(process.argv.slice(2)));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

// Run only when invoked directly, so the functions above stay testable.
if (process.argv[1] !== undefined && process.argv[1].endsWith('dump.js')) {
  await main();
}
