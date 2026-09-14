/** A parsed game: metadata, the move list, and the positions it produces. */

import type { BoardSize, Color } from './board.js';
import { Board } from './board.js';
import type { Move } from './move.js';

export interface GameInfo {
  readonly blackName?: string;
  readonly whiteName?: string;
  readonly blackRank?: string;
  readonly whiteRank?: string;
  readonly event?: string;
  readonly date?: string;
  readonly result?: string;
  readonly komi: number;
  readonly handicap: number;
  readonly ruleset?: string;
}

export interface GameRecord {
  readonly size: BoardSize;
  readonly info: GameInfo;
  /** Handicap / setup stones placed before the first move (SGF `AB`/`AW`). */
  readonly setup: readonly SetupStone[];
  readonly moves: readonly Move[];
}

export interface SetupStone {
  readonly color: Color;
  readonly vertex: { readonly x: number; readonly y: number };
}

/** Number of positions in a game: the empty board plus one per move. */
export function positionCount(game: GameRecord): number {
  return game.moves.length + 1;
}

/**
 * Replays the game to `moveNumber` (0 = the position before the first move).
 * Illegal-looking moves are applied leniently: playing onto an occupied point
 * is skipped rather than thrown, because real SGF files contain oddities.
 */
export function positionAt(game: GameRecord, moveNumber: number): Board {
  let board = Board.empty(game.size);
  for (const stone of game.setup) {
    board = board.with(stone.vertex, stone.color);
  }
  const limit = Math.max(0, Math.min(moveNumber, game.moves.length));
  for (let i = 0; i < limit; i++) {
    const move = game.moves[i];
    if (move === undefined || move.kind === 'pass') continue;
    if (board.get(move.vertex) !== 'empty') continue;
    board = board.play(move.player, move.vertex);
  }
  return board;
}
