/**
 * The typed surface the renderer sees on `window.katascope`.
 *
 * This file is the single source of truth shared by three sides: the Electron
 * main process registers handlers for it, the preload script forwards to those
 * handlers, and the Angular app consumes it. It lives in `@katascope/core`
 * because it is pure types over domain objects -- importing `electron` here
 * would drag Node into the renderer's dependency graph.
 *
 * Everything crossing this boundary must survive the structured clone
 * algorithm. Typed arrays do; class instances, functions and `Map`s do not.
 */

import type { ActivationAvailability, ActivationFrame, ActivationKey } from '../domain/activation.js';
import type { ConfigProblem, KatascopeConfig } from '../config/config.js';

/** Why a subsystem is or is not available, for the Diagnostics tab. */
export type BridgeMode = 'fake' | 'live';

export interface SubsystemStatus {
  readonly name: 'analysis-engine' | 'activation-store';
  readonly mode: BridgeMode;
  readonly ready: boolean;
  /** Human-readable detail: a version string when ready, an error when not. */
  readonly detail: string;
}

export interface BridgeStatus {
  readonly appVersion: string;
  readonly electronVersion: string;
  readonly nodeVersion: string;
  readonly chromeVersion: string;
  readonly subsystems: readonly SubsystemStatus[];
}

export interface ConfigStatus {
  readonly config: KatascopeConfig;
  /** Absolute path the config was read from, or `undefined` if defaults were used. */
  readonly path?: string;
  readonly problems: readonly ConfigProblem[];
}

/**
 * Every method is async and takes at most one structured-cloneable argument.
 * Rejections arrive in the renderer as `Error` with the main-process message.
 */
export interface KatascopeApi {
  /** Config as loaded at startup, plus any problems found in it. */
  getConfig(): Promise<ConfigStatus>;
  /** Runtime versions and per-subsystem readiness. */
  getStatus(): Promise<BridgeStatus>;
  /** Network shape and the range of addressable frames. */
  describeActivations(): Promise<ActivationAvailability>;
  /** All channels of one (move, block) pair. */
  getActivationFrame(key: ActivationKey): Promise<ActivationFrame>;
}

/** Property name the preload script exposes the API under. */
export const KATASCOPE_API_KEY = 'katascope';

/**
 * IPC channel names, one per API method. Keyed by method name so a new method
 * without a channel -- or a channel without a method -- fails to compile.
 */
export const IPC_CHANNELS = {
  getConfig: 'katascope:getConfig',
  getStatus: 'katascope:getStatus',
  describeActivations: 'katascope:describeActivations',
  getActivationFrame: 'katascope:getActivationFrame',
} as const satisfies Record<keyof KatascopeApi, string>;

export type IpcChannel = (typeof IPC_CHANNELS)[keyof typeof IPC_CHANNELS];

/** Method names, for iterating the contract in preload and main. */
export const IPC_METHODS = Object.keys(IPC_CHANNELS) as readonly (keyof KatascopeApi)[];
