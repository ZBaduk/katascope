/**
 * Implements the renderer-facing contract on top of the bridge.
 *
 * Handlers are written as a `KatascopeApi` object so the compiler checks every
 * signature against the shared contract, then registered by iterating the
 * contract's own method list -- a method can neither be forgotten here nor
 * registered on a channel that does not exist.
 *
 * Arguments arriving from the renderer are untrusted and validated before use,
 * even though the renderer is our own code: the IPC boundary is the last place
 * to catch a malformed request before it reaches a spawned process.
 */

import { app, ipcMain } from 'electron';
import type { Bridge } from '@katascope/katago-bridge';
import {
  IPC_CHANNELS,
  IPC_METHODS,
  type ActivationAvailability,
  type ActivationFrame,
  type ActivationKey,
  type BridgeStatus,
  type ConfigStatus,
  type KatascopeApi,
} from '@katascope/core';

export interface IpcContext {
  readonly bridge: Bridge;
  /** Config as loaded at startup, including any problems found in it. */
  readonly configStatus: ConfigStatus;
}

/** Registers every contract channel. Returns a function that unregisters them. */
export function registerIpcHandlers(context: IpcContext): () => void {
  const handlers: KatascopeApi = {
    getConfig: async (): Promise<ConfigStatus> => context.configStatus,

    getStatus: async (): Promise<BridgeStatus> => ({
      appVersion: app.getVersion(),
      electronVersion: process.versions.electron ?? 'unknown',
      nodeVersion: process.versions.node,
      chromeVersion: process.versions.chrome ?? 'unknown',
      subsystems: await context.bridge.probe(),
    }),

    describeActivations: async (): Promise<ActivationAvailability> =>
      context.bridge.activationStore.describe(),

    getActivationFrame: async (key: ActivationKey): Promise<ActivationFrame> =>
      context.bridge.activationStore.frame(parseActivationKey(key)),
  };

  for (const method of IPC_METHODS) {
    // The contract guarantees each method takes at most one argument; the cast
    // is the one place that erases the per-method signature to register it.
    const handler = handlers[method] as (argument: unknown) => Promise<unknown>;
    ipcMain.handle(IPC_CHANNELS[method], async (_event, argument: unknown) => handler(argument));
  }

  return () => {
    for (const method of IPC_METHODS) {
      ipcMain.removeHandler(IPC_CHANNELS[method]);
    }
  };
}

/** Validates an activation key crossing the IPC boundary. */
function parseActivationKey(value: unknown): ActivationKey {
  if (value === null || typeof value !== 'object') {
    throw new TypeError('activation key must be an object');
  }
  const raw = value as Record<string, unknown>;
  return {
    moveNumber: requireNonNegativeInt(raw['moveNumber'], 'moveNumber'),
    block: requireNonNegativeInt(raw['block'], 'block'),
  };
}

function requireNonNegativeInt(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new TypeError(`${field} must be a non-negative integer, got ${JSON.stringify(value)}`);
  }
  return value;
}
