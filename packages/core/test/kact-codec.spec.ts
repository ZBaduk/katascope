/**
 * `.kact` codec.
 *
 * Per CLAUDE.md a codec is not merged without a round-trip test plus rejection
 * tests for truncated and corrupt input, because a codec that silently returns
 * the wrong numbers is worse than one that crashes.
 */

import { describe, expect, it } from 'vitest';
import {
  encodeKact,
  FLOAT16_MAX,
  frameByteRange,
  fromFloat16Bits,
  KACT_VERSION,
  kactMoveNumbers,
  kactNetworkSpec,
  KactFormatError,
  readKactFrame,
  readKactIndex,
  squareBoardSize,
  toFloat16Bits,
  type ActivationFrame,
  type KactMetadata,
} from '../src/index.js';
import { readBinaryFixture } from './support/fixtures.js';

const METADATA: KactMetadata = {
  networkName: 'tiny-b2c3',
  blocks: 2,
  channels: 3,
  boardSize: { width: 2, height: 2 },
  source: 'simple-game.sgf',
  createdAt: '2026-09-14T00:00:00.000Z',
};

const AREA = 4;
const FRAME_ELEMENTS = METADATA.channels * AREA; // 12

function makeFrame(moveNumber: number, block: number, seed = 1): ActivationFrame {
  const data = new Float32Array(FRAME_ELEMENTS);
  for (let i = 0; i < data.length; i++) {
    // Values chosen to be exactly representable in float16, so the round-trip
    // assertion is about the container rather than about rounding.
    data[i] = Math.fround((i - 6) * 0.5 * seed);
  }
  let min = Infinity;
  let max = -Infinity;
  for (const value of data) {
    min = Math.min(min, value);
    max = Math.max(max, value);
  }
  return {
    moveNumber,
    block,
    networkName: METADATA.networkName,
    boardSize: METADATA.boardSize,
    channels: METADATA.channels,
    dtype: 'float32',
    data,
    range: { min, max },
  };
}

describe('float16 conversion', () => {
  it('round-trips values that half precision represents exactly', () => {
    for (const value of [0, 1, -1, 0.5, -0.5, 2, 1024, -2048, 0.0625]) {
      expect(fromFloat16Bits(toFloat16Bits(value))).toBe(value);
    }
  });

  it('preserves the sign of zero-adjacent values', () => {
    expect(fromFloat16Bits(toFloat16Bits(0))).toBe(0);
    expect(Object.is(fromFloat16Bits(toFloat16Bits(-0)), -0)).toBe(true);
  });

  it('keeps about three decimal digits', () => {
    for (const value of [0.1, -3.14159, 12.345, 1000.5]) {
      expect(fromFloat16Bits(toFloat16Bits(value))).toBeCloseTo(value, 2);
    }
  });

  it('clamps rather than overflowing to Infinity', () => {
    // An infinite cell renders as a blank heatmap, which reads as a bug in the
    // renderer rather than in the data.
    expect(fromFloat16Bits(toFloat16Bits(1e6))).toBe(FLOAT16_MAX);
    expect(fromFloat16Bits(toFloat16Bits(-1e6))).toBe(-FLOAT16_MAX);
    expect(fromFloat16Bits(toFloat16Bits(Infinity))).toBe(FLOAT16_MAX);
  });

  it('keeps NaN as NaN', () => {
    expect(Number.isNaN(fromFloat16Bits(toFloat16Bits(Number.NaN)))).toBe(true);
  });

  it('flushes values below the subnormal range to zero', () => {
    expect(fromFloat16Bits(toFloat16Bits(1e-10))).toBe(0);
  });
});

describe('encodeKact / readKactIndex', () => {
  const frames = [makeFrame(0, 0), makeFrame(0, 1), makeFrame(3, 0, 2), makeFrame(3, 1, 3)];
  const bytes = encodeKact(METADATA, frames);

  it('writes a recognisable header', () => {
    expect(String.fromCharCode(...bytes.subarray(0, 4))).toBe('KACT');
    const file = readKactIndex(bytes);
    expect(file.version).toBe(KACT_VERSION);
    expect(file.metadata).toEqual(METADATA);
  });

  it('stores float16, so a frame is two bytes an element', () => {
    const file = readKactIndex(bytes);
    for (const entry of file.index) {
      expect(entry.byteLength).toBe(FRAME_ELEMENTS * 2);
    }
  });

  it('indexes every frame with a byte range inside the file', () => {
    const file = readKactIndex(bytes);
    expect(file.index).toHaveLength(4);
    for (const entry of file.index) {
      expect(entry.byteOffset).toBeGreaterThan(0);
      expect(entry.byteOffset + entry.byteLength).toBeLessThanOrEqual(bytes.byteLength);
    }
  });

  it('records the true float32 range, which float16 no longer carries', () => {
    const file = readKactIndex(bytes);
    const entry = frameByteRange(file, { moveNumber: 3, block: 1 });
    expect(entry?.min).toBeCloseTo(frames[3]!.range.min, 5);
    expect(entry?.max).toBeCloseTo(frames[3]!.range.max, 5);
    expect(entry?.min).not.toBe(entry?.max);
  });

  it('lists the move numbers it holds', () => {
    expect(kactMoveNumbers(readKactIndex(bytes))).toEqual([0, 3]);
  });

  it('rebuilds a NetworkSpec from the header', () => {
    expect(kactNetworkSpec(readKactIndex(bytes).metadata)).toEqual({
      name: 'tiny-b2c3',
      blocks: 2,
      channels: 3,
      boardSize: { width: 2, height: 2 },
    });
  });
});

describe('readKactFrame', () => {
  const frames = [makeFrame(0, 0), makeFrame(0, 1), makeFrame(3, 0, 2)];
  const bytes = encodeKact(METADATA, frames);

  it('round-trips a frame through the container', () => {
    const decoded = readKactFrame(bytes, { moveNumber: 3, block: 0 });
    expect(decoded.data).toBeInstanceOf(Float32Array);
    expect([...decoded.data]).toEqual([...frames[2]!.data]);
  });

  it('returns float32 in memory whatever the file holds', () => {
    const decoded = readKactFrame(bytes, { moveNumber: 0, block: 0 });
    expect(decoded.dtype).toBe('float32');
    expect(decoded.data).toBeInstanceOf(Float32Array);
  });

  it('restores the frame identity and shape', () => {
    const decoded = readKactFrame(bytes, { moveNumber: 0, block: 1 });
    expect(decoded).toMatchObject({
      moveNumber: 0,
      block: 1,
      networkName: 'tiny-b2c3',
      channels: 3,
      boardSize: { width: 2, height: 2 },
    });
    expect(decoded.data.length).toBe(FRAME_ELEMENTS);
  });

  it('reads one frame without needing the others', () => {
    // The whole point of the index: a reader seeks to the frame it wants.
    const file = readKactIndex(bytes);
    const entry = frameByteRange(file, { moveNumber: 0, block: 1 });
    expect(entry).toBeDefined();
    expect(entry?.byteLength).toBe(FRAME_ELEMENTS * 2);
    const decoded = readKactFrame(bytes, { moveNumber: 0, block: 1 }, file);
    expect([...decoded.data]).toEqual([...frames[1]!.data]);
  });

  it('rejects a frame that is not in the capture', () => {
    expect(() => readKactFrame(bytes, { moveNumber: 99, block: 0 })).toThrow(KactFormatError);
    expect(() => readKactFrame(bytes, { moveNumber: 0, block: 7 })).toThrow(/no frame for move/);
  });
});

describe('rejecting bad input', () => {
  const bytes = encodeKact(METADATA, [makeFrame(0, 0)]);

  it('rejects a file that is not .kact', () => {
    const junk = new Uint8Array(64);
    expect(() => readKactIndex(junk)).toThrow(/bad magic/);
  });

  it('rejects a file too short to hold a header', () => {
    expect(() => readKactIndex(bytes.subarray(0, 6))).toThrow(/too short/);
  });

  it('rejects an unsupported version', () => {
    const tampered = bytes.slice();
    new DataView(tampered.buffer).setUint16(4, 99, true);
    expect(() => readKactIndex(tampered)).toThrow(/unsupported version 99/);
  });

  it('rejects unknown flags rather than ignoring them', () => {
    const tampered = bytes.slice();
    new DataView(tampered.buffer).setUint16(6, 1, true);
    expect(() => readKactIndex(tampered)).toThrow(/unsupported flags/);
  });

  it('rejects truncation partway through the payloads', () => {
    expect(() => readKactIndex(bytes.subarray(0, bytes.byteLength - 4))).toThrow(/truncated/);
  });

  it('rejects a corrupt JSON header', () => {
    const tampered = bytes.slice();
    // Header JSON starts right after the 12-byte fixed prefix.
    tampered[12] = 0x7b; // '{' where '{' already was, then break the next byte
    tampered[13] = 0x00;
    expect(() => readKactIndex(tampered)).toThrow(/not valid JSON/);
  });
});

describe('encode validation', () => {
  it('rejects a frame whose channel count contradicts the capture', () => {
    const wrong = { ...makeFrame(0, 0), channels: 4 };
    expect(() => encodeKact(METADATA, [wrong])).toThrow(/has 4 channels/);
  });

  it('rejects a frame whose element count contradicts the board size', () => {
    const wrong = { ...makeFrame(0, 0), data: new Float32Array(5) };
    expect(() => encodeKact(METADATA, [wrong])).toThrow(/expected 12/);
  });

  it('rejects a block outside the network', () => {
    expect(() => encodeKact(METADATA, [makeFrame(0, 5)])).toThrow(/outside 0\.\.1/);
  });

  it('rejects the same (move, block) twice', () => {
    expect(() => encodeKact(METADATA, [makeFrame(1, 0), makeFrame(1, 0)])).toThrow(/appears twice/);
  });

  it('accepts an empty capture', () => {
    const empty = encodeKact(METADATA, []);
    expect(readKactIndex(empty).index).toEqual([]);
  });

  it('encodes a 19x19 b6c96 frame at the expected size', () => {
    // Sanity on the real shape: 96 channels x 361 points x 2 bytes.
    const spec: KactMetadata = {
      networkName: 'b6c96',
      blocks: 6,
      channels: 96,
      boardSize: squareBoardSize(19),
    };
    const frame: ActivationFrame = {
      moveNumber: 0,
      block: 0,
      networkName: 'b6c96',
      boardSize: spec.boardSize,
      channels: 96,
      dtype: 'float32',
      data: new Float32Array(96 * 361),
      range: { min: 0, max: 0 },
    };
    const encoded = encodeKact(spec, [frame]);
    const entry = readKactIndex(encoded).index[0];
    expect(entry?.byteLength).toBe(96 * 361 * 2);
  });
});

describe('the checked-in fixture', () => {
  /**
   * A real file on disk, not one this test just built. An encoder and a decoder
   * that agree with each other but not with the format on disk is exactly the
   * failure a same-process round trip cannot see -- so the fixture is committed
   * and read back byte for byte.
   */
  const bytes = new Uint8Array(readBinaryFixture('kact', 'tiny-b2c3.kact'));

  it('parses, and says what it holds', () => {
    const file = readKactIndex(bytes);
    expect(file.version).toBe(KACT_VERSION);
    expect(file.metadata.networkName).toBe('fixture-b2c3');
    expect(file.metadata.blocks).toBe(2);
    expect(file.metadata.channels).toBe(3);
    expect(file.metadata.boardSize).toEqual({ width: 5, height: 5 });
    expect(file.index).toHaveLength(6);
    expect(kactMoveNumbers(file)).toEqual([0, 1, 2]);
  });

  it('decodes every frame it claims to hold', () => {
    const file = readKactIndex(bytes);
    for (const entry of file.index) {
      const frame = readKactFrame(bytes, entry, file);
      expect(frame.data.length).toBe(3 * 25);
      expect([...frame.data].every(Number.isFinite)).toBe(true);
    }
  });

  it('re-encodes to the same bytes it was read from', () => {
    // Pins the on-disk layout: a change to field order, padding or the index
    // entry size fails here even if encode and decode still agree.
    const file = readKactIndex(bytes);
    const frames = file.index.map((entry) => readKactFrame(bytes, entry, file));
    const reencoded = encodeKact(file.metadata, frames);
    expect([...reencoded]).toEqual([...bytes]);
  });

  it('holds values that survived the float16 round trip', () => {
    const frame = readKactFrame(bytes, { moveNumber: 1, block: 1 });
    expect(frame.range.max).toBeGreaterThan(frame.range.min);
    // Stored as float16, so every value must be exactly representable there.
    for (const value of frame.data) {
      expect(fromFloat16Bits(toFloat16Bits(value))).toBe(value);
    }
  });
});
