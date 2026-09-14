/** Moves, and the GTP-style coordinate strings KataGo speaks. */

import type { BoardSize, Color, Vertex } from './board.js';
import { isOnBoard } from './board.js';

/** The side to move. Same values as `Color`; named separately for readability at call sites. */
export type Player = Color;

/** A play at a specific intersection. */
export interface PlayMove {
  readonly kind: 'play';
  readonly player: Player;
  readonly vertex: Vertex;
}

/** A pass. */
export interface PassMove {
  readonly kind: 'pass';
  readonly player: Player;
}

export type Move = PlayMove | PassMove;

export function play(player: Player, vertex: Vertex): PlayMove {
  return { kind: 'play', player, vertex };
}

export function pass(player: Player): PassMove {
  return { kind: 'pass', player };
}

/** GTP column letters: 'I' is skipped, as in every Go program since the 1980s. */
const GTP_COLUMNS = 'ABCDEFGHJKLMNOPQRSTUVWXYZ';

/**
 * Formats a vertex as a GTP coordinate (e.g. `Q16`). Row numbers count up from
 * the bottom of the board, so the conversion depends on the board height.
 */
export function vertexToGtp(size: BoardSize, v: Vertex): string {
  if (!isOnBoard(size, v)) {
    throw new RangeError(`vertex ${v.x},${v.y} is outside a ${size.width}x${size.height} board`);
  }
  const column = GTP_COLUMNS[v.x];
  if (column === undefined) {
    throw new RangeError(`board width ${size.width} exceeds GTP coordinate space`);
  }
  return `${column}${size.height - v.y}`;
}

/** Parses a GTP coordinate. Returns `undefined` for `pass`/`resign` or malformed input. */
export function gtpToVertex(size: BoardSize, gtp: string): Vertex | undefined {
  const text = gtp.trim().toUpperCase();
  const column = text.charAt(0);
  const x = GTP_COLUMNS.indexOf(column);
  if (x < 0) return undefined;
  const row = Number.parseInt(text.slice(1), 10);
  if (!Number.isInteger(row)) return undefined;
  const v: Vertex = { x, y: size.height - row };
  return isOnBoard(size, v) ? v : undefined;
}

/** Formats a move the way the KataGo analysis engine expects it. */
export function moveToGtp(size: BoardSize, move: Move): string {
  return move.kind === 'pass' ? 'pass' : vertexToGtp(size, move.vertex);
}

/** `['B', 'Q16']` pairs, the `moves` entry of a KataGo analysis query. */
export function moveToAnalysisPair(size: BoardSize, move: Move): readonly [string, string] {
  return [move.player === 'black' ? 'B' : 'W', moveToGtp(size, move)];
}
