/**
 * Wire protocol between katascope and the Python activation sidecar.
 *
 * The sidecar itself is a later step; this file is the contract it will be
 * written against, so both ends can be reviewed in one place.
 *
 * Transport: newline-delimited JSON, requests on the sidecar's stdin and
 * responses on its stdout. Every request carries an `id` the sidecar echoes.
 * Anything the sidecar writes to stderr is treated as log output.
 *
 * Plane data travels as standard base64 in the JSON line rather than on a
 * second channel. A b6c96 frame is 96 x 361 floats -- about 139 KiB raw, 185 KiB
 * encoded -- which is cheap enough that a second pipe is not worth the
 * complexity. If frames get much larger this is the thing to revisit.
 *
 *   -> {"id":"ks-1","type":"describe"}
 *   <- {"id":"ks-1","ok":true,"network":{"name":"b6c96-s175M","blocks":6,
 *       "channels":96,"boardXSize":19,"boardYSize":19},
 *       "maxMoveNumber":300,"dtype":"float32"}
 *
 *   -> {"id":"ks-2","type":"frame","moveNumber":12,"block":3}
 *   <- {"id":"ks-2","ok":true,"dtype":"float32","min":0.0,"max":6.21,
 *       "data":"<base64, channel-major, row-major within a channel>"}
 *
 *   <- {"id":"ks-2","ok":false,"error":"block 9 out of range"}
 */

/** Request the sidecar's network shape and addressable range. */
export interface DescribeRequest {
  readonly type: 'describe';
}

/** Request every channel of one (move, block) pair. */
export interface FrameRequest {
  readonly type: 'frame';
  readonly moveNumber: number;
  readonly block: number;
}

export type SidecarRequest = DescribeRequest | FrameRequest;

/** Network shape as the sidecar reports it, before conversion to `NetworkSpec`. */
export interface SidecarNetwork {
  readonly name: string;
  readonly blocks: number;
  readonly channels: number;
  readonly boardXSize: number;
  readonly boardYSize: number;
}

export interface DescribeResponse {
  readonly ok: true;
  readonly network: SidecarNetwork;
  readonly maxMoveNumber: number;
  readonly dtype: 'float32' | 'uint8';
}

export interface FrameResponse {
  readonly ok: true;
  readonly dtype: 'float32' | 'uint8';
  readonly min: number;
  readonly max: number;
  /** Base64 of the raw little-endian buffer. */
  readonly data: string;
}

export interface SidecarErrorResponse {
  readonly ok: false;
  readonly error: string;
}

export class SidecarProtocolError extends Error {
  constructor(message: string) {
    super(`activation sidecar: ${message}`);
    this.name = 'SidecarProtocolError';
  }
}
