/**
 * Launches the built Electron app for a test.
 *
 * Deliberately runs the **built** app, not a dev server: this is the only test
 * in the repo that exercises main, preload, IPC and the renderer together, so it
 * should exercise the thing that ships.
 */

import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { dirname, join, resolve } from 'node:path';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import electronBinary from 'electron';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const DESKTOP_DIR = join(REPO_ROOT, 'apps/desktop');
export const RENDERER_DIR = join(REPO_ROOT, 'packages/ui/dist');
export const MAIN_BUNDLE = join(DESKTOP_DIR, 'dist/main/index.cjs');

/** SGF fixtures live with the parser that owns them; e2e borrows them. */
export const SGF_FIXTURES = join(REPO_ROOT, 'packages/core/fixtures/sgf');
export const KACT_FIXTURES = join(REPO_ROOT, 'packages/core/fixtures/kact');

/**
 * The suite's own config directory.
 *
 * Not the repo root: `loadConfig` prefers `katascope.config.local.json`, so a
 * developer with a real KataGo configured would run a different smoke test from
 * CI -- and did, until this existed. The fixture config pins `useFakes: true`.
 */
export const CONFIG_DIR = join(REPO_ROOT, 'e2e/fixtures/config');

export interface LaunchedApp {
  readonly app: ElectronApplication;
  readonly page: Page;
  /**
   * Makes the next "Open SGF…" return `path` without a dialog.
   *
   * Playwright cannot drive a native file dialog, so the dialog is replaced in
   * the main process instead. Everything after `showOpenDialog` -- reading the
   * file, parsing it, handing it to the engine and the activation service -- is
   * the real code path.
   */
  stubOpenDialog(path: string): Promise<void>;
  /** Makes the next "Open SGF…" behave as though the user cancelled. */
  stubCancelledDialog(): Promise<void>;
  close(): Promise<void>;
}

export async function launchApp(): Promise<LaunchedApp> {
  assertBuilt();

  // Its own userData directory per launch, for two reasons: the app takes a
  // single-instance lock keyed on that path, so a developer's running copy
  // would otherwise make the whole suite fail at launch; and a test run has no
  // business writing to the real app's state.
  const userDataDir = mkdtempSync(join(tmpdir(), 'katascope-e2e-'));

  const app = await electron.launch({
    executablePath: electronBinary as unknown as string,
    args: [DESKTOP_DIR, `--user-data-dir=${userDataDir}`],
    env: {
      ...process.env,
      KATASCOPE_CONFIG_DIR: CONFIG_DIR,
      KATASCOPE_RENDERER_DIR: RENDERER_DIR,
      ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
    },
  });

  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  return {
    app,
    page,
    stubOpenDialog: async (path: string) => {
      await app.evaluate(({ dialog }, filePath) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filePath] });
      }, path);
    },
    stubCancelledDialog: async () => {
      await app.evaluate(({ dialog }) => {
        dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] });
      });
    },
    close: async () => {
      await app.close();
      rmSync(userDataDir, { recursive: true, force: true });
    },
  };
}

function assertBuilt(): void {
  const missing = [MAIN_BUNDLE, join(RENDERER_DIR, 'index.html')].filter((p) => !existsSync(p));
  if (missing.length > 0) {
    throw new Error(
      `the app is not built -- missing:\n  ${missing.join('\n  ')}\n` +
        'Run `npm run test:e2e` from the repo root, which builds first.',
    );
  }
}
