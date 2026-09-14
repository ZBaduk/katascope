/**
 * Board geometry and position state.
 *
 * A `Board` is an immutable snapshot: mutating helpers return a new instance.
 * Nothing here knows about rules scoring, ko, or superko yet -- captures are
 * resolved, everything else is deliberately out of scope for the skeleton.
 */

/** Stone colour. `'empty'` is a board state, not a player. */
export type Color = 'black' | 'white';

/** Contents of a single intersection. */
export type Intersection = Color | 'empty';

/** Board dimensions. KataGo supports non-square boards, so width and height are separate. */
export interface BoardSize {
  readonly width: number;
  readonly height: number;
}

/** Zero-based intersection coordinate. `x` runs left-to-right, `y` top-to-bottom. */
export interface Vertex {
  readonly x: number;
  readonly y: number;
}

/** A square board of the given edge length. */
export function squareBoardSize(edge: number): BoardSize {
  return { width: edge, height: edge };
}

export function boardArea(size: BoardSize): number {
  return size.width * size.height;
}

export function isOnBoard(size: BoardSize, v: Vertex): boolean {
  return v.x >= 0 && v.y >= 0 && v.x < size.width && v.y < size.height;
}

export function vertexIndex(size: BoardSize, v: Vertex): number {
  return v.y * size.width + v.x;
}

export function vertexFromIndex(size: BoardSize, index: number): Vertex {
  return { x: index % size.width, y: Math.floor(index / size.width) };
}

export function opposite(color: Color): Color {
  return color === 'black' ? 'white' : 'black';
}

/**
 * Immutable board position. Intersections are stored row-major in a flat array
 * so that a position maps 1:1 onto the spatial layout of a network's activation
 * planes.
 */
export class Board {
  readonly size: BoardSize;
  readonly #cells: readonly Intersection[];

  private constructor(size: BoardSize, cells: readonly Intersection[]) {
    this.size = size;
    this.#cells = cells;
  }

  static empty(size: BoardSize): Board {
    return new Board(size, new Array<Intersection>(boardArea(size)).fill('empty'));
  }

  get(v: Vertex): Intersection {
    if (!isOnBoard(this.size, v)) {
      throw new RangeError(`vertex ${v.x},${v.y} is outside a ${this.size.width}x${this.size.height} board`);
    }
    return this.#cells[vertexIndex(this.size, v)] ?? 'empty';
  }

  /** Row-major snapshot of every intersection. */
  cells(): readonly Intersection[] {
    return this.#cells;
  }

  /** Returns a new board with `v` set to `value`, without any rule checking. */
  with(v: Vertex, value: Intersection): Board {
    const next = [...this.#cells];
    next[vertexIndex(this.size, v)] = value;
    return new Board(this.size, next);
  }

  /**
   * Plays `color` at `v`, removing any opposing group left without liberties.
   * Throws if the point is occupied. Suicide and ko are not validated here.
   */
  play(color: Color, v: Vertex): Board {
    if (this.get(v) !== 'empty') {
      throw new Error(`cannot play on occupied vertex ${v.x},${v.y}`);
    }
    let next = this.with(v, color);
    const enemy = opposite(color);
    for (const n of neighbours(this.size, v)) {
      if (next.get(n) === enemy && !next.#hasLiberty(n)) {
        next = next.#removeGroup(n);
      }
    }
    return next;
  }

  #hasLiberty(start: Vertex): boolean {
    const color = this.get(start);
    if (color === 'empty') return true;
    const seen = new Set<number>([vertexIndex(this.size, start)]);
    const stack: Vertex[] = [start];
    while (stack.length > 0) {
      const cur = stack.pop()!;
      for (const n of neighbours(this.size, cur)) {
        const idx = vertexIndex(this.size, n);
        if (seen.has(idx)) continue;
        const at = this.get(n);
        if (at === 'empty') return true;
        if (at === color) {
          seen.add(idx);
          stack.push(n);
        }
      }
    }
    return false;
  }

  #removeGroup(start: Vertex): Board {
    const color = this.get(start);
    if (color === 'empty') return this;
    const cells = [...this.#cells];
    const stack: Vertex[] = [start];
    cells[vertexIndex(this.size, start)] = 'empty';
    while (stack.length > 0) {
      const cur = stack.pop()!;
      for (const n of neighbours(this.size, cur)) {
        const idx = vertexIndex(this.size, n);
        if (cells[idx] === color) {
          cells[idx] = 'empty';
          stack.push(n);
        }
      }
    }
    return new Board(this.size, cells);
  }
}

export function neighbours(size: BoardSize, v: Vertex): Vertex[] {
  const candidates: Vertex[] = [
    { x: v.x - 1, y: v.y },
    { x: v.x + 1, y: v.y },
    { x: v.x, y: v.y - 1 },
    { x: v.x, y: v.y + 1 },
  ];
  return candidates.filter((c) => isOnBoard(size, c));
}
