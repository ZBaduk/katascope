import { describe, expect, it } from 'vitest';
import { parseSgf, parseSgfCollection, positionAt, SgfParseError, vertexToGtp } from '../src/index.js';

const SIMPLE = '(;GM[1]FF[4]SZ[19]KM[6.5]PB[Black]PW[White]RE[B+R];B[pd];W[dp];B[pp];W[dd])';

describe('parseSgf', () => {
  it('reads root info', () => {
    const game = parseSgf(SIMPLE);
    expect(game.size).toEqual({ width: 19, height: 19 });
    expect(game.info.komi).toBe(6.5);
    expect(game.info.blackName).toBe('Black');
    expect(game.info.result).toBe('B+R');
    expect(game.info.handicap).toBe(0);
  });

  it('reads the move list in order', () => {
    const game = parseSgf(SIMPLE);
    expect(game.moves).toHaveLength(4);
    expect(game.moves.map((m) => (m.kind === 'play' ? vertexToGtp(game.size, m.vertex) : 'pass'))).toEqual([
      'Q16',
      'D4',
      'Q4',
      'D16',
    ]);
    expect(game.moves.map((m) => m.player)).toEqual(['black', 'white', 'black', 'white']);
  });

  it('defaults board size and komi when absent', () => {
    const game = parseSgf('(;GM[1];B[aa])');
    expect(game.size).toEqual({ width: 19, height: 19 });
    expect(game.info.komi).toBe(7.5);
  });

  it('reads rectangular board sizes', () => {
    expect(parseSgf('(;SZ[13:9])').size).toEqual({ width: 13, height: 9 });
  });

  it('treats empty and tt values as passes', () => {
    const game = parseSgf('(;SZ[19];B[];W[tt])');
    expect(game.moves.map((m) => m.kind)).toEqual(['pass', 'pass']);
  });

  it('expands compressed setup rectangles', () => {
    const game = parseSgf('(;SZ[19]HA[2]AB[dd:ee]AW[pp])');
    expect(game.setup.filter((s) => s.color === 'black')).toHaveLength(4);
    expect(game.setup.filter((s) => s.color === 'white')).toEqual([
      { color: 'white', vertex: { x: 15, y: 15 } },
    ]);
    expect(game.info.handicap).toBe(2);
  });

  it('unescapes property values', () => {
    const game = parseSgf('(;SZ[19]EV[Cup \\[2024\\]]PB[A\\\\B])');
    expect(game.info.event).toBe('Cup [2024]');
    expect(game.info.blackName).toBe('A\\B');
  });

  it('follows the main line through variations', () => {
    const game = parseSgf('(;SZ[19];B[pd](;W[dp];B[pp])(;W[dd]))');
    expect(game.moves).toHaveLength(3);
    expect(game.moves[1]).toMatchObject({ player: 'white', vertex: { x: 3, y: 15 } });
  });

  it('parses a collection of games', () => {
    const games = parseSgfCollection('(;SZ[19];B[aa])(;SZ[9];W[bb])');
    expect(games).toHaveLength(2);
  });

  it('rejects malformed input', () => {
    expect(() => parseSgf('not an sgf')).toThrow(SgfParseError);
    expect(() => parseSgf('(;SZ[19')).toThrow(SgfParseError);
  });
});

describe('positionAt', () => {
  it('replays to the requested move number', () => {
    const game = parseSgf(SIMPLE);
    expect(positionAt(game, 0).get({ x: 15, y: 3 })).toBe('empty');
    expect(positionAt(game, 1).get({ x: 15, y: 3 })).toBe('black');
    expect(positionAt(game, 4).get({ x: 3, y: 3 })).toBe('white');
  });

  it('places setup stones before the first move', () => {
    const game = parseSgf('(;SZ[19]AB[dd][pp];W[aa])');
    const board = positionAt(game, 0);
    expect(board.get({ x: 3, y: 3 })).toBe('black');
    expect(board.get({ x: 15, y: 15 })).toBe('black');
  });

  it('clamps out-of-range move numbers', () => {
    const game = parseSgf(SIMPLE);
    expect(positionAt(game, 99).cells()).toEqual(positionAt(game, 4).cells());
    expect(positionAt(game, -5).cells()).toEqual(positionAt(game, 0).cells());
  });
});
