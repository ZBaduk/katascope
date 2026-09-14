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
import type { Attribution, AttributionRequest, ReaderWeights } from '../domain/attribution.js';
import type { HeadWeights } from '../heads/head-weights.js';
import type { ConfigProblem, KatascopeConfig } from '../config/config.js';
import type { GameRecord } from '../domain/game-record.js';
import type { NetworkSpec } from '../domain/network-spec.js';

/**
 * Where a subsystem's data comes from.
 *
 * `capture` is a third state, not a flavour of `live`: the numbers are real but
 * they were computed earlier, by a model that may no longer be configured, and
 * the app cannot ask it anything new.
 */
export type BridgeMode = 'fake' | 'live' | 'capture';

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
 * A game the user opened, parsed by the main process.
 *
 * Parsed once, in main, rather than shipping the SGF text for the renderer to
 * parse again: main has to parse it anyway to drive the analysis engine and the
 * activation service, and two parses are two chances to disagree about what the
 * file says. `GameRecord` is plain data, so it survives structured clone.
 */
export interface LoadedGame {
  /** Absolute path the file came from, for the window title and diagnostics. */
  readonly path: string;
  readonly game: GameRecord;
}

/**
 * A `.kact` capture the user opened.
 *
 * The capture carries the SGF it was taken from, so opening one loads the game
 * too -- a capture without its game is a pile of numbers with no positions
 * attached. `game` is absent only for captures written before the format
 * embedded it.
 */
export interface LoadedCapture {
  readonly path: string;
  readonly networkName: string;
  readonly spec: NetworkSpec;
  /** Move numbers the capture holds, ascending. Not necessarily contiguous. */
  readonly moveNumbers: readonly number[];
  /** Blocks the capture holds, ascending. A capture may hold a subset. */
  readonly blockNumbers: readonly number[];
  readonly game?: GameRecord;
  readonly createdAt?: string;
}

/** What to analyse. The game is whatever `openSgf` last loaded. */
export interface PositionAnalysisRequest {
  readonly moveNumber: number;
  /**
   * Search budget. One visit is a raw-net read, which is what the board
   * overlays want: the numbers then correspond to what the activation service
   * sees for the same position.
   */
  readonly maxVisits?: number;
}

/**
 * Analysis of one position, in a shape the renderer can draw directly.
 *
 * The policy arrives as KataGo's raw vector rather than a pre-selected top-N:
 * choosing which moves to show is presentation, it is pure, and it belongs in a
 * tested function in the renderer rather than in an IPC handler.
 */
export interface PositionAnalysis {
  readonly moveNumber: number;
  /** Winrate for the side to move, 0..1. */
  readonly winrate: number;
  readonly scoreLead: number;
  readonly visits: number;
  /**
   * `width * height + 1` entries, row-major from the top-left, pass last.
   * **Illegal moves are `-1`**, KataGo's convention, preserved so the renderer
   * decides what to do rather than comparing against a fabricated probability.
   */
  readonly policy?: readonly number[];
  /**
   * `width * height` entries in [-1, 1], row-major from the top-left, positive
   * meaning the side to move owns the point.
   */
  readonly ownership?: readonly number[];
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
  /**
   * Shows a file dialog, then loads and parses the chosen SGF. Resolves to
   * `null` when the user cancels -- cancelling is not an error.
   */
  openSgf(): Promise<LoadedGame | null>;
  /**
   * Replaces the game the bridge is working with.
   *
   * The renderer needs this to play: a move the reduced head generates is
   * appended to the record here, and the analysis engine and activation service
   * must agree about what the game now is before a frame for the new position
   * can be asked for. Validated in main -- it is the one method whose argument
   * is a whole domain object rather than a handful of numbers.
   */
  setGame(game: GameRecord): Promise<LoadedGame>;
  /** Analyses a position of the loaded game. Rejects if no game is loaded. */
  analyzePosition(request: PositionAnalysisRequest): Promise<PositionAnalysis>;
  /**
   * Shows a file dialog, then opens a `.kact` capture and makes it the source
   * of activations. Resolves to `null` when the user cancels.
   */
  openKact(): Promise<LoadedCapture | null>;
  /** Goes back to the configured live or fake activation source. */
  closeKact(): Promise<void>;
  /**
   * Static, weight-based channel importance for the loaded network.
   *
   * Rejects when the active source cannot supply it -- a `.kact` capture holds
   * stored planes and has no weights to measure.
   */
  getReaderWeights(): Promise<ReaderWeights>;
  /**
   * Both output heads' weights, so the renderer can re-run them.
   *
   * Rejects when the active source cannot supply them -- a `.kact` capture has
   * stored planes and no weights. About 260 KiB for the reference net, fetched
   * once per network.
   */
  getHeadWeights(): Promise<HeadWeights>;
  /**
   * Gradient-based attribution of one output to every channel.
   *
   * Rejects when the active source cannot differentiate, which a capture
   * cannot.
   */
  attribute(request: AttributionRequest): Promise<Attribution>;
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
  openSgf: 'katascope:openSgf',
  setGame: 'katascope:setGame',
  analyzePosition: 'katascope:analyzePosition',
  openKact: 'katascope:openKact',
  closeKact: 'katascope:closeKact',
  getReaderWeights: 'katascope:getReaderWeights',
  getHeadWeights: 'katascope:getHeadWeights',
  attribute: 'katascope:attribute',
  describeActivations: 'katascope:describeActivations',
  getActivationFrame: 'katascope:getActivationFrame',
} as const satisfies Record<keyof KatascopeApi, string>;

export type IpcChannel = (typeof IPC_CHANNELS)[keyof typeof IPC_CHANNELS];

/** Method names, for iterating the contract in preload and main. */
export const IPC_METHODS = Object.keys(IPC_CHANNELS) as readonly (keyof KatascopeApi)[];
