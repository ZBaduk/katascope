/**
 * The only code with a foot in both worlds.
 *
 * Runs with context isolation on and the sandbox enabled, so it has no Node
 * access beyond `electron` itself. It exposes exactly the methods named in the
 * contract -- never `ipcRenderer`, which would let the renderer reach any
 * channel in the app.
 */

import { contextBridge, ipcRenderer } from 'electron';
import { IPC_CHANNELS, IPC_METHODS, KATASCOPE_API_KEY, type KatascopeApi } from '@katascope/core';

/**
 * Every method forwards one structured-cloneable argument and returns a
 * promise. The single cast is what turns the contract's method list into the
 * typed object; `IPC_METHODS` is derived from `KatascopeApi`, so a method
 * missing here is impossible rather than merely unlikely.
 */
const api = Object.fromEntries(
  IPC_METHODS.map((method) => [
    method,
    (argument?: unknown) => ipcRenderer.invoke(IPC_CHANNELS[method], argument),
  ]),
) as unknown as KatascopeApi;

contextBridge.exposeInMainWorld(KATASCOPE_API_KEY, api);
