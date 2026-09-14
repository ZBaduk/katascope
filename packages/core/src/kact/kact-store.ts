/**
 * An `ActivationStore` that reads a `.kact` capture lazily.
 *
 * A capture is far larger than a renderer wants resident -- a 200-move b18c384
 * game is about a gigabyte on disk -- so nothing is read until a frame is
 * asked for, and then only that frame's byte range. The index makes that
 * possible: every frame's offset and length is in the header.
 *
 * Core cannot open a file, so the bytes arrive through `KactByteSource`. Node
 * supplies a file-handle implementation; tests supply an array. That keeps the
 * seek-and-decode logic here, where it is pure and testable, rather than in the
 * bridge where it would need a real file to exercise.
 */

import type {
  ActivationAvailability,
  ActivationFrame,
  ActivationKey,
  ActivationStore,
} from '../domain/activation.js';
import { decodeFloat16Array } from './float16.js';
import {
  frameByteRange,
  kactMoveNumbers,
  kactNetworkSpec,
  KactFormatError,
  readKactIndex,
  type KactFile,
  type KactMetadata,
} from './codec.js';

/**
 * Random access to a capture's bytes.
 *
 * `read` must return exactly `length` bytes starting at `offset`, and must
 * reject rather than return a short read -- a truncated frame decoded as if it
 * were whole is a heatmap of the wrong shape, which nothing downstream detects.
 */
export interface KactByteSource {
  readonly byteLength: number;
  read(offset: number, length: number): Promise<Uint8Array>;
  close?(): Promise<void>;
}

/** Serves a whole capture already in memory. Used by tests and by small files. */
export function bytesSource(bytes: Uint8Array): KactByteSource {
  return {
    byteLength: bytes.byteLength,
    read: async (offset, length) => {
      if (offset < 0 || length < 0 || offset + length > bytes.byteLength) {
        throw new KactFormatError(`read of ${length} bytes at ${offset} is outside the capture`);
      }
      return bytes.subarray(offset, offset + length);
    },
  };
}

/** How much of the file to pull in the first read while hunting for the index. */
const HEADER_PROBE_BYTES = 64 * 1024;

export class KactActivationStore implements ActivationStore {
  readonly #source: KactByteSource;
  #file: KactFile | undefined;
  #disposed = false;

  private constructor(source: KactByteSource, file: KactFile) {
    this.#source = source;
    this.#file = file;
  }

  /** Reads the header and index. The payloads stay on disk. */
  static async open(source: KactByteSource): Promise<KactActivationStore> {
    const file = await readIndexFrom(source);
    return new KactActivationStore(source, file);
  }

  /** Header and index, for callers that want the move list or the embedded SGF. */
  get file(): KactFile {
    if (this.#file === undefined) throw new KactFormatError('capture has been closed');
    return this.#file;
  }

  get metadata(): KactMetadata {
    return this.file.metadata;
  }

  /** Move numbers the capture holds, ascending. Not necessarily contiguous. */
  moveNumbers(): readonly number[] {
    return kactMoveNumbers(this.file);
  }

  /** Blocks the capture holds, ascending. A capture may hold a subset. */
  blockNumbers(): readonly number[] {
    return [...new Set(this.file.index.map((entry) => entry.block))].sort((a, b) => a - b);
  }

  async describe(): Promise<ActivationAvailability> {
    const moves = this.moveNumbers();
    return {
      spec: kactNetworkSpec(this.metadata),
      maxMoveNumber: moves.length === 0 ? 0 : Math.max(...moves),
      dtype: 'float32',
    };
  }

  async frame(key: ActivationKey): Promise<ActivationFrame> {
    const file = this.file;
    const entry = frameByteRange(file, key);
    if (entry === undefined) {
      throw new KactFormatError(`capture holds no frame for move ${key.moveNumber}, block ${key.block}`);
    }
    const { metadata } = file;
    const count = metadata.channels * metadata.boardSize.width * metadata.boardSize.height;
    if (entry.byteLength !== count * 2) {
      throw new KactFormatError(
        `frame (${key.moveNumber}, ${key.block}) is ${entry.byteLength} bytes, expected ${count * 2}`,
      );
    }

    const payload = await this.#source.read(entry.byteOffset, entry.byteLength);
    if (payload.byteLength !== entry.byteLength) {
      throw new KactFormatError(
        `short read for frame (${key.moveNumber}, ${key.block}): ${payload.byteLength} of ${entry.byteLength} bytes`,
      );
    }

    return {
      moveNumber: entry.moveNumber,
      block: entry.block,
      networkName: metadata.networkName,
      boardSize: metadata.boardSize,
      channels: metadata.channels,
      // float16 on disk, float32 in memory: the conversion happens here so
      // nothing downstream learns the file's storage format.
      dtype: 'float32',
      data: decodeFloat16Array(payload, count),
      range: { min: entry.min, max: entry.max },
    };
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#file = undefined;
    await this.#source.close?.();
  }
}

/**
 * Reads the header and index without pulling in the payloads.
 *
 * The index's length is not known until the header JSON has been read, so this
 * probes a prefix, works out how much it actually needs, and reads again only
 * if the probe fell short. Two reads at worst, for a file that may be gigabytes.
 */
async function readIndexFrom(source: KactByteSource): Promise<KactFile> {
  const probeLength = Math.min(HEADER_PROBE_BYTES, source.byteLength);
  if (probeLength < 12) {
    throw new KactFormatError(`file is ${source.byteLength} bytes, too short to hold a header`);
  }
  const probe = await source.read(0, probeLength);

  const view = new DataView(probe.buffer, probe.byteOffset, probe.byteLength);
  const jsonLength = view.getUint32(8, true);
  const countOffset = 12 + jsonLength;
  // 12-byte prefix + JSON + the 4-byte frame count + the index itself.
  let needed = countOffset + 4;
  if (probe.byteLength >= needed) {
    const count = new DataView(probe.buffer, probe.byteOffset, probe.byteLength).getUint32(
      countOffset,
      true,
    );
    needed += count * 28;
  } else {
    // The JSON alone overflowed the probe; read what the header claims and retry.
    needed = Math.min(source.byteLength, countOffset + 4);
  }

  if (needed > source.byteLength) {
    throw new KactFormatError(`truncated: header claims ${needed} bytes, file has ${source.byteLength}`);
  }
  const head = probe.byteLength >= needed ? probe.subarray(0, needed) : await source.read(0, needed);
  // `readKactIndex` validates magic, version, flags and every entry's range --
  // against the whole file's length, since `head` holds no payloads.
  return readKactIndex(head, source.byteLength);
}
