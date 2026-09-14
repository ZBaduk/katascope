/**
 * Fixture-driven parser coverage.
 *
 * `sgf-parser.spec.ts` holds the small hand-written cases that pin down one
 * grammar rule each. This file exercises the checked-in files in
 * `fixtures/sgf/`, which are the shapes real SGFs actually arrive in.
 */

import { describe, expect, it } from 'vitest';
import { parseSgf, positionAt, SgfParseError, vertexToGtp } from '../src/index.js';
import { listSgfFixtures, readSgfFixture } from './support/fixtures.js';

/**
 * Every fixture must be classified here. A new file in `fixtures/sgf/` that
 * nobody added to this map fails the sweep at the bottom -- fixtures that no
 * test looks at are how coverage quietly rots.
 */
const EXPECTED: Readonly<Record<string, 'parses' | 'throws'>> = {
  'simple-game.sgf': 'parses',
  'handicap-4.sgf': 'parses',
  'setup-ab-aw.sgf': 'parses',
  'passes-and-resign.sgf': 'parses',
  'variations.sgf': 'parses',
  'rectangular-13x9.sgf': 'parses',
  'malformed-unterminated.sgf': 'throws',
};

describe('simple-game.sgf', () => {
  const game = parseSgf(readSgfFixture('simple-game.sgf'));

  it('reads the full root info block', () => {
    expect(game.info).toMatchObject({
      blackName: 'Black Player',
      whiteName: 'White Player',
      blackRank: '5d',
      whiteRank: '6d',
      event: 'Fixture Cup',
      date: '2024-03-11',
      result: 'B+3.5',
      ruleset: 'Japanese',
      komi: 6.5,
      handicap: 0,
    });
  });

  it('reads all 18 moves with alternating colours', () => {
    expect(game.moves).toHaveLength(18);
    expect(game.moves.map((m) => m.player)).toEqual(
      Array.from({ length: 18 }, (_, i) => (i % 2 === 0 ? 'black' : 'white')),
    );
    expect(gtpMoves(game)).toEqual([
      'Q16', 'D4', 'Q4', 'D16', 'F3', 'C6', 'K4', 'R14', 'O17',
      'S16', 'R12', 'R17', 'R16', 'Q17', 'P16', 'S14', 'S12', 'P13',
    ]);
  });

  it('replays to a consistent position', () => {
    const board = positionAt(game, game.moves.length);
    expect(board.get({ x: 15, y: 3 })).toBe('black');
    expect(board.get({ x: 3, y: 15 })).toBe('white');
    expect(board.cells().filter((c) => c !== 'empty')).toHaveLength(18);
  });
});

describe('handicap-4.sgf', () => {
  const game = parseSgf(readSgfFixture('handicap-4.sgf'));

  it('reads the handicap count and the stones that implement it', () => {
    expect(game.info.handicap).toBe(4);
    expect(game.info.komi).toBe(0.5);
    expect(game.setup).toHaveLength(4);
    expect(game.setup.every((s) => s.color === 'black')).toBe(true);
  });

  it('places the handicap stones before move 0', () => {
    const board = positionAt(game, 0);
    for (const corner of [
      { x: 3, y: 3 },
      { x: 15, y: 3 },
      { x: 3, y: 15 },
      { x: 15, y: 15 },
    ]) {
      expect(board.get(corner)).toBe('black');
    }
  });

  it('has White moving first', () => {
    expect(game.moves[0]?.player).toBe('white');
    expect(game.info.result).toBe('W+Resign');
  });
});

describe('setup-ab-aw.sgf', () => {
  const game = parseSgf(readSgfFixture('setup-ab-aw.sgf'));

  it('expands the compressed AW rectangle', () => {
    // AW[bb:bd] is three stones; the other five AW values are single points.
    const white = game.setup.filter((s) => s.color === 'white');
    expect(white).toHaveLength(8);
    for (const y of [1, 2, 3]) {
      expect(white).toContainEqual({ color: 'white', vertex: { x: 1, y } });
    }
  });

  it('reads the AB stones alongside them', () => {
    expect(game.setup.filter((s) => s.color === 'black')).toHaveLength(6);
  });

  it('unescapes bracketed text in a comment without ending the property early', () => {
    // If escaping were broken the C value would terminate at the first "\]"
    // and the rest of the comment would be parsed as properties.
    expect(game.moves).toHaveLength(3);
    expect(game.size).toEqual({ width: 19, height: 19 });
  });

  it('ignores AE (add-empty), which is not implemented', () => {
    // Known gap, asserted so implementing AE trips this test on purpose.
    // The fixture's AE[aa] names an empty point, so honouring it would change
    // nothing -- but the count proves the property was skipped, not applied.
    expect(game.setup).toHaveLength(14);
  });
});

describe('passes-and-resign.sgf', () => {
  const game = parseSgf(readSgfFixture('passes-and-resign.sgf'));

  it('reads a 9x9 board', () => {
    expect(game.size).toEqual({ width: 9, height: 9 });
  });

  it('treats both B[] and W[tt] as passes', () => {
    expect(game.moves.map((m) => m.kind)).toEqual([
      'play', 'play', 'pass', 'pass', 'play', 'play', 'pass', 'play',
    ]);
  });

  it('keeps pass moves in the move numbering', () => {
    // A pass advances the move number without changing the board, so the
    // position after move 4 equals the position after move 2.
    expect(positionAt(game, 4).cells()).toEqual(positionAt(game, 2).cells());
    expect(gtpMoves(game)).toEqual(['E5', 'G5', 'pass', 'pass', 'C7', 'G7', 'pass', 'C3']);
  });

  it('reads a resignation result', () => {
    expect(game.info.result).toBe('W+Resign');
  });
});

describe('variations.sgf', () => {
  const game = parseSgf(readSgfFixture('variations.sgf'));

  it('projects the main line and drops the alternatives', () => {
    expect(gtpMoves(game)).toEqual(['Q16', 'D4', 'Q4', 'D16']);
  });
});

describe('rectangular-13x9.sgf', () => {
  const game = parseSgf(readSgfFixture('rectangular-13x9.sgf'));

  it('reads a non-square SZ[w:h]', () => {
    expect(game.size).toEqual({ width: 13, height: 9 });
  });

  it('numbers rows against the board height, not the width', () => {
    // D6 on a 9-high board is y = 9 - 6 = 3.
    expect(game.moves[0]).toMatchObject({ vertex: { x: 3, y: 3 } });
    expect(gtpMoves(game)).toEqual(['D6', 'K6', 'D3', 'K5']);
  });
});

describe('malformed-unterminated.sgf', () => {
  it('raises SgfParseError rather than returning junk', () => {
    expect(() => parseSgf(readSgfFixture('malformed-unterminated.sgf'))).toThrow(SgfParseError);
  });

  it('reports where it gave up', () => {
    try {
      parseSgf(readSgfFixture('malformed-unterminated.sgf'));
      expect.unreachable('expected a parse error');
    } catch (error) {
      expect(error).toBeInstanceOf(SgfParseError);
      expect((error as SgfParseError).offset).toBeGreaterThan(0);
      expect((error as Error).message).toMatch(/unterminated/);
    }
  });
});

describe('the fixture set', () => {
  it('classifies every file in fixtures/sgf', () => {
    expect(listSgfFixtures()).toEqual(Object.keys(EXPECTED).sort());
  });

  it.each(Object.entries(EXPECTED))('%s %s', (name, outcome) => {
    const parse = (): unknown => parseSgf(readSgfFixture(name));
    if (outcome === 'throws') expect(parse).toThrow(SgfParseError);
    else expect(parse).not.toThrow();
  });
});

function gtpMoves(game: ReturnType<typeof parseSgf>): readonly string[] {
  return game.moves.map((m) => (m.kind === 'pass' ? 'pass' : vertexToGtp(game.size, m.vertex)));
}
