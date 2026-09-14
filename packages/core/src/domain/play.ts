/**
 * Playing stones, rather than replaying them.
 *
 * `positionAt` replays a record that already exists and is deliberately lenient
 * about it -- a file is a record of what happened and the parser's job is not
 * to referee it. Generating moves is the opposite problem: a move the rules
 * forbid must never be produced, because there is nothing downstream to catch
 * it. So this module is strict where the parser is permissive.
 *
 * Scope, stated plainly: occupied points, suicide, and **simple ko**. Positional
 * superko is not implemented. The gap is a long-cycle repetition, which needs
 * the whole position history rather than the previous move, and which a policy
 * head sampling its own best move does not in practice walk into. A move
 * generator that stopped there would be wrong; one that stops at simple ko is
 * incomplete in a way worth naming.
 */

import type { BoardSize, Color, Vertex } from './board.js';
import { Board, isOnBoard, neighbours, opposite, vertexIndex } from './board.js';
import type { GameRecord } from './game-record.js';
import { playerToMoveAt } from './game-record.js';
import type { Move, Player } from './move.js';
import { pass, play } from './move.js';

/** The board after a move, and what the move did. */
export interface MoveResult {
  readonly board: Board;
  /** Stones removed by the move. */
  readonly captured: readonly Vertex[];
  /**
   * The point the opponent may not immediately retake, if any.
   *
   * Set only in the shape simple ko names: exactly one stone captured, by a
   * stone that is itself alone with exactly one liberty. Any other capture
   * leaves no ko.
   */
  readonly ko?: Vertex;
}

/** State a legality test needs beyond the board itself. */
export interface RuleState {
  /** A point banned this turn by simple ko. */
  readonly ko?: Vertex;
}

/**
 * Plays a stone, resolving captures.
 *
 * Throws on an occupied point or a suicide, so a caller that has not checked
 * legality finds out here rather than producing a corrupt position.
 */
export function applyMove(board: Board, color: Color, vertex: Vertex): MoveResult {
  if (!isOnBoard(board.size, vertex)) {
    throw new RangeError(`vertex ${vertex.x},${vertex.y} is off the board`);
  }
  if (board.get(vertex) !== 'empty') {
    throw new Error(`cannot play on occupied vertex ${vertex.x},${vertex.y}`);
  }

  const enemy = opposite(color);
  let next = board.with(vertex, color);
  const captured: Vertex[] = [];

  for (const neighbour of neighbours(board.size, vertex)) {
    if (next.get(neighbour) !== enemy) continue;
    const group = groupAt(next, neighbour);
    if (group.liberties > 0) continue;
    for (const stone of group.stones) {
      next = next.with(stone, 'empty');
      captured.push(stone);
    }
  }

  // Suicide is checked after captures: a move that fills its own last liberty
  // is legal when it takes the surrounding group first.
  if (captured.length === 0 && groupAt(next, vertex).liberties === 0) {
    throw new Error(`vertex ${vertex.x},${vertex.y} is suicide for ${color}`);
  }

  const ko = koPoint(next, vertex, captured);
  return { board: next, captured, ...(ko === undefined ? {} : { ko }) };
}

/**
 * The point simple ko forbids after a move, if any.
 *
 * Exactly one stone taken, by a lone stone with exactly one liberty: the only
 * shape where retaking immediately would repeat the position. A snapback or a
 * multi-stone capture is not ko, and banning a point there would forbid a legal
 * and often necessary move.
 */
function koPoint(
  after: Board,
  played: Vertex,
  captured: readonly Vertex[],
): Vertex | undefined {
  if (captured.length !== 1) return undefined;
  const group = groupAt(after, played);
  if (group.stones.length !== 1 || group.liberties !== 1) return undefined;
  return captured[0];
}

/** Whether a colour may play a point under the rules this module implements. */
export function isLegalMove(
  board: Board,
  color: Color,
  vertex: Vertex,
  state: RuleState = {},
): boolean {
  if (!isOnBoard(board.size, vertex)) return false;
  if (board.get(vertex) !== 'empty') return false;
  if (state.ko !== undefined && state.ko.x === vertex.x && state.ko.y === vertex.y) return false;
  try {
    applyMove(board, color, vertex);
    return true;
  } catch {
    // The only throws left are suicide, which is exactly what this rejects.
    return false;
  }
}

/** Every point a colour may legally play. Excludes the pass. */
export function legalMoves(
  board: Board,
  color: Color,
  state: RuleState = {},
): readonly Vertex[] {
  const out: Vertex[] = [];
  for (let y = 0; y < board.size.height; y++) {
    for (let x = 0; x < board.size.width; x++) {
      const vertex = { x, y };
      if (isLegalMove(board, color, vertex, state)) out.push(vertex);
    }
  }
  return out;
}

/** The stones of a group and how many liberties it has. */
function groupAt(board: Board, start: Vertex): { stones: Vertex[]; liberties: number } {
  const color = board.get(start);
  if (color === 'empty') return { stones: [], liberties: 0 };

  const seen = new Set<number>([vertexIndex(board.size, start)]);
  const liberties = new Set<number>();
  const stones: Vertex[] = [start];
  const stack: Vertex[] = [start];

  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) break;
    for (const neighbour of neighbours(board.size, current)) {
      const index = vertexIndex(board.size, neighbour);
      const at = board.get(neighbour);
      if (at === 'empty') {
        liberties.add(index);
        continue;
      }
      if (at !== color || seen.has(index)) continue;
      seen.add(index);
      stones.push(neighbour);
      stack.push(neighbour);
    }
  }
  return { stones, liberties: liberties.size };
}

/**
 * Appends a move, truncating any moves after `atMoveNumber`.
 *
 * Playing from a position the user has navigated back to is a new branch, and
 * keeping the moves that used to follow would produce a record whose board no
 * longer matches its own move list. `undefined` appends to the end.
 */
export function appendMove(
  game: GameRecord,
  move: Move,
  atMoveNumber?: number,
): GameRecord {
  const cut =
    atMoveNumber === undefined
      ? game.moves.length
      : Math.max(0, Math.min(Math.round(atMoveNumber), game.moves.length));
  return { ...game, moves: [...game.moves.slice(0, cut), move] };
}

/** An empty record, for starting a game rather than loading one. */
export function emptyGame(size: BoardSize, komi = 7.5): GameRecord {
  return {
    size,
    info: { komi, handicap: 0 },
    setup: [],
    moves: [],
  };
}

/**
 * The ko point in force after replaying a record to `moveNumber`.
 *
 * Recomputed from the record rather than tracked alongside it, so there is one
 * source of truth about the position and no state to fall out of step.
 */
export function koAt(game: GameRecord, moveNumber: number): Vertex | undefined {
  let board = Board.empty(game.size);
  for (const stone of game.setup) board = board.with(stone.vertex, stone.color);

  const limit = Math.max(0, Math.min(Math.round(moveNumber), game.moves.length));
  let ko: Vertex | undefined;
  for (let i = 0; i < limit; i++) {
    const move = game.moves[i];
    if (move === undefined || move.kind !== 'play') {
      ko = undefined;
      continue;
    }
    try {
      const result = applyMove(board, move.player, move.vertex);
      board = result.board;
      ko = result.ko;
    } catch {
      // The record is history; a move this module would refuse is applied the
      // lenient way `positionAt` applies it, and clears any ko.
      board = board.with(move.vertex, move.player);
      ko = undefined;
    }
  }
  return ko;
}

/** How a move is chosen from a policy. */
export interface ChooseMoveOptions {
  /**
   * Pass rather than play when the best legal move is this much less likely
   * than the pass. Defaults to 1, i.e. pass only when the policy prefers it.
   */
  readonly passThreshold?: number;
  /**
   * Points to refuse even when legal, as plane indices.
   *
   * Used for the "do not fill your own eye" rule that keeps a raw policy from
   * playing a game out to nothing. Not applied by default.
   */
  readonly forbidden?: ReadonlySet<number>;
}

/**
 * The move a policy wants, restricted to what the rules allow.
 *
 * **Greedy, not sampled.** A reduced head is being compared against a full one,
 * and two runs that differ because of a random draw would be indistinguishable
 * from two runs that differ because of the reduction. Determinism is the point.
 *
 * `probabilities` is board-shaped with the pass last, which is how both the
 * analysis engine and `policySoftmax` report it.
 */
export function chooseMove(
  probabilities: ArrayLike<number>,
  board: Board,
  color: Player,
  state: RuleState = {},
  options: ChooseMoveOptions = {},
): Move {
  const { width, height } = board.size;
  const area = width * height;
  const passProbability = probabilities[area] ?? 0;

  let best: Vertex | undefined;
  let bestProbability = Number.NEGATIVE_INFINITY;

  for (let index = 0; index < area; index++) {
    const probability = probabilities[index] ?? 0;
    // KataGo marks illegal moves -1; so does a reduced head, by never being
    // asked. Either way a negative is not a candidate.
    if (probability < 0 || probability <= bestProbability) continue;
    if (options.forbidden?.has(index) === true) continue;
    const vertex = { x: index % width, y: Math.floor(index / width) };
    if (!isLegalMove(board, color, vertex, state)) continue;
    best = vertex;
    bestProbability = probability;
  }

  if (best === undefined) return pass(color);
  const threshold = options.passThreshold ?? 1;
  if (passProbability > 0 && bestProbability < passProbability * threshold) return pass(color);
  return play(color, best);
}

/**
 * Points that are a colour's own single-point eye.
 *
 * A raw policy asked to keep playing will eventually fill its own eyes, because
 * nothing in the position tells it the game is over -- the training data simply
 * never contained such a move. Excluding them lets a self-play demonstration
 * end in something that looks like a finished game rather than a massacre.
 *
 * The usual approximation: an empty point whose orthogonal neighbours are all
 * the colour's own, and whose diagonals are too, allowing one enemy diagonal
 * away from the edge. Not a true eye test, and does not need to be.
 */
export function ownEyes(board: Board, color: Color): ReadonlySet<number> {
  const { width, height } = board.size;
  const out = new Set<number>();
  const enemy = opposite(color);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const vertex = { x, y };
      if (board.get(vertex) !== 'empty') continue;
      if (neighbours(board.size, vertex).some((n) => board.get(n) !== color)) continue;

      let enemyDiagonals = 0;
      let offBoardDiagonals = 0;
      for (const [dx, dy] of [
        [-1, -1],
        [1, -1],
        [-1, 1],
        [1, 1],
      ] as const) {
        const diagonal = { x: x + dx, y: y + dy };
        if (!isOnBoard(board.size, diagonal)) {
          offBoardDiagonals++;
          continue;
        }
        if (board.get(diagonal) === enemy) enemyDiagonals++;
      }
      // On the edge every diagonal must be friendly; in the middle one enemy
      // diagonal still leaves an eye.
      if (enemyDiagonals <= (offBoardDiagonals > 0 ? 0 : 1)) out.add(vertexIndex(board.size, vertex));
    }
  }
  return out;
}

/** Whose turn it is after `moveNumber` moves. Re-exported for convenience. */
export function playerAt(game: GameRecord, moveNumber: number): Player {
  return playerToMoveAt(game, moveNumber);
}
