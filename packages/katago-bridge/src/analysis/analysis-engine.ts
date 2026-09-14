/**
 * The analysis-engine seam.
 *
 * Callers depend on `AnalysisEngine` only. `KataGoAnalysisEngine` spawns the
 * real binary; `FakeAnalysisEngine` answers from nothing. Swapping them is how
 * the app runs on a machine with no KataGo installed.
 */

import type { BoardSize, Move, SetupStone } from '@katascope/core';

/**
 * One position to analyse.
 *
 * `turnNumber` selects which position in `moves` to report on: 0 is before the
 * first move, `moves.length` is the final position.
 */
export interface AnalysisQuery {
  readonly boardSize: BoardSize;
  /** KataGo ruleset name, e.g. `chinese`, `japanese`, `tromp-taylor`. */
  readonly rules: string;
  readonly komi: number;
  readonly initialStones: readonly SetupStone[];
  readonly moves: readonly Move[];
  readonly turnNumber: number;
  readonly maxVisits: number;
  /**
   * Who is to move at turn 0. Sent as KataGo's `initialPlayer`, which it
   * otherwise infers from the handicap stones.
   */
  readonly initialPlayer?: 'B' | 'W';
  /** Ask for the raw policy alongside the search result. Defaults to false. */
  readonly includePolicy?: boolean;
  /** Ask for the ownership prediction. Defaults to false. */
  readonly includeOwnership?: boolean;
}

/** One candidate move, as reported by KataGo. */
export interface MoveAnalysis {
  /** GTP coordinate, or `pass`. */
  readonly move: string;
  readonly visits: number;
  /** Winrate for the side to move, 0..1. */
  readonly winrate: number;
  readonly scoreLead: number;
  /** Policy prior for this move, 0..1. */
  readonly prior: number;
  /** Rank among candidates; 0 is the engine's preferred move. */
  readonly order: number;
  /** Principal variation, as GTP coordinates. */
  readonly pv: readonly string[];
}

/** Evaluation of the position itself, independent of any candidate move. */
export interface RootAnalysis {
  readonly winrate: number;
  readonly scoreLead: number;
  readonly visits: number;
}

export interface AnalysisResult {
  readonly turnNumber: number;
  readonly rootInfo: RootAnalysis;
  readonly moveInfos: readonly MoveAnalysis[];
  /**
   * Raw network policy, present when `includePolicy` was set.
   * `width * height + 1` entries, row-major from the top-left, pass last.
   * **Illegal moves are `-1`**, not zero -- KataGo's convention, preserved so
   * callers must decide what to do rather than comparing against a fabricated
   * probability.
   */
  readonly policy?: readonly number[];
  /**
   * Ownership prediction, present when `includeOwnership` was set.
   * `width * height` entries in [-1, 1], row-major from the top-left.
   * The sign is relative to `reportAnalysisWinratesAs` in the engine config;
   * `configs/analysis-deterministic.cfg` sets that to SIDETOMOVE.
   */
  readonly ownership?: readonly number[];
}

/** What an engine is currently doing, for Diagnostics. */
export type EngineState = 'stopped' | 'starting' | 'ready' | 'failed';

export interface AnalysisEngine {
  /** Starts the engine. Idempotent. Rejects if the engine cannot be launched. */
  start(): Promise<void>;
  /** Current lifecycle state. Never throws. */
  readonly state: EngineState;
  /**
   * Stops the process and starts a fresh one, failing any in-flight requests.
   * Used to recover from a crash without rebuilding the whole bridge.
   */
  restart(): Promise<void>;
  /** Engine version string, for Diagnostics. */
  version(): Promise<string>;
  /** Analyses a single position. */
  analyze(query: AnalysisQuery): Promise<AnalysisResult>;
  /** Shuts the engine down. Safe to call more than once. */
  dispose(): Promise<void>;
}
