/**
 * Bundles the Electron main process and preload script with esbuild.
 *
 * Both are emitted as CommonJS: a sandboxed preload must be CJS, and keeping
 * main the same avoids two module systems in one app. `electron` and Node
 * built-ins stay external; everything else -- including `@katascope/core` and
 * `@katascope/katago-bridge` -- is bundled in, so a packaged app carries no
 * workspace symlinks.
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));

/** @param {{ dev?: boolean }} options */
export function createBuildOptions({ dev = false } = {}) {
  /** @type {import('esbuild').BuildOptions} */
  return {
    entryPoints: {
      'main/index': resolve(here, 'src/main/index.ts'),
      'preload/index': resolve(here, 'src/preload/index.ts'),
    },
    outdir: resolve(here, 'dist'),
    outExtension: { '.js': '.cjs' },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    // Electron supplies these at runtime; bundling them would break the app.
    external: ['electron'],
    sourcemap: dev ? 'inline' : false,
    minify: !dev,
    logLevel: 'info',
    define: { 'process.env.NODE_ENV': JSON.stringify(dev ? 'development' : 'production') },
  };
}

export async function build(options) {
  await esbuild.build(createBuildOptions(options));
}

// Direct invocation (`npm run build`) does a one-shot production build.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await build({ dev: false });
}
