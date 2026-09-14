/** A parsed game: metadata, the move list, and the positions it produces. */

import type { BoardSize, Color } from './board.js';
import { Board } from './board.js';
import type { Move, Player } from './move.js';

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

/**
 * Which player is to move after `moveNumber` moves.
 *
 * Not always alternating, and not always Black first. After a handicap the
 * setup stones are all Black and **White plays first**, which no amount of
 * looking at the move list reveals if the list is empty. Getting this wrong
 * feeds the network the position from the other player's point of view --
 * the value and ownership heads come back sign-flipped, and the activations
 * are those of a position nobody is in.
 */
export function playerToMoveAt(game: GameRecord, moveNumber: number): Player {
  const clamped = Math.max(0, Math.min(moveNumber, game.moves.length));
  const next = game.moves[clamped];
  if (next !== undefined) return next.player;

  const last = game.moves[clamped - 1];
  if (last !== undefined) return last.player === 'black' ? 'white' : 'black';

  // No moves at all: infer from the setup. More black stones than white means
  // a handicap, and White answers it.
  let black = 0;
  let white = 0;
  for (const stone of game.setup) {
    if (stone.color === 'black') black++;
    else white++;
  }
  return black > white ? 'white' : 'black';
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
