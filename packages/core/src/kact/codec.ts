/**
 * The `.kact` container: captured activation frames on disk.
 *
 * A capture is large -- a b18c384 net is 384 x 361 floats per block, and a
 * 200-move game across 18 blocks is about 2 GB in float32. Two decisions follow
 * from that:
 *
 * * **float16 on disk, float32 in memory.** Halves the file for roughly 3.3
 *   decimal digits, which is far more than a heatmap can show. The conversion
 *   happens here so nothing else has to know.
 * * **An index, so a reader can fetch one (move, block) without parsing the
 *   rest.** Every section's byte range is in the header, so the UI seeks
 *   directly to the frame it wants. `frameByteRange` gives a Node caller the
 *   offsets for a ranged read.
 *
 * Layout, all integers little-endian:
 *
 *     magic      4  "KACT"
 *     version    2  u16, currently 1
 *     flags      2  u16, reserved, must be 0
 *     jsonLen    4  u32   \
 *     json    jsonLen     | header: network shape and capture metadata
 *     entries    4  u32   /
 *     index   entries * 28 bytes
 *     payloads   float16 planes, in index order
 *
 * Each 28-byte index entry:
 *
 *     moveNumber 4  u32
 *     block      4  u32
 *     offset     8  f64 (an integer byte offset; f64 is exact past 2^32)
 *     length     4  u32  bytes of float16 payload
 *     min        4  f32  \ the frame's true float32 range, kept because the
 *     max        4  f32  / stored float16 no longer carries it exactly
 */

import type { BoardSize } from '../domain/board.js';
import type { ActivationFrame, ActivationKey } from '../domain/activation.js';
import type { NetworkSpec } from '../domain/network-spec.js';
import { decodeFloat16Array, encodeFloat16Array } from './float16.js';

export const KACT_MAGIC = 'KACT';
export const KACT_VERSION = 1;

const MAGIC_BYTES = [0x4b, 0x41, 0x43, 0x54] as const; // "KACT"
const INDEX_ENTRY_BYTES = 28;
const FIXED_PREFIX_BYTES = 4 + 2 + 2 + 4; // magic + version + flags + jsonLen

/**
 * Serialises the header as pure-ASCII JSON.
 *
 * `core` targets no platform lib, so `TextEncoder` is out of scope -- the same
 * constraint that keeps `node:fs` out. Escaping every non-ASCII character as
 * `\uXXXX` makes the byte length equal the character length and leaves
 * `JSON.parse` to put the text back together, surrogate pairs included.
 */
function encodeAsciiJson(value: unknown): Uint8Array {
  const text = JSON.stringify(value).replace(/[\u0080-\uffff]/g, (character) =>
    `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0x7f;
  return out;
}

function decodeAsciiJson(bytes: Uint8Array): KactMetadata {
  let text = '';
  for (const byte of bytes) text += String.fromCharCode(byte);
  return JSON.parse(text) as KactMetadata;
}

export class KactFormatError extends Error {
  constructor(message: string) {
    super(`.kact: ${message}`);
    this.name = 'KactFormatError';
  }
}

/** Capture metadata, stored as JSON so the format can grow without a version bump. */
export interface KactMetadata {
  readonly networkName: string;
  readonly blocks: number;
  readonly channels: number;
  readonly boardSize: BoardSize;
  /** Where the capture came from, e.g. an SGF filename. Free text. */
  readonly source?: string;
  /** ISO 8601, when the capture was written. */
  readonly createdAt?: string;
  /**
   * The **full SGF text** of the game the capture was taken from.
   *
   * Embedded rather than referenced, deliberately. A capture without its game
   * is a pile of numbers with no positions attached: the move slider has
   * nothing to label, the board beside an enlarged plane has no stones, and
   * "move 47" means nothing. A path reference would break the moment the file
   * moved or was sent to someone else, and would do so silently -- the capture
   * would still open, just with no board. An SGF is a few kilobytes against a
   * capture of tens of megabytes, so the copy costs nothing worth counting.
   *
   * Optional only because captures written before this field existed are still
   * readable; a reader must cope with its absence.
   */
  readonly sgf?: string;
}

/** One frame's location in the file. */
export interface KactIndexEntry extends ActivationKey {
  readonly byteOffset: number;
  readonly byteLength: number;
  readonly min: number;
  readonly max: number;
}

/** A parsed file's header and index, without any payload. */
export interface KactFile {
  readonly version: number;
  readonly metadata: KactMetadata;
  readonly index: readonly KactIndexEntry[];
}

/** Builds a `NetworkSpec` from a capture's metadata. */
export function kactNetworkSpec(metadata: KactMetadata): NetworkSpec {
  return {
    name: metadata.networkName,
    blocks: metadata.blocks,
    channels: metadata.channels,
    boardSize: metadata.boardSize,
  };
}

/**
 * Encodes frames into a `.kact` buffer.
 *
 * Frames may arrive in any order; they are written in the order given and the
 * index records where each landed. Every frame must match `metadata`'s network
 * shape -- a capture with mixed shapes has no coherent reader.
 */
export function encodeKact(
  metadata: KactMetadata,
  frames: readonly ActivationFrame[],
): Uint8Array {
  const area = metadata.boardSize.width * metadata.boardSize.height;
  const expected = metadata.channels * area;

  const seen = new Set<string>();
  for (const frame of frames) {
    if (frame.channels !== metadata.channels) {
      throw new KactFormatError(
        `frame (${frame.moveNumber}, ${frame.block}) has ${frame.channels} channels, capture has ${metadata.channels}`,
      );
    }
    if (frame.data.length !== expected) {
      throw new KactFormatError(
        `frame (${frame.moveNumber}, ${frame.block}) has ${frame.data.length} elements, expected ${expected}`,
      );
    }
    if (frame.block < 0 || frame.block >= metadata.blocks) {
      throw new KactFormatError(`frame block ${frame.block} outside 0..${metadata.blocks - 1}`);
    }
    const key = `${frame.moveNumber}:${frame.block}`;
    if (seen.has(key)) {
      throw new KactFormatError(`frame (${frame.moveNumber}, ${frame.block}) appears twice`);
    }
    seen.add(key);
  }

  const json = encodeAsciiJson(metadata);
  const indexBytes = frames.length * INDEX_ENTRY_BYTES;
  const payloadBytes = frames.length * expected * 2;
  const total = FIXED_PREFIX_BYTES + json.length + 4 + indexBytes + payloadBytes;

  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  let at = 0;

  for (const byte of MAGIC_BYTES) out[at++] = byte;
  view.setUint16(at, KACT_VERSION, true);
  at += 2;
  view.setUint16(at, 0, true); // flags
  at += 2;
  view.setUint32(at, json.length, true);
  at += 4;
  out.set(json, at);
  at += json.length;
  view.setUint32(at, frames.length, true);
  at += 4;

  const indexAt = at;
  let payloadAt = indexAt + indexBytes;

  for (const [i, frame] of frames.entries()) {
    const encoded = encodeFloat16Array(frame.data instanceof Float32Array
      ? frame.data
      : Float32Array.from(frame.data));
    out.set(encoded, payloadAt);

    const entryAt = indexAt + i * INDEX_ENTRY_BYTES;
    view.setUint32(entryAt, frame.moveNumber, true);
    view.setUint32(entryAt + 4, frame.block, true);
    view.setFloat64(entryAt + 8, payloadAt, true);
    view.setUint32(entryAt + 16, encoded.length, true);
    view.setFloat32(entryAt + 20, frame.range.min, true);
    view.setFloat32(entryAt + 24, frame.range.max, true);
    payloadAt += encoded.length;
  }

  return out;
}

/**
 * Plans a capture's layout before any frame exists.
 *
 * `encodeKact` needs every frame in memory at once, which a real capture cannot
 * afford -- a 200-move game of a b18c384 net is about 2 GB in float32 and 1 GB
 * on disk. Every frame in a capture is the same size, so the whole layout is
 * known from the keys alone: a writer can emit the header, then stream one
 * frame at a time, then patch each index entry's range in place.
 *
 * The returned entries carry a placeholder range of 0..0. Write the real one
 * with `kactIndexEntryBytes` at `indexOffset + i * KACT_INDEX_ENTRY_BYTES`.
 */
export function planKact(metadata: KactMetadata, keys: readonly ActivationKey[]): KactPlan {
  const area = metadata.boardSize.width * metadata.boardSize.height;
  const frameBytes = metadata.channels * area * 2;

  const json = encodeAsciiJson(metadata);
  const indexOffset = FIXED_PREFIX_BYTES + json.length + 4;
  const header = new Uint8Array(indexOffset + keys.length * INDEX_ENTRY_BYTES);
  const view = new DataView(header.buffer);

  let at = 0;
  for (const byte of MAGIC_BYTES) header[at++] = byte;
  view.setUint16(at, KACT_VERSION, true);
  at += 2;
  view.setUint16(at, 0, true);
  at += 2;
  view.setUint32(at, json.length, true);
  at += 4;
  header.set(json, at);
  at += json.length;
  view.setUint32(at, keys.length, true);

  const entries: KactIndexEntry[] = [];
  let payloadAt = header.length;
  for (const [i, key] of keys.entries()) {
    const entry: KactIndexEntry = {
      moveNumber: key.moveNumber,
      block: key.block,
      byteOffset: payloadAt,
      byteLength: frameBytes,
      min: 0,
      max: 0,
    };
    entries.push(entry);
    header.set(kactIndexEntryBytes(entry), indexOffset + i * INDEX_ENTRY_BYTES);
    payloadAt += frameBytes;
  }

  return {
    header,
    entries,
    indexOffset,
    frameBytes,
    totalBytes: payloadAt,
  };
}

/** The layout of a capture that is being streamed to disk. */
export interface KactPlan {
  /** Everything before the first payload: prefix, header JSON, and the index. */
  readonly header: Uint8Array;
  /** One entry per key, in write order, with a placeholder 0..0 range. */
  readonly entries: readonly KactIndexEntry[];
  /** Byte offset of the first index entry, for patching ranges in place. */
  readonly indexOffset: number;
  /** Bytes each frame's payload occupies. Every frame is the same size. */
  readonly frameBytes: number;
  readonly totalBytes: number;
}

/** Size of one index entry, for a writer patching entries in place. */
export const KACT_INDEX_ENTRY_BYTES = INDEX_ENTRY_BYTES;

/** Serialises one index entry, so a streaming writer can rewrite its range. */
export function kactIndexEntryBytes(entry: KactIndexEntry): Uint8Array {
  const out = new Uint8Array(INDEX_ENTRY_BYTES);
  const view = new DataView(out.buffer);
  view.setUint32(0, entry.moveNumber, true);
  view.setUint32(4, entry.block, true);
  view.setFloat64(8, entry.byteOffset, true);
  view.setUint32(16, entry.byteLength, true);
  view.setFloat32(20, entry.min, true);
  view.setFloat32(24, entry.max, true);
  return out;
}

/** Encodes one frame's planes to the float16 bytes a capture stores. */
export function encodeKactFrameData(frame: ActivationFrame): Uint8Array {
  return encodeFloat16Array(
    frame.data instanceof Float32Array ? frame.data : Float32Array.from(frame.data),
  );
}

/**
 * Parses the header and index. Cheap: it never touches the payloads.
 *
 * `totalByteLength` is the size of the whole capture, which is only different
 * from `bytes.byteLength` when a lazy reader has supplied just the header --
 * the index's frame ranges point into payloads that prefix does not contain,
 * and validating them against the prefix would reject every real capture.
 */
export function readKactIndex(bytes: Uint8Array, totalByteLength = bytes.byteLength): KactFile {
  if (bytes.byteLength < FIXED_PREFIX_BYTES) {
    throw new KactFormatError(`file is ${bytes.byteLength} bytes, too short to hold a header`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  for (const [i, expected] of MAGIC_BYTES.entries()) {
    if (bytes[i] !== expected) {
      throw new KactFormatError('bad magic; this is not a .kact file');
    }
  }
  const version = view.getUint16(4, true);
  if (version !== KACT_VERSION) {
    throw new KactFormatError(`unsupported version ${version}, this build reads ${KACT_VERSION}`);
  }
  const flags = view.getUint16(6, true);
  if (flags !== 0) throw new KactFormatError(`unsupported flags 0x${flags.toString(16)}`);

  const jsonLength = view.getUint32(8, true);
  const jsonAt = FIXED_PREFIX_BYTES;
  if (jsonAt + jsonLength + 4 > bytes.byteLength) {
    throw new KactFormatError('truncated before the end of the header');
  }

  let metadata: KactMetadata;
  try {
    metadata = decodeAsciiJson(bytes.subarray(jsonAt, jsonAt + jsonLength));
  } catch (error) {
    throw new KactFormatError(`header is not valid JSON: ${(error as Error).message}`);
  }

  const countAt = jsonAt + jsonLength;
  const count = view.getUint32(countAt, true);
  const indexAt = countAt + 4;
  if (indexAt + count * INDEX_ENTRY_BYTES > bytes.byteLength) {
    throw new KactFormatError(`truncated: index claims ${count} frames that do not fit`);
  }

  const index: KactIndexEntry[] = [];
  for (let i = 0; i < count; i++) {
    const at = indexAt + i * INDEX_ENTRY_BYTES;
    const entry: KactIndexEntry = {
      moveNumber: view.getUint32(at, true),
      block: view.getUint32(at + 4, true),
      byteOffset: view.getFloat64(at + 8, true),
      byteLength: view.getUint32(at + 16, true),
      min: view.getFloat32(at + 20, true),
      max: view.getFloat32(at + 24, true),
    };
    if (entry.byteOffset + entry.byteLength > totalByteLength) {
      throw new KactFormatError(
        `truncated: frame (${entry.moveNumber}, ${entry.block}) runs past the end of the file`,
      );
    }
    index.push(entry);
  }

  return { version, metadata, index };
}

/** Finds a frame's byte range, for a caller that can read part of a file. */
export function frameByteRange(file: KactFile, key: ActivationKey): KactIndexEntry | undefined {
  return file.index.find(
    (entry) => entry.moveNumber === key.moveNumber && entry.block === key.block,
  );
}

/** Every move number present, ascending. */
export function kactMoveNumbers(file: KactFile): readonly number[] {
  return [...new Set(file.index.map((entry) => entry.moveNumber))].sort((a, b) => a - b);
}

/** Decodes one frame, converting the stored float16 planes back to float32. */
export function readKactFrame(bytes: Uint8Array, key: ActivationKey, file?: KactFile): ActivationFrame {
  const parsed = file ?? readKactIndex(bytes);
  const entry = frameByteRange(parsed, key);
  if (entry === undefined) {
    throw new KactFormatError(`no frame for move ${key.moveNumber}, block ${key.block}`);
  }
  const { metadata } = parsed;
  const area = metadata.boardSize.width * metadata.boardSize.height;
  const count = metadata.channels * area;
  if (entry.byteLength !== count * 2) {
    throw new KactFormatError(
      `frame (${key.moveNumber}, ${key.block}) is ${entry.byteLength} bytes, expected ${count * 2}`,
    );
  }

  const payload = bytes.subarray(entry.byteOffset, entry.byteOffset + entry.byteLength);
  return {
    moveNumber: entry.moveNumber,
    block: entry.block,
    networkName: metadata.networkName,
    boardSize: metadata.boardSize,
    channels: metadata.channels,
    dtype: 'float32',
    data: decodeFloat16Array(payload, count),
    range: { min: entry.min, max: entry.max },
  };
}
