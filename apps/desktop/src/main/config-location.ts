/**
 * Where `katascope.config.json` is read from.
 *
 * Development reads the repo root, so an edit to the checked-in config is live
 * on the next launch. A packaged app reads `userData`, because the app bundle
 * is read-only and the user needs somewhere to point katascope at their own
 * KataGo install.
 *
 * `KATASCOPE_CONFIG_DIR` overrides both, which is how the dev script and any
 * future integration test pin a fixture directory.
 */

import { app } from 'electron';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export function configDirectory(): string {
  const override = process.env['KATASCOPE_CONFIG_DIR'];
  if (override !== undefined && override !== '') return resolve(override);
  return app.isPackaged ? app.getPath('userData') : repoRoot();
}

/**
 * The monorepo root, four levels above the bundled main script
 * (`apps/desktop/dist/main/index.cjs`).
 */
export function repoRoot(): string {
  return resolve(dirname(currentFile()), '../../../..');
}

/** Works whether the bundle ends up as CJS (`__dirname`) or ESM. */
function currentFile(): string {
  return typeof __filename === 'string' ? __filename : fileURLToPath(pathToFileURL(process.argv[1] ?? '.'));
}
