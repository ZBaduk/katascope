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
}

export interface AnalysisEngine {
  /** Starts the engine. Idempotent. Rejects if the engine cannot be launched. */
  start(): Promise<void>;
  /** Engine version string, for Diagnostics. */
  version(): Promise<string>;
  /** Analyses a single position. */
  analyze(query: AnalysisQuery): Promise<AnalysisResult>;
  /** Shuts the engine down. Safe to call more than once. */
  dispose(): Promise<void>;
}
