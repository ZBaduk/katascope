import { describe, expect, it } from 'vitest';
import { Board, gtpToVertex, squareBoardSize, vertexToGtp } from '../src/index.js';

const SIZE = squareBoardSize(9);

describe('Board', () => {
  it('starts empty and stays immutable', () => {
    const empty = Board.empty(SIZE);
    const played = empty.play('black', { x: 2, y: 2 });
    expect(empty.get({ x: 2, y: 2 })).toBe('empty');
    expect(played.get({ x: 2, y: 2 })).toBe('black');
  });

  it('rejects plays on occupied points and off-board vertices', () => {
    const board = Board.empty(SIZE).play('black', { x: 0, y: 0 });
    expect(() => board.play('white', { x: 0, y: 0 })).toThrow(/occupied/);
    expect(() => board.get({ x: 9, y: 0 })).toThrow(RangeError);
  });

  it('captures a stone with no liberties', () => {
    let board = Board.empty(SIZE).play('black', { x: 0, y: 0 });
    board = board.play('white', { x: 1, y: 0 });
    board = board.play('white', { x: 0, y: 1 });
    expect(board.get({ x: 0, y: 0 })).toBe('empty');
  });

  it('captures a whole group at once', () => {
    let board = Board.empty(SIZE);
    for (const v of [
      { x: 4, y: 4 },
      { x: 5, y: 4 },
    ]) {
      board = board.play('black', v);
    }
    for (const v of [
      { x: 3, y: 4 },
      { x: 6, y: 4 },
      { x: 4, y: 3 },
      { x: 5, y: 3 },
      { x: 4, y: 5 },
    ]) {
      board = board.play('white', v);
    }
    expect(board.get({ x: 4, y: 4 })).toBe('black');
    board = board.play('white', { x: 5, y: 5 });
    expect(board.get({ x: 4, y: 4 })).toBe('empty');
    expect(board.get({ x: 5, y: 4 })).toBe('empty');
  });
});

describe('gtp coordinates', () => {
  it('round-trips, skipping the letter I', () => {
    const size = squareBoardSize(19);
    expect(vertexToGtp(size, { x: 0, y: 18 })).toBe('A1');
    expect(vertexToGtp(size, { x: 8, y: 3 })).toBe('J16');
    expect(gtpToVertex(size, 'Q16')).toEqual({ x: 15, y: 3 });
    expect(gtpToVertex(size, 'q16')).toEqual({ x: 15, y: 3 });
  });

  it('returns undefined for non-coordinates', () => {
    const size = squareBoardSize(19);
    expect(gtpToVertex(size, 'pass')).toBeUndefined();
    expect(gtpToVertex(size, 'I5')).toBeUndefined();
    expect(gtpToVertex(size, 'A99')).toBeUndefined();
  });
});
