#!/usr/bin/env node
/**
 * A stand-in for KataGo or the Python sidecar, driven by a recorded transcript.
 *
 * The bridge's whole job is talking to a child process over newline-delimited
 * JSON. Mocking `child_process` would test the mock; this spawns a real process
 * with real pipes and a real exit code, and only the far end is scripted.
 *
 * Plain `.mjs` on purpose: it is spawned directly by `node`, so it must run with
 * no build step. Tests drive it through `scripted-process.ts`, which is typed.
 *
 * Transcript shape (see `fixtures/transcripts/*.json`):
 *
 *   {
 *     "stderrOnStart": ["KataGo v1.15.3"],     // startup chatter
 *     "stdoutOnStart": ["not json at all"],    // banner noise on stdout
 *     "steps": [ <step>, ... ],                // consumed one per request
 *     "onExhausted": "ignore" | "error"        // default "error"
 *   }
 *
 * Each step is applied to the next request read from stdin:
 *
 *   { "expect": {...} }        assert the request contains these keys/values
 *   { "delayMs": 50 }          stall before replying (drives timeout tests)
 *   { "stderr": ["..."] }      emit stderr lines
 *   { "rawStdout": ["..."] }   emit non-JSON stdout the reader must skip
 *   { "noReply": true }        read the request and say nothing
 *   { "exit": { "code": 3 } }  die instead of replying (drives crash tests)
 *   { "reply": {...} }         reply; `id` is echoed from the request unless set
 *   { "binaryFloat32": [..] }  append a float32 little-endian payload after the
 *                              reply line and set `binaryBytes` accordingly
 *   { "binaryBytes": 12 }      claim a payload length without sending one, for
 *                              testing a truncated stream
 */

import { createInterface } from 'node:readline';
import { readFileSync, writeFileSync } from 'node:fs';

/** Runs the transcript. Resolves only when stdin closes or a step exits. */
export function run(transcriptPath, argv, argvFile) {
  const transcript = JSON.parse(readFileSync(transcriptPath, 'utf8'));

  // Record the real command line so tests can assert how the engine spawned us.
  if (argvFile !== undefined) {
    writeFileSync(argvFile, JSON.stringify(argv), 'utf8');
  }

  for (const line of transcript.stderrOnStart ?? []) process.stderr.write(`${line}\n`);
  for (const line of transcript.stdoutOnStart ?? []) process.stdout.write(`${line}\n`);

  const steps = [...(transcript.steps ?? [])];
  const onExhausted = transcript.onExhausted ?? 'error';

  // Requests are handled strictly in order; a slow step must not let the next
  // request overtake it, or a transcript would stop being deterministic.
  let chain = Promise.resolve();
  const reader = createInterface({ input: process.stdin });

  reader.on('line', (line) => {
    if (line.trim() === '') return;
    chain = chain.then(() => handle(line, steps, onExhausted));
  });

  return new Promise((resolve) => reader.on('close', () => chain.then(resolve)));
}

async function handle(line, steps, onExhausted) {
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    fail(`scripted process received non-JSON input: ${line}`);
    return;
  }

  const step = steps.shift();
  if (step === undefined) {
    if (onExhausted === 'ignore') return;
    fail(`scripted process ran out of steps at request ${JSON.stringify(request)}`);
    return;
  }

  if (step.expect !== undefined) {
    for (const [key, expected] of Object.entries(step.expect)) {
      const actual = JSON.stringify(request[key]);
      if (actual !== JSON.stringify(expected)) {
        fail(`expected ${key}=${JSON.stringify(expected)} but got ${actual}`);
        return;
      }
    }
  }

  if (step.delayMs !== undefined) {
    await new Promise((resolve) => setTimeout(resolve, step.delayMs));
  }
  for (const text of step.stderr ?? []) process.stderr.write(`${text}\n`);
  for (const text of step.rawStdout ?? []) process.stdout.write(`${text}\n`);

  if (step.exit !== undefined) {
    process.stderr.write(`scripted process exiting with code ${step.exit.code}\n`);
    process.exit(step.exit.code);
  }
  if (step.noReply === true) return;
  if (step.reply === undefined) return;

  const reply = { ...step.reply };
  if (reply.id === undefined && request.id !== undefined) reply.id = request.id;

  // A frame response is a JSON line followed immediately by raw bytes.
  let payload = null;
  if (Array.isArray(step.binaryFloat32)) {
    payload = Buffer.alloc(step.binaryFloat32.length * 4);
    step.binaryFloat32.forEach((value, i) => payload.writeFloatLE(value, i * 4));
    reply.binaryBytes = payload.length;
  }

  // Header and payload go to the raw stream together, so nothing can reorder
  // the newline and the bytes that must follow it.
  process.stdout.write(`${JSON.stringify(reply)}\n`);
  if (payload !== null) process.stdout.write(payload);
}

/** Transcript violations are the test's bug, so they are loud and fatal. */
function fail(message) {
  process.stderr.write(`SCRIPTED PROCESS ERROR: ${message}\n`);
  process.exit(97);
}

// CLI form: `node scripted-process.mjs <transcript.json> [argvFile]`.
if (process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].split('/').pop() ?? '')) {
  const [, , transcriptPath, argvFile] = process.argv;
  if (transcriptPath !== undefined) {
    await run(transcriptPath, process.argv.slice(2), argvFile);
  }
}
