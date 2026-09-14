#!/usr/bin/env node
/**
 * `npm run dev` -- the whole app, hot.
 *
 * Three things run at once:
 *
 *   1. `tsc --watch` over `core` and `katago-bridge`, so a change to a shared
 *      type reaches both the renderer and the main process.
 *   2. `ng serve`, which owns renderer hot reload. Electron points at its URL,
 *      so a component edit repaints without restarting the process.
 *   3. esbuild watching main and preload. Those cannot hot-reload -- the main
 *      process is the app -- so a rebuild restarts Electron instead. The window
 *      reopens on the same dev-server URL, so renderer state is the only thing
 *      lost, and only when main-process code changed.
 *
 * Electron is not started until `ng serve` answers, otherwise the first window
 * loads a connection error.
 */

import { spawn } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';
import electronBinary from 'electron';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEV_SERVER_URL = process.env.KATASCOPE_DEV_SERVER_URL ?? 'http://127.0.0.1:4200';

/** Child processes to tear down on exit. */
const children = new Set();
let electronProcess = null;
let shuttingDown = false;
let restartQueued = false;

function run(command, args, { name, ...options }) {
  const child = spawn(command, args, {
    cwd: root,
    stdio: ['ignore', 'inherit', 'inherit'],
    ...options,
  });
  children.add(child);
  child.on('exit', (code, signal) => {
    children.delete(child);
    if (shuttingDown) return;
    if (code !== 0 && signal === null) {
      console.error(`[dev] ${name} exited with code ${code}`);
      shutdown(code ?? 1);
    }
  });
  return child;
}

/** Builds the libraries once, so the first `ng serve` resolves imports. */
async function buildLibraries() {
  console.log('[dev] building libraries...');
  await new Promise((resolveBuild, rejectBuild) => {
    const child = spawn('npm', ['run', 'build:libs'], { cwd: root, stdio: 'inherit' });
    child.on('exit', (code) =>
      code === 0 ? resolveBuild() : rejectBuild(new Error(`library build failed with code ${code}`)),
    );
  });
}

function watchLibraries() {
  for (const workspace of ['@katascope/core', '@katascope/katago-bridge']) {
    run('npm', ['run', 'watch', '--workspace', workspace], { name: `tsc ${workspace}` });
  }
}

/**
 * Drops Vite's pre-bundled copy of the workspace libraries.
 *
 * `ng serve` pre-bundles `@katascope/*` out of their `dist/`, and keys that
 * cache on manifests -- `package.json`, the lockfile -- not on the contents of
 * `dist/`. But `tsc --watch` rewrites `dist/` continuously, so adding an export
 * to `core` leaves Vite serving a pre-bundle that predates it. The renderer
 * then dies on `does not provide an export named ...` as it loads a lazy route,
 * which surfaces as tabs that render nothing at all, and only in dev -- the
 * built app never goes through the optimiser.
 *
 * Re-optimising costs about a second. A stale cache costs an afternoon.
 */
async function clearRendererDepCache() {
  await rm(resolve(root, 'packages/ui/.angular/cache'), { recursive: true, force: true });
}

function serveRenderer() {
  run('npm', ['run', 'serve', '--workspace', '@katascope/ui'], { name: 'ng serve' });
}

/** Polls the dev server until it answers, so Electron never loads a dead URL. */
async function waitForDevServer(timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  process.stdout.write('[dev] waiting for the dev server');
  while (Date.now() < deadline) {
    try {
      const response = await fetch(DEV_SERVER_URL, { method: 'HEAD' });
      if (response.ok || response.status === 404) {
        process.stdout.write(` -> ${DEV_SERVER_URL}\n`);
        return;
      }
    } catch {
      // Not up yet.
    }
    process.stdout.write('.');
    await delay(500);
  }
  throw new Error(`dev server did not respond at ${DEV_SERVER_URL} within ${timeoutMs}ms`);
}

function startElectron() {
  electronProcess = spawn(electronBinary, ['.'], {
    cwd: resolve(root, 'apps/desktop'),
    stdio: ['ignore', 'inherit', 'inherit'],
    env: {
      ...process.env,
      KATASCOPE_DEV_SERVER_URL: DEV_SERVER_URL,
      KATASCOPE_CONFIG_DIR: process.env.KATASCOPE_CONFIG_DIR ?? root,
      ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
    },
  });
  const started = electronProcess;
  started.on('exit', () => {
    if (electronProcess === started) electronProcess = null;
    // The user closing the window ends the dev session.
    if (!shuttingDown && !restartQueued) shutdown(0);
  });
}

async function restartElectron() {
  if (electronProcess === null) {
    startElectron();
    return;
  }
  restartQueued = true;
  const dying = electronProcess;
  await new Promise((resolveExit) => {
    dying.once('exit', resolveExit);
    dying.kill('SIGTERM');
  });
  restartQueued = false;
  if (shuttingDown) return;
  console.log('[dev] main process changed, restarting Electron');
  startElectron();
}

/** Watches main and preload, restarting Electron after each successful rebuild. */
async function watchDesktop() {
  const { createBuildOptions } = await import('../apps/desktop/build.mjs');
  let first = true;
  const context = await esbuild.context({
    ...createBuildOptions({ dev: true }),
    logLevel: 'silent',
    plugins: [
      {
        name: 'katascope-restart',
        setup(build) {
          build.onEnd(async (result) => {
            if (result.errors.length > 0) {
              for (const error of result.errors) {
                console.error(`[dev] main build error: ${error.text}`);
              }
              return;
            }
            if (first) {
              first = false;
              return;
            }
            await restartElectron();
          });
        },
      },
    ],
  });
  await context.watch();
  return context;
}

function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  electronProcess?.kill('SIGTERM');
  for (const child of children) child.kill('SIGTERM');
  // Give children a moment to exit cleanly before the process goes away.
  setTimeout(() => process.exit(code), 300).unref();
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => shutdown(0));
}

try {
  await buildLibraries();
  await clearRendererDepCache();
  watchLibraries();
  serveRenderer();
  await watchDesktop();
  await waitForDevServer();
  startElectron();
  console.log('[dev] ready. Edit the renderer for hot reload; main/preload edits restart Electron.');
} catch (error) {
  console.error(`[dev] ${error instanceof Error ? error.message : String(error)}`);
  shutdown(1);
}
