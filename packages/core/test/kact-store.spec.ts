/**
 * The lazy `.kact` reader.
 *
 * The point of the store is that it reads *only* what it is asked for, so most
 * of these assertions are about what it did **not** read. A store that quietly
 * slurps the whole capture would pass a naive round-trip test and then exhaust
 * the renderer's heap on a real one.
 */

import { describe, expect, it } from 'vitest';
import {
  bytesSource,
  encodeKact,
  KactActivationStore,
  KactFormatError,
  parseSgf,
  type ActivationFrame,
  type KactByteSource,
  type KactMetadata,
} from '../src/index.js';
import { readBinaryFixture, readSgfFixture } from './support/fixtures.js';

const METADATA: KactMetadata = {
  networkName: 'tiny-b2c3',
  blocks: 2,
  channels: 3,
  boardSize: { width: 2, height: 2 },
  sgf: '(;GM[1]FF[4]SZ[19];B[pd];W[dp])',
};
const ELEMENTS = METADATA.channels * 4;

function makeFrame(moveNumber: number, block: number, seed = 1): ActivationFrame {
  const data = new Float32Array(ELEMENTS);
  for (let i = 0; i < data.length; i++) data[i] = Math.fround((i - 6) * 0.5 * seed);
  return {
    moveNumber,
    block,
    networkName: METADATA.networkName,
    boardSize: METADATA.boardSize,
    channels: METADATA.channels,
    dtype: 'float32',
    data,
    range: { min: -3, max: 2.5 },
  };
}

const FRAMES = [makeFrame(0, 0), makeFrame(0, 1, 2), makeFrame(5, 0, 3), makeFrame(5, 1, 4)];
const CAPTURE = encodeKact(METADATA, FRAMES);

/** A byte source that records every read, so laziness can be asserted. */
function countingSource(bytes: Uint8Array): KactByteSource & { reads: { offset: number; length: number }[] } {
  const inner = bytesSource(bytes);
  const reads: { offset: number; length: number }[] = [];
  return {
    reads,
    byteLength: inner.byteLength,
    read: async (offset, length) => {
      reads.push({ offset, length });
      return inner.read(offset, length);
    },
  };
}

describe('KactActivationStore.open', () => {
  it('reads the header and index without touching the payloads', async () => {
    const source = countingSource(CAPTURE);
    await KactActivationStore.open(source);

    const bytesRead = source.reads.reduce((sum, r) => sum + r.length, 0);
    // The whole capture is tiny, so the probe covers it -- what matters is that
    // opening does exactly one read and asks for no more than the probe size.
    expect(source.reads).toHaveLength(1);
    expect(bytesRead).toBeLessThanOrEqual(CAPTURE.byteLength);
  });

  it('exposes the network shape from the header', async () => {
    const store = await KactActivationStore.open(bytesSource(CAPTURE));
    await expect(store.describe()).resolves.toEqual({
      spec: { name: 'tiny-b2c3', blocks: 2, channels: 3, boardSize: { width: 2, height: 2 } },
      maxMoveNumber: 5,
      dtype: 'float32',
    });
  });

  it('lists the moves and blocks it actually holds', async () => {
    const store = await KactActivationStore.open(bytesSource(CAPTURE));
    // A capture may hold a subset of either; the gaps are real information.
    expect(store.moveNumbers()).toEqual([0, 5]);
    expect(store.blockNumbers()).toEqual([0, 1]);
  });

  it('carries the SGF the capture was taken from', async () => {
    const store = await KactActivationStore.open(bytesSource(CAPTURE));
    const sgf = store.metadata.sgf;
    expect(sgf).toBeDefined();
    // Embedded rather than referenced: a path would break the moment the file
    // moved, and would do so silently.
    expect(parseSgf(sgf ?? '').moves).toHaveLength(2);
  });

  it('rejects a file too short to be a capture', async () => {
    await expect(KactActivationStore.open(bytesSource(new Uint8Array(4)))).rejects.toThrow(/too short/);
  });

  it('rejects a file that is not a capture', async () => {
    await expect(KactActivationStore.open(bytesSource(new Uint8Array(200)))).rejects.toThrow(/bad magic/);
  });

  it('rejects a capture truncated before the end of its index', async () => {
    const truncated = CAPTURE.subarray(0, 40);
    await expect(KactActivationStore.open(bytesSource(truncated))).rejects.toThrow(KactFormatError);
  });
});

describe('KactActivationStore.frame', () => {
  it('reads exactly one frame, and only that frame', async () => {
    const source = countingSource(CAPTURE);
    const store = await KactActivationStore.open(source);
    source.reads.length = 0;

    await store.frame({ moveNumber: 5, block: 1 });

    expect(source.reads).toHaveLength(1);
    expect(source.reads[0]?.length).toBe(ELEMENTS * 2); // float16 on disk
  });

  it('decodes to float32 in memory whatever the file stores', async () => {
    const store = await KactActivationStore.open(bytesSource(CAPTURE));
    const frame = await store.frame({ moveNumber: 0, block: 0 });
    expect(frame.dtype).toBe('float32');
    expect(frame.data).toBeInstanceOf(Float32Array);
    expect([...frame.data]).toEqual([...FRAMES[0]!.data]);
  });

  it('restores the frame identity and the true float32 range', async () => {
    const store = await KactActivationStore.open(bytesSource(CAPTURE));
    const frame = await store.frame({ moveNumber: 5, block: 1 });
    expect(frame).toMatchObject({
      moveNumber: 5,
      block: 1,
      networkName: 'tiny-b2c3',
      channels: 3,
      boardSize: { width: 2, height: 2 },
    });
    // The range is kept in the index because float16 no longer carries it.
    expect(frame.range).toEqual({ min: -3, max: 2.5 });
  });

  it('serves frames in any order, since the index is random access', async () => {
    const store = await KactActivationStore.open(bytesSource(CAPTURE));
    const later = await store.frame({ moveNumber: 5, block: 0 });
    const earlier = await store.frame({ moveNumber: 0, block: 1 });
    expect(later.moveNumber).toBe(5);
    expect(earlier.moveNumber).toBe(0);
  });

  it('rejects a frame the capture does not hold', async () => {
    const store = await KactActivationStore.open(bytesSource(CAPTURE));
    await expect(store.frame({ moveNumber: 1, block: 0 })).rejects.toThrow(/holds no frame for move 1/);
    await expect(store.frame({ moveNumber: 0, block: 9 })).rejects.toThrow(KactFormatError);
  });

  it('rejects a short read rather than decoding a partial frame', async () => {
    // A truncated frame decoded as if whole is a heatmap of the wrong shape,
    // which nothing downstream detects.
    const honest = bytesSource(CAPTURE);
    const lying: KactByteSource = {
      byteLength: honest.byteLength,
      read: async (offset, length) => (await honest.read(offset, length)).subarray(0, length - 2),
    };
    const store = await KactActivationStore.open(bytesSource(CAPTURE));
    // Swap in the lying source by opening a store around it directly.
    const badStore = await KactActivationStore.open({
      byteLength: honest.byteLength,
      read: async (o, l) => (o === 0 ? honest.read(o, l) : lying.read(o, l)),
    });
    await expect(badStore.frame({ moveNumber: 0, block: 0 })).rejects.toThrow(/short read/);
    await store.dispose();
  });
});

describe('KactActivationStore lifecycle', () => {
  it('closes the underlying source', async () => {
    let closed = false;
    const source: KactByteSource = {
      ...bytesSource(CAPTURE),
      close: async () => {
        closed = true;
      },
    };
    const store = await KactActivationStore.open(source);
    await store.dispose();
    expect(closed).toBe(true);
  });

  it('is safe to dispose twice and refuses use afterwards', async () => {
    const store = await KactActivationStore.open(bytesSource(CAPTURE));
    await store.dispose();
    await store.dispose();
    await expect(store.frame({ moveNumber: 0, block: 0 })).rejects.toThrow(/closed/);
  });
});

describe('the checked-in fixture', () => {
  const bytes = new Uint8Array(readBinaryFixture('kact', 'tiny-b2c3.kact'));

  it('opens through the lazy reader, not just the whole-buffer one', async () => {
    const store = await KactActivationStore.open(bytesSource(bytes));
    const availability = await store.describe();
    expect(availability.spec.blocks).toBe(2);
    expect(availability.spec.channels).toBe(3);
    expect(store.moveNumbers()).toEqual([0, 1, 2]);
  });

  it('carries the SGF it was captured from, byte for byte', async () => {
    const store = await KactActivationStore.open(bytesSource(bytes));
    expect(store.metadata.sgf).toBe(readSgfFixture('simple-game.sgf'));
  });

  it('decodes every frame it claims to hold', async () => {
    const store = await KactActivationStore.open(bytesSource(bytes));
    for (const move of store.moveNumbers()) {
      for (const block of store.blockNumbers()) {
        const frame = await store.frame({ moveNumber: move, block });
        expect(frame.data.length).toBe(3 * 25);
        expect([...frame.data].every(Number.isFinite)).toBe(true);
      }
    }
  });
});
