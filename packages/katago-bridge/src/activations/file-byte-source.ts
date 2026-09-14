/**
 * A `KactByteSource` backed by a file handle.
 *
 * `@katascope/core` owns the seek-and-decode logic but cannot open a file, so
 * this supplies the bytes. Deliberately thin: everything interesting about
 * reading a capture is in core, where it is testable without a filesystem.
 *
 * The handle stays open for the life of the store. A capture is read a frame at
 * a time as the user moves around it, so reopening per read would mean a syscall
 * pair per heatmap.
 */

import { open, type FileHandle } from 'node:fs/promises';
import type { KactByteSource } from '@katascope/core';

export interface FileByteSource extends KactByteSource {
  readonly path: string;
}

export async function fileByteSource(path: string): Promise<FileByteSource> {
  const handle: FileHandle = await open(path, 'r');
  const { size } = await handle.stat();

  return {
    path,
    byteLength: size,
    read: async (offset, length) => {
      const buffer = new Uint8Array(length);
      // `read` can return fewer bytes than asked for; loop until satisfied or
      // the file ends. Core rejects a short read, so a partial frame never
      // reaches a decoder.
      let filled = 0;
      while (filled < length) {
        const { bytesRead } = await handle.read(buffer, filled, length - filled, offset + filled);
        if (bytesRead <= 0) break;
        filled += bytesRead;
      }
      return filled === length ? buffer : buffer.subarray(0, filled);
    },
    close: async () => {
      await handle.close();
    },
  };
}
