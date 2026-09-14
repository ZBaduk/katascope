/**
 * Browser window creation and the renderer's security posture.
 *
 * The renderer gets no Node and no direct `ipcRenderer`: context isolation and
 * the sandbox are on, and the preload script is the entire attack surface.
 * Navigation and window-opening are both refused, so a stray link cannot turn
 * the app window into a browser pointed at the internet.
 */

import { BrowserWindow, shell } from 'electron';
import { join } from 'node:path';

export interface WindowOptions {
  /** Dev-server URL when running `npm run dev`; absent for a packaged build. */
  readonly devServerUrl?: string | undefined;
  /** Directory holding the built renderer (`index.html`). */
  readonly rendererDirectory: string;
  /** Directory holding the built preload bundle. */
  readonly preloadDirectory: string;
}

export async function createMainWindow(options: WindowOptions): Promise<BrowserWindow> {
  const window = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#14161a',
    // Avoid the white flash between window creation and the first paint.
    show: false,
    title: 'katascope',
    webPreferences: {
      preload: join(options.preloadDirectory, 'index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
      spellcheck: false,
    },
  });

  window.once('ready-to-show', () => window.show());

  // Anything that is not the app itself opens in the user's real browser.
  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  window.webContents.on('will-navigate', (event, url) => {
    const current = window.webContents.getURL();
    if (url !== current) event.preventDefault();
  });

  if (options.devServerUrl !== undefined) {
    await window.loadURL(options.devServerUrl);
  } else {
    await window.loadFile(join(options.rendererDirectory, 'index.html'));
  }

  return window;
}
