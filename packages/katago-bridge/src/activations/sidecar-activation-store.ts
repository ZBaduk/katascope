/**
 * `ActivationStore` backed by the Python sidecar.
 *
 * The sidecar owns the model: katascope asks for a (move, block) frame and gets
 * planes back. See `sidecar-protocol.ts` for the wire format.
 */

import type {
  ActivationAvailability,
  ActivationFrame,
  ActivationKey,
  ActivationStore,
  NetworkSpec,
  PlaneBuffer,
  PlaneDType,
} from '@katascope/core';
import { LineProcess, type JsonLine } from '../process/line-process.js';
import { RequestCorrelator } from '../process/request-correlator.js';
import { SidecarProtocolError, type SidecarRequest } from './sidecar-protocol.js';

export interface SidecarActivationStoreOptions {
  /** Python interpreter to run. */
  readonly pythonPath: string;
  /** Sidecar entry point, already resolved to an absolute path. */
  readonly sidecarPath: string;
  /** Model the sidecar should load. */
  readonly modelPath: string;
  /** Extra arguments appended after the sidecar path. */
  readonly extraArgs?: readonly string[];
  /** Milliseconds a single request may take. Defaults to 60_000. */
  readonly timeoutMs?: number;
  /** Called with each stderr line, for the Diagnostics log. */
  readonly onLog?: (line: string) => void;
}

export class SidecarActivationStore implements ActivationStore {
  readonly #process: LineProcess;
  readonly #correlator: RequestCorrelator;
  #started: Promise<void> | undefined;
  #availability: ActivationAvailability | undefined;

  constructor(options: SidecarActivationStoreOptions) {
    this.#process = new LineProcess({
      command: options.pythonPath,
      // -u keeps Python from buffering stdout, which would stall every response.
      args: ['-u', options.sidecarPath, '--model', options.modelPath, ...(options.extraArgs ?? [])],
      ...(options.onLog === undefined ? {} : { onStderr: options.onLog }),
    });
    this.#correlator = new RequestCorrelator(this.#process, { timeoutMs: options.timeoutMs ?? 60_000 });
  }

  /** Starts the sidecar. Idempotent. */
  start(): Promise<void> {
    this.#started ??= this.#process.start().then(() => {
      this.#correlator.attach();
    });
    return this.#started;
  }

  async describe(): Promise<ActivationAvailability> {
    await this.start();
    // The network shape cannot change while the sidecar lives, so cache it.
    this.#availability ??= toAvailability(await this.#send({ type: 'describe' }));
    return this.#availability;
  }

  async frame(key: ActivationKey): Promise<ActivationFrame> {
    const availability = await this.describe();
    const response = await this.#send({ type: 'frame', ...key });
    return toFrame(response, key, availability.spec);
  }

  async dispose(): Promise<void> {
    this.#correlator.rejectAll(new Error('activation sidecar disposed'));
    await this.#process.stop();
  }

  /** Recent stderr, surfaced in Diagnostics when a start fails. */
  get log(): string {
    return this.#process.stderrTail;
  }

  async #send(request: SidecarRequest): Promise<JsonLine> {
    const response = await this.#correlator.request({ ...request });
    if (response['ok'] !== true) {
      const error = response['error'];
      throw new SidecarProtocolError(typeof error === 'string' ? error : 'request failed without a reason');
    }
    return response;
  }
}

function toAvailability(line: JsonLine): ActivationAvailability {
  const network = line['network'];
  if (network === null || typeof network !== 'object' || Array.isArray(network)) {
    throw new SidecarProtocolError('describe response is missing "network"');
  }
  const raw = network as Record<string, unknown>;
  const spec: NetworkSpec = {
    name: requireString(raw['name'], 'network.name'),
    blocks: requirePositiveInt(raw['blocks'], 'network.blocks'),
    channels: requirePositiveInt(raw['channels'], 'network.channels'),
    boardSize: {
      width: requirePositiveInt(raw['boardXSize'], 'network.boardXSize'),
      height: requirePositiveInt(raw['boardYSize'], 'network.boardYSize'),
    },
  };
  return {
    spec,
    maxMoveNumber: requirePositiveInt(line['maxMoveNumber'], 'maxMoveNumber', 0),
    dtype: requireDType(line['dtype']),
  };
}

function toFrame(line: JsonLine, key: ActivationKey, spec: NetworkSpec): ActivationFrame {
  const dtype = requireDType(line['dtype']);
  const data = decodePlanes(requireString(line['data'], 'data'), dtype);
  const expected = spec.channels * spec.boardSize.width * spec.boardSize.height;
  if (data.length !== expected) {
    throw new SidecarProtocolError(
      `frame for block ${key.block} has ${data.length} elements, expected ${expected}`,
    );
  }
  return {
    ...key,
    networkName: spec.name,
    boardSize: spec.boardSize,
    channels: spec.channels,
    dtype,
    data,
    range: { min: requireNumber(line['min'], 'min'), max: requireNumber(line['max'], 'max') },
  };
}

/** Decodes base64 into the buffer type the frame declares. */
export function decodePlanes(base64: string, dtype: PlaneDType): PlaneBuffer {
  const bytes = Buffer.from(base64, 'base64');
  if (dtype === 'uint8') {
    return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  if (bytes.byteLength % 4 !== 0) {
    throw new SidecarProtocolError(`float32 payload of ${bytes.byteLength} bytes is not a multiple of 4`);
  }
  // Node's pooled Buffers are rarely 4-byte aligned, so copy into a fresh one.
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return new Float32Array(copy);
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new SidecarProtocolError(`expected "${field}" to be a string`);
  }
  return value;
}

function requireNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new SidecarProtocolError(`expected "${field}" to be a finite number`);
  }
  return value;
}

function requirePositiveInt(value: unknown, field: string, minimum = 1): number {
  const n = requireNumber(value, field);
  if (!Number.isInteger(n) || n < minimum) {
    throw new SidecarProtocolError(`expected "${field}" to be an integer >= ${minimum}, got ${n}`);
  }
  return n;
}

function requireDType(value: unknown): PlaneDType {
  if (value === 'float32' || value === 'uint8') return value;
  throw new SidecarProtocolError(`unsupported dtype ${JSON.stringify(value)}`);
}
