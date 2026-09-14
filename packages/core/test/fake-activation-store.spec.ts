import { describe, expect, it } from 'vitest';
import {
  B6C96,
  channelPlane,
  dequantize,
  FakeActivationStore,
  planeLength,
} from '../src/index.js';

describe('FakeActivationStore', () => {
  it('describes a b6c96 net by default', async () => {
    const store = new FakeActivationStore();
    const info = await store.describe();
    expect(info.spec).toEqual(B6C96);
    expect(info.spec.blocks).toBe(6);
    expect(info.spec.channels).toBe(96);
    expect(info.dtype).toBe('float32');
  });

  it('returns a fully populated frame', async () => {
    const store = new FakeActivationStore();
    const frame = await store.frame({ moveNumber: 12, block: 3 });
    expect(frame.moveNumber).toBe(12);
    expect(frame.block).toBe(3);
    expect(frame.channels).toBe(96);
    expect(frame.data).toBeInstanceOf(Float32Array);
    expect(frame.data.length).toBe(96 * 19 * 19);
    expect(frame.range.max).toBeGreaterThan(frame.range.min);
    expect([...frame.data].every(Number.isFinite)).toBe(true);
  });

  it('is deterministic for the same seed and key', async () => {
    const a = await new FakeActivationStore({ seed: 7 }).frame({ moveNumber: 4, block: 1 });
    const b = await new FakeActivationStore({ seed: 7 }).frame({ moveNumber: 4, block: 1 });
    expect([...a.data]).toEqual([...b.data]);
  });

  it('varies with the key and with the seed', async () => {
    const base = await new FakeActivationStore({ seed: 7 }).frame({ moveNumber: 4, block: 1 });
    const otherMove = await new FakeActivationStore({ seed: 7 }).frame({ moveNumber: 5, block: 1 });
    const otherSeed = await new FakeActivationStore({ seed: 8 }).frame({ moveNumber: 4, block: 1 });
    expect([...base.data]).not.toEqual([...otherMove.data]);
    expect([...base.data]).not.toEqual([...otherSeed.data]);
  });

  it('rejects out-of-range keys', async () => {
    const store = new FakeActivationStore({ maxMoveNumber: 10 });
    await expect(store.frame({ moveNumber: 0, block: 6 })).rejects.toThrow(RangeError);
    await expect(store.frame({ moveNumber: 11, block: 0 })).rejects.toThrow(RangeError);
    await expect(store.frame({ moveNumber: -1, block: 0 })).rejects.toThrow(RangeError);
  });

  it('quantises to uint8 on request, preserving the float range', async () => {
    const store = new FakeActivationStore({ dtype: 'uint8' });
    const frame = await store.frame({ moveNumber: 0, block: 5 });
    expect(frame.data).toBeInstanceOf(Uint8Array);
    expect(frame.data.length).toBe(96 * 19 * 19);
    expect(Math.max(...frame.data)).toBe(255);
    expect(dequantize(frame, 255)).toBeCloseTo(frame.range.max, 5);
    expect(dequantize(frame, 0)).toBeCloseTo(frame.range.min, 5);
  });

  it('rejects use after dispose', async () => {
    const store = new FakeActivationStore();
    await store.dispose();
    await store.dispose();
    await expect(store.describe()).rejects.toThrow(/disposed/);
  });
});

describe('channelPlane', () => {
  it('views one channel without copying', async () => {
    const frame = await new FakeActivationStore().frame({ moveNumber: 0, block: 0 });
    const area = planeLength(frame);
    expect(area).toBe(361);
    const plane = channelPlane(frame, 2);
    expect(plane.length).toBe(area);
    expect(plane[0]).toBe(frame.data[2 * area]);
    expect(plane.buffer).toBe(frame.data.buffer);
  });

  it('rejects channels outside the frame', async () => {
    const frame = await new FakeActivationStore().frame({ moveNumber: 0, block: 0 });
    expect(() => channelPlane(frame, 96)).toThrow(RangeError);
    expect(() => channelPlane(frame, -1)).toThrow(RangeError);
  });
});
