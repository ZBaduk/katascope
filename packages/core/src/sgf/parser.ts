/**
 * SGF (FF[4]) reader.
 *
 * Parses a collection into a generic node tree, then projects the main line of
 * the first game onto a `GameRecord`. Variations are parsed but not retained in
 * the record -- katascope inspects a single sequence of positions at a time.
 */

import type { Color, Vertex } from '../domain/board.js';
import { squareBoardSize } from '../domain/board.js';
import type { GameInfo, GameRecord, SetupStone } from '../domain/game-record.js';
import type { Move } from '../domain/move.js';
import { pass, play } from '../domain/move.js';

/** One SGF node: property identifiers mapped to their raw value list. */
export interface SgfNode {
  readonly properties: ReadonlyMap<string, readonly string[]>;
  readonly children: readonly SgfNode[];
}

export class SgfParseError extends Error {
  readonly offset: number;
  constructor(message: string, offset: number) {
    super(`${message} (at offset ${offset})`);
    this.name = 'SgfParseError';
    this.offset = offset;
  }
}

/** Parses a full SGF collection into game trees. */
export function parseSgfCollection(text: string): readonly SgfNode[] {
  const reader = new SgfReader(text);
  const games: SgfNode[] = [];
  reader.skipWhitespace();
  while (!reader.atEnd()) {
    games.push(reader.readGameTree());
    reader.skipWhitespace();
  }
  if (games.length === 0) {
    throw new SgfParseError('no game tree found', 0);
  }
  return games;
}

/** Parses the first game in an SGF file and projects its main line. */
export function parseSgf(text: string): GameRecord {
  const [first] = parseSgfCollection(text);
  if (first === undefined) {
    throw new SgfParseError('no game tree found', 0);
  }
  return toGameRecord(first);
}

/** Projects a parsed tree's main line (always the first child) onto a record. */
export function toGameRecord(root: SgfNode): GameRecord {
  const size = readSize(root);
  const info = readInfo(root);
  const setup: SetupStone[] = [];
  const moves: Move[] = [];

  for (let node: SgfNode | undefined = root; node !== undefined; node = node.children[0]) {
    collectSetup(node, setup);
    const move = readMove(node, size.width);
    if (move !== undefined) moves.push(move);
  }

  return { size, info, setup, moves };
}

function readSize(root: SgfNode): ReturnType<typeof squareBoardSize> {
  const raw = single(root, 'SZ');
  if (raw === undefined) return squareBoardSize(19);
  const [w, h] = raw.split(':');
  const width = Number.parseInt(w ?? '', 10);
  if (!Number.isInteger(width) || width < 1) return squareBoardSize(19);
  if (h === undefined) return squareBoardSize(width);
  const height = Number.parseInt(h, 10);
  return { width, height: Number.isInteger(height) && height > 0 ? height : width };
}

function readInfo(root: SgfNode): GameInfo {
  const komi = Number.parseFloat(single(root, 'KM') ?? '');
  const handicap = Number.parseInt(single(root, 'HA') ?? '', 10);
  return {
    ...optional('blackName', single(root, 'PB')),
    ...optional('whiteName', single(root, 'PW')),
    ...optional('blackRank', single(root, 'BR')),
    ...optional('whiteRank', single(root, 'WR')),
    ...optional('event', single(root, 'EV')),
    ...optional('date', single(root, 'DT')),
    ...optional('result', single(root, 'RE')),
    ...optional('ruleset', single(root, 'RU')),
    komi: Number.isFinite(komi) ? komi : 7.5,
    handicap: Number.isInteger(handicap) ? handicap : 0,
  };
}

/** `exactOptionalPropertyTypes` forbids `{ k: undefined }`, so omit the key instead. */
function optional<K extends string>(key: K, value: string | undefined): { [P in K]?: string } {
  return value === undefined ? ({} as { [P in K]?: string }) : ({ [key]: value } as { [P in K]?: string });
}

function collectSetup(node: SgfNode, into: SetupStone[]): void {
  for (const [prop, color] of [
    ['AB', 'black'],
    ['AW', 'white'],
  ] as const satisfies readonly (readonly [string, Color])[]) {
    for (const raw of node.properties.get(prop) ?? []) {
      for (const vertex of expandPoints(raw)) {
        into.push({ color, vertex });
      }
    }
  }
}

function readMove(node: SgfNode, width: number): Move | undefined {
  for (const [prop, player] of [
    ['B', 'black'],
    ['W', 'white'],
  ] as const satisfies readonly (readonly [string, Color])[]) {
    const raw = node.properties.get(prop)?.[0];
    if (raw === undefined) continue;
    const vertex = parsePoint(raw);
    // Empty value, or "tt" on boards up to 19x19, is the traditional pass.
    if (vertex === undefined || (width <= 19 && vertex.x >= width)) return pass(player);
    return play(player, vertex);
  }
  return undefined;
}

/** SGF point letters: `a`..`z` then `A`..`Z`, origin at the top-left corner. */
function letterValue(ch: string): number | undefined {
  const code = ch.charCodeAt(0);
  if (code >= 97 && code <= 122) return code - 97;
  if (code >= 65 && code <= 90) return code - 65 + 26;
  return undefined;
}

function parsePoint(raw: string): Vertex | undefined {
  if (raw.length < 2) return undefined;
  const x = letterValue(raw.charAt(0));
  const y = letterValue(raw.charAt(1));
  if (x === undefined || y === undefined) return undefined;
  return { x, y };
}

/** Expands a point or an `aa:cc` compressed rectangle into vertices. */
function expandPoints(raw: string): Vertex[] {
  const [fromRaw, toRaw] = raw.split(':');
  const from = parsePoint(fromRaw ?? '');
  if (from === undefined) return [];
  if (toRaw === undefined) return [from];
  const to = parsePoint(toRaw);
  if (to === undefined) return [from];
  const out: Vertex[] = [];
  for (let y = Math.min(from.y, to.y); y <= Math.max(from.y, to.y); y++) {
    for (let x = Math.min(from.x, to.x); x <= Math.max(from.x, to.x); x++) {
      out.push({ x, y });
    }
  }
  return out;
}

function single(node: SgfNode, prop: string): string | undefined {
  const value = node.properties.get(prop)?.[0];
  return value === undefined || value === '' ? undefined : value;
}

/** Recursive-descent reader over the SGF grammar. */
class SgfReader {
  #text: string;
  #pos = 0;

  constructor(text: string) {
    this.#text = text;
  }

  atEnd(): boolean {
    return this.#pos >= this.#text.length;
  }

  skipWhitespace(): void {
    while (this.#pos < this.#text.length && /\s/.test(this.#text.charAt(this.#pos))) {
      this.#pos++;
    }
  }

  /** `GameTree := '(' Sequence GameTree* ')'` */
  readGameTree(): SgfNode {
    this.#expect('(');
    const sequence = this.#readSequence();
    // Chain the sequence, then hang any variation subtrees off the last node.
    const variations: SgfNode[] = [];
    this.skipWhitespace();
    while (this.#peek() === '(') {
      variations.push(this.readGameTree());
      this.skipWhitespace();
    }
    this.#expect(')');

    let tail: SgfNode = { properties: sequence[sequence.length - 1]!.properties, children: variations };
    for (let i = sequence.length - 2; i >= 0; i--) {
      tail = { properties: sequence[i]!.properties, children: [tail] };
    }
    return tail;
  }

  #readSequence(): { properties: ReadonlyMap<string, readonly string[]> }[] {
    const nodes: { properties: ReadonlyMap<string, readonly string[]> }[] = [];
    this.skipWhitespace();
    while (this.#peek() === ';') {
      this.#pos++;
      nodes.push({ properties: this.#readProperties() });
      this.skipWhitespace();
    }
    if (nodes.length === 0) {
      throw new SgfParseError("expected ';' to start a node", this.#pos);
    }
    return nodes;
  }

  #readProperties(): ReadonlyMap<string, readonly string[]> {
    const props = new Map<string, string[]>();
    this.skipWhitespace();
    while (/[A-Za-z]/.test(this.#peek() ?? '')) {
      let ident = '';
      while (/[A-Za-z]/.test(this.#peek() ?? '')) {
        ident += this.#text.charAt(this.#pos++);
      }
      // Lowercase letters in identifiers are an FF[3] relic; normalise them away.
      ident = ident.replace(/[a-z]/g, '');
      const values: string[] = [];
      this.skipWhitespace();
      while (this.#peek() === '[') {
        values.push(this.#readValue());
        this.skipWhitespace();
      }
      if (values.length === 0) {
        throw new SgfParseError(`property ${ident} has no value`, this.#pos);
      }
      const existing = props.get(ident);
      if (existing === undefined) props.set(ident, values);
      else existing.push(...values);
    }
    return props;
  }

  #readValue(): string {
    this.#expect('[');
    let out = '';
    while (this.#pos < this.#text.length) {
      const ch = this.#text.charAt(this.#pos++);
      if (ch === ']') return out;
      if (ch === '\\') {
        const escaped = this.#text.charAt(this.#pos++);
        // A backslash before a newline is a soft line break: both disappear.
        if (escaped === '\n') continue;
        if (escaped === '\r') {
          if (this.#text.charAt(this.#pos) === '\n') this.#pos++;
          continue;
        }
        out += escaped;
        continue;
      }
      out += ch;
    }
    throw new SgfParseError("unterminated property value, expected ']'", this.#pos);
  }

  #peek(): string | undefined {
    return this.#pos < this.#text.length ? this.#text.charAt(this.#pos) : undefined;
  }

  #expect(ch: string): void {
    this.skipWhitespace();
    if (this.#peek() !== ch) {
      throw new SgfParseError(`expected '${ch}' but found '${this.#peek() ?? '<end of input>'}'`, this.#pos);
    }
    this.#pos++;
  }
}
