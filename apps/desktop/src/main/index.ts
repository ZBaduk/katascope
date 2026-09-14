/**
 * Electron main process: the app's only trusted context.
 *
 * Responsibilities, in order: load config, build the bridge from it, expose the
 * bridge over the IPC contract, open a window. Nothing here knows what a
 * residual block is -- it wires `@katascope/katago-bridge` to the renderer and
 * stays out of the way.
 *
 * Startup is resilient by design. A missing config file, an unreachable KataGo
 * binary, or a sidecar that will not start must all still produce a window;
 * the failure shows up in Diagnostics instead of as a silent non-launch.
 */

import { app, BrowserWindow } from 'electron';
import { join, resolve } from 'node:path';
import { createBridge, loadConfig, type Bridge } from '@katascope/katago-bridge';
import { DEFAULT_CONFIG, type ConfigStatus } from '@katascope/core';
import { configDirectory, repoRoot } from './config-location.js';
import { registerIpcHandlers } from './ipc.js';
import { createMainWindow } from './window.js';

/** Set by the dev script; absent in a packaged build. */
const devServerUrl = process.env['KATASCOPE_DEV_SERVER_URL'];

let bridge: Bridge | undefined;
let unregisterIpc: (() => void) | undefined;

if (!app.requestSingleInstanceLock()) {
  // A second launch just focuses the window the first one owns.
  app.quit();
} else {
  app.on('second-instance', () => {
    const [existing] = BrowserWindow.getAllWindows();
    if (existing === undefined) return;
    if (existing.isMinimized()) existing.restore();
    existing.focus();
  });

  app.whenReady().then(main).catch((error: unknown) => {
    console.error('katascope failed to start', error);
    app.exit(1);
  });
}

async function main(): Promise<void> {
  const configStatus = await loadConfigSafely();
  logConfig(configStatus);

  bridge = createBridge(configStatus.config, {
    onLog: (source, line) => console.log(`[${source}] ${line}`),
  });
  unregisterIpc = registerIpcHandlers({ bridge, configStatus });

  await openWindow();

  // macOS keeps the app running with no windows; reopen on dock activation.
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) void openWindow();
  });
}

async function openWindow(): Promise<void> {
  await createMainWindow({
    devServerUrl,
    preloadDirectory: join(__dirname, '../preload'),
    rendererDirectory: rendererDirectory(),
  });
}

/** A broken config must not stop the app; it degrades to defaults and reports why. */
async function loadConfigSafely(): Promise<ConfigStatus> {
  const directory = configDirectory();
  try {
    return await loadConfig(directory);
  } catch (error) {
    return {
      config: DEFAULT_CONFIG,
      problems: [
        {
          field: '(root)',
          message: `could not read config from ${directory}: ${
            error instanceof Error ? error.message : String(error)
          }; using defaults`,
        },
      ],
    };
  }
}

function rendererDirectory(): string {
  const override = process.env['KATASCOPE_RENDERER_DIR'];
  if (override !== undefined && override !== '') return resolve(override);
  return app.isPackaged
    ? join(process.resourcesPath, 'renderer')
    : join(repoRoot(), 'packages/ui/dist');
}

function logConfig(status: ConfigStatus): void {
  console.log(
    status.path === undefined
      ? 'katascope: no config file found, using defaults (fakes enabled)'
      : `katascope: config loaded from ${status.path}`,
  );
  for (const problem of status.problems) {
    console.warn(`katascope: config problem in ${problem.field}: ${problem.message}`);
  }
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  unregisterIpc?.();
  // Best-effort: the spawned children are killed with the process regardless.
  void bridge?.dispose();
});
