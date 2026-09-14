/**
 * The rules, as far as generating a move needs them.
 *
 * `positionAt` replays history leniently; this refuses to produce a move the
 * rules forbid. The difference matters because nothing downstream re-checks: an
 * illegal move from the reduced net would be appended to the record, sent to
 * the sidecar, and come back as activations for a position that cannot exist.
 */

import { describe, expect, it } from 'vitest';
import {
  appendMove,
  applyMove,
  Board,
  chooseMove,
  emptyGame,
  isLegalMove,
  koAt,
  legalMoves,
  ownEyes,
  parseSgf,
  pass,
  play,
  squareBoardSize,
  vertexIndex,
  type Vertex,
} from '../src/index.js';

const SIZE = squareBoardSize(5);

/** Builds a board from a picture: `.` empty, `b` black, `w` white. */
function board(...rows: readonly string[]): Board {
  const size = { width: rows[0]?.length ?? 0, height: rows.length };
  let result = Board.empty(size);
  for (const [y, row] of rows.entries()) {
    for (const [x, cell] of [...row].entries()) {
      if (cell === 'b') result = result.with({ x, y }, 'black');
      if (cell === 'w') result = result.with({ x, y }, 'white');
    }
  }
  return result;
}

/** A probability vector that wants one point above all others. */
function wants(size: { width: number; height: number }, vertex: Vertex, passValue = 0): number[] {
  const values = new Array<number>(size.width * size.height + 1).fill(0.001);
  values[vertex.y * size.width + vertex.x] = 0.9;
  values[size.width * size.height] = passValue;
  return values;
}

describe('applyMove', () => {
  it('places a stone', () => {
    const result = applyMove(Board.empty(SIZE), 'black', { x: 2, y: 2 });
    expect(result.board.get({ x: 2, y: 2 })).toBe('black');
    expect(result.captured).toEqual([]);
    expect(result.ko).toBeUndefined();
  });

  it('captures a surrounded stone', () => {
    // White at (1,1) with its last liberty at (2,1).
    const start = board('.b...', 'bw...', '.b...', '.....', '.....');
    const result = applyMove(start, 'black', { x: 2, y: 1 });
    expect(result.board.get({ x: 1, y: 1 })).toBe('empty');
    expect(result.captured).toEqual([{ x: 1, y: 1 }]);
  });

  it('captures a whole group, not just the stone it touched', () => {
    const start = board('.bb..', 'bww..', '.bb..', '.....', '.....');
    const result = applyMove(start, 'black', { x: 3, y: 1 });
    expect(result.captured).toHaveLength(2);
    expect(result.board.get({ x: 1, y: 1 })).toBe('empty');
    expect(result.board.get({ x: 2, y: 1 })).toBe('empty');
  });

  it('refuses an occupied point', () => {
    const start = board('b....', '.....', '.....', '.....', '.....');
    expect(() => applyMove(start, 'white', { x: 0, y: 0 })).toThrow(/occupied/);
  });

  it('refuses suicide', () => {
    // White's last liberty at (0,0), filling it takes nothing.
    const start = board('.b...', 'b....', '.....', '.....', '.....');
    expect(() => applyMove(start, 'white', { x: 0, y: 0 })).toThrow(/suicide/);
  });

  it('allows filling your own last liberty when it captures first', () => {
    // Black at (0,0) would have no liberties, except that it takes the white
    // group at (1,0)-(0,1) first. Refusing this would forbid a legal move.
    const start = board('.wb..', 'wb...', 'b....', '.....', '.....');
    const result = applyMove(start, 'black', { x: 0, y: 0 });
    expect(result.captured).toHaveLength(2);
    expect(result.board.get({ x: 0, y: 0 })).toBe('black');
  });

  it('refuses a point off the board', () => {
    expect(() => applyMove(Board.empty(SIZE), 'black', { x: 5, y: 0 })).toThrow(RangeError);
  });

  it('does not mutate the board it was given', () => {
    const start = board('.b...', 'bw...', '.....', '.....', '.....');
    applyMove(start, 'black', { x: 2, y: 1 });
    expect(start.get({ x: 1, y: 1 })).toBe('white');
  });
});

describe('ko', () => {
  /**
   * The textbook shape. White has just taken at (2,1); black must not retake.
   *
   *   . b w . .
   *   b w . w .
   *   . b w . .
   */
  const afterWhiteTakes = board('.bw..', 'bw.w.', '.bw..', '.....', '.....');

  it('reports the point taken as ko after a single-stone capture', () => {
    // Black at (2,1) has one liberty, at (1,1). White fills it, taking the
    // stone, and the white stone is then itself alone with one liberty --
    // exactly the shape where retaking would repeat the position.
    const start = board('.bw..', 'b.bw.', '.bw..', '.....', '.....');
    const result = applyMove(start, 'white', { x: 1, y: 1 });
    expect(result.captured).toEqual([{ x: 2, y: 1 }]);
    expect(result.ko).toEqual({ x: 2, y: 1 });
  });

  it('forbids the immediate retake', () => {
    expect(isLegalMove(afterWhiteTakes, 'black', { x: 2, y: 1 })).toBe(true);
    expect(isLegalMove(afterWhiteTakes, 'black', { x: 2, y: 1 }, { ko: { x: 2, y: 1 } })).toBe(
      false,
    );
  });

  it('bans only that point, not the rest of the board', () => {
    expect(isLegalMove(afterWhiteTakes, 'black', { x: 0, y: 3 }, { ko: { x: 2, y: 1 } })).toBe(
      true,
    );
  });

  it('is not raised by a multi-stone capture', () => {
    const start = board('.bb..', 'bww..', '.bb..', '.....', '.....');
    const result = applyMove(start, 'black', { x: 3, y: 1 });
    // Two stones taken cannot be recreated by one reply, so there is no ko.
    expect(result.ko).toBeUndefined();
  });

  it('is not raised when the capturing stone keeps more than one liberty', () => {
    // One stone taken, but the stone that took it is not itself in atari, so
    // retaking cannot repeat the position and banning the point would forbid a
    // legal move.
    const start = board('bb...', 'bwb..', '.....', '.....', '.....');
    const result = applyMove(start, 'black', { x: 1, y: 2 });
    expect(result.captured).toEqual([{ x: 1, y: 1 }]);
    expect(result.ko).toBeUndefined();
  });
});

describe('koAt', () => {
  it('recomputes the ban from the record', () => {
    const game = parseSgf('(;GM[1]FF[4]SZ[5];B[ba];W[ca];B[ab];W[db];B[bc];W[cc];B[cb];W[bb])');
    // The ko point after white's last capture, derived from the record alone.
    const ko = koAt(game, game.moves.length);
    expect(ko).toBeDefined();
  });

  it('is cleared by a pass', () => {
    const game = {
      ...emptyGame(squareBoardSize(5)),
      moves: [play('black', { x: 0, y: 0 }), pass('white')],
    };
    expect(koAt(game, 2)).toBeUndefined();
  });

  it('is undefined at the start', () => {
    expect(koAt(emptyGame(SIZE), 0)).toBeUndefined();
  });
});

describe('legalMoves', () => {
  it('excludes occupied points', () => {
    const start = board('b....', '.....', '.....', '.....', '.....');
    const moves = legalMoves(start, 'white');
    expect(moves).toHaveLength(24);
    expect(moves.some((v) => v.x === 0 && v.y === 0)).toBe(false);
  });

  it('excludes suicides and the ko point', () => {
    const start = board('.b...', 'b....', '.....', '.....', '.....');
    const plain = legalMoves(start, 'white');
    expect(plain.some((v) => v.x === 0 && v.y === 0)).toBe(false);

    const withKo = legalMoves(start, 'white', { ko: { x: 4, y: 4 } });
    expect(withKo.some((v) => v.x === 4 && v.y === 4)).toBe(false);
  });
});

describe('chooseMove', () => {
  const empty = Board.empty(SIZE);

  it('takes the most likely legal point', () => {
    const move = chooseMove(wants(SIZE, { x: 3, y: 1 }), empty, 'black');
    expect(move).toEqual(play('black', { x: 3, y: 1 }));
  });

  it('skips an occupied point for the next best', () => {
    const start = board('.....', '...b.', '.....', '.....', '.....');
    const values = wants(SIZE, { x: 3, y: 1 });
    values[2 * 5 + 2] = 0.5; // second choice
    expect(chooseMove(values, start, 'white')).toEqual(play('white', { x: 2, y: 2 }));
  });

  it('skips a suicide', () => {
    const start = board('.b...', 'b....', '.....', '.....', '.....');
    const values = wants(SIZE, { x: 0, y: 0 });
    values[4 * 5 + 4] = 0.5;
    expect(chooseMove(values, start, 'white')).toEqual(play('white', { x: 4, y: 4 }));
  });

  it('respects the ko ban', () => {
    const start = board('.bw..', 'bw.w.', '.bw..', '.....', '.....');
    const values = wants(SIZE, { x: 2, y: 1 });
    values[4 * 5 + 4] = 0.5;
    const move = chooseMove(values, start, 'black', { ko: { x: 2, y: 1 } });
    expect(move).toEqual(play('black', { x: 4, y: 4 }));
  });

  it('passes when the policy prefers the pass', () => {
    const values = wants(SIZE, { x: 1, y: 1 }, 0.95);
    expect(chooseMove(values, empty, 'black')).toEqual(pass('black'));
  });

  it('plays when the best move beats the pass', () => {
    const values = wants(SIZE, { x: 1, y: 1 }, 0.5);
    expect(chooseMove(values, empty, 'black')).toEqual(play('black', { x: 1, y: 1 }));
  });

  it('passes when nothing is legal', () => {
    // A full board leaves no legal move at all.
    let full = Board.empty(SIZE);
    for (let y = 0; y < 5; y++) for (let x = 0; x < 5; x++) full = full.with({ x, y }, 'black');
    expect(chooseMove(wants(SIZE, { x: 0, y: 0 }), full, 'white')).toEqual(pass('white'));
  });

  it('ignores negative probabilities, which mark illegal moves', () => {
    const values = new Array<number>(26).fill(-1);
    values[2 * 5 + 2] = 0.4;
    expect(chooseMove(values, empty, 'black')).toEqual(play('black', { x: 2, y: 2 }));
  });

  it('is deterministic: the same policy gives the same move every time', () => {
    // Greedy rather than sampled on purpose -- a reduced head is being compared
    // against a full one, and a random draw would be indistinguishable from the
    // effect of the reduction.
    const values = wants(SIZE, { x: 3, y: 3 });
    const first = chooseMove(values, empty, 'black');
    for (let i = 0; i < 5; i++) expect(chooseMove(values, empty, 'black')).toEqual(first);
  });

  it('breaks ties towards the lower index rather than arbitrarily', () => {
    const values = new Array<number>(26).fill(0);
    values[7] = 0.5;
    values[9] = 0.5;
    expect(chooseMove(values, empty, 'black')).toEqual(play('black', { x: 2, y: 1 }));
  });

  it('avoids forbidden points when given any', () => {
    const values = wants(SIZE, { x: 1, y: 1 });
    values[3 * 5 + 3] = 0.5;
    const forbidden = new Set([vertexIndex(SIZE, { x: 1, y: 1 })]);
    expect(chooseMove(values, empty, 'black', {}, { forbidden })).toEqual(
      play('black', { x: 3, y: 3 }),
    );
  });
});

describe('ownEyes', () => {
  it('finds a surrounded point in the middle', () => {
    const start = board('.....', '..b..', '.b.b.', '..b..', '.....');
    const eyes = ownEyes(start, 'black');
    expect(eyes.has(vertexIndex(start.size, { x: 2, y: 2 }))).toBe(true);
  });

  it('does not call an empty board an eye', () => {
    expect(ownEyes(Board.empty(SIZE), 'black').size).toBe(0);
  });

  it('is stricter in the corner, where every diagonal must be friendly', () => {
    // (0,0) surrounded orthogonally, with the enemy on its one real diagonal.
    const start = board('.b...', 'bw...', '.....', '.....', '.....');
    expect(ownEyes(start, 'black').has(vertexIndex(start.size, { x: 0, y: 0 }))).toBe(false);
  });

  it('tolerates one enemy diagonal away from the edge', () => {
    const start = board('w.b..', '.b.b.', '..b..', '.....', '.....');
    expect(ownEyes(start, 'black').has(vertexIndex(start.size, { x: 2, y: 1 }))).toBe(true);
  });
});

describe('appendMove', () => {
  const game = parseSgf('(;GM[1]FF[4]SZ[19];B[pd];W[dp];B[pp])');

  it('appends to the end by default', () => {
    const next = appendMove(game, pass('white'));
    expect(next.moves).toHaveLength(4);
    expect(next.moves[3]).toEqual(pass('white'));
  });

  it('truncates when played from an earlier position', () => {
    // Playing from move 1 is a new branch; keeping the old continuation would
    // leave a record whose board does not match its own move list.
    const next = appendMove(game, play('white', { x: 3, y: 3 }), 1);
    expect(next.moves).toHaveLength(2);
    expect(next.moves[1]).toEqual(play('white', { x: 3, y: 3 }));
  });

  it('does not mutate the record it was given', () => {
    appendMove(game, pass('white'));
    expect(game.moves).toHaveLength(3);
  });

  it('keeps the size, info and setup stones', () => {
    const handicap = parseSgf('(;GM[1]FF[4]SZ[19]HA[2]AB[pd][dp];W[dd])');
    const next = appendMove(handicap, pass('black'));
    expect(next.setup).toEqual(handicap.setup);
    expect(next.info).toEqual(handicap.info);
    expect(next.size).toEqual(handicap.size);
  });
});

describe('emptyGame', () => {
  it('is a playable record with no moves', () => {
    const game = emptyGame(squareBoardSize(19));
    expect(game.moves).toHaveLength(0);
    expect(game.setup).toHaveLength(0);
    expect(game.size).toEqual(squareBoardSize(19));
    expect(game.info.komi).toBe(7.5);
  });
});
