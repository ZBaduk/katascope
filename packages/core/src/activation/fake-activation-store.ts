/**
 * Synthetic activations, so the UI can be developed with no KataGo, no model
 * file, and no Python present.
 *
 * The values are not a simulation of anything -- they are deterministic noise
 * shaped to *look* like trunk activations: smooth blobs of varying spatial
 * frequency, sparser and higher-contrast in later blocks, with a fraction of
 * channels left near-dead the way real ReLU trunks have dead channels. That is
 * enough to exercise colour mapping, channel paging, and range handling.
 */

import type { BoardSize } from '../domain/board.js';
import { boardArea } from '../domain/board.js';
import type {
  ActivationAvailability,
  ActivationFrame,
  ActivationKey,
  ActivationStore,
  PlaneDType,
} from '../domain/activation.js';
import type { NetworkSpec } from '../domain/network-spec.js';
import { B6C96 } from '../domain/network-spec.js';

export interface FakeActivationStoreOptions {
  /** Network to imitate. Defaults to a 6-block, 96-channel net at 19x19. */
  readonly spec?: NetworkSpec;
  /** Highest move number the store will serve. Defaults to 400. */
  readonly maxMoveNumber?: number;
  /** Element type of generated frames. Defaults to `float32`. */
  readonly dtype?: PlaneDType;
  /** Seed for the value generator; the same seed always yields the same frames. */
  readonly seed?: number;
  /** Artificial delay per frame, in ms, to mimic sidecar latency. Defaults to 0. */
  readonly latencyMs?: number;
}

export class FakeActivationStore implements ActivationStore {
  readonly #spec: NetworkSpec;
  readonly #maxMoveNumber: number;
  readonly #dtype: PlaneDType;
  readonly #seed: number;
  readonly #latencyMs: number;
  #disposed = false;

  constructor(options: FakeActivationStoreOptions = {}) {
    this.#spec = options.spec ?? B6C96;
    this.#maxMoveNumber = options.maxMoveNumber ?? 400;
    this.#dtype = options.dtype ?? 'float32';
    this.#seed = options.seed ?? 0x5ca1ab1e;
    this.#latencyMs = options.latencyMs ?? 0;
  }

  async describe(): Promise<ActivationAvailability> {
    this.#assertOpen();
    return { spec: this.#spec, maxMoveNumber: this.#maxMoveNumber, dtype: this.#dtype };
  }

  async frame(key: ActivationKey): Promise<ActivationFrame> {
    this.#assertOpen();
    const { moveNumber, block } = key;
    if (!Number.isInteger(block) || block < 0 || block >= this.#spec.blocks) {
      throw new RangeError(`block ${block} outside 0..${this.#spec.blocks - 1}`);
    }
    if (!Number.isInteger(moveNumber) || moveNumber < 0 || moveNumber > this.#maxMoveNumber) {
      throw new RangeError(`move ${moveNumber} outside 0..${this.#maxMoveNumber}`);
    }
    if (this.#latencyMs > 0) await delay(this.#latencyMs);
    return generateFrame(this.#spec, key, this.#dtype, this.#seed);
  }

  async dispose(): Promise<void> {
    this.#disposed = true;
  }

  #assertOpen(): void {
    if (this.#disposed) throw new Error('FakeActivationStore has been disposed');
  }
}

/**
 * `core` targets no platform lib, so timers are not in scope. Reach for the
 * host's `setTimeout` if it has one and resolve immediately if it does not.
 */
function delay(ms: number): Promise<void> {
  const timer = (globalThis as { setTimeout?: (cb: () => void, ms: number) => unknown }).setTimeout;
  if (timer === undefined) return Promise.resolve();
  return new Promise<void>((resolve) => {
    timer(resolve, ms);
  });
}

/** Deterministic frame generation, exported for tests and for fixture dumps. */
export function generateFrame(
  spec: NetworkSpec,
  key: ActivationKey,
  dtype: PlaneDType,
  seed: number,
): ActivationFrame {
  const { boardSize, channels } = spec;
  const area = boardArea(boardSize);
  const floats = new Float32Array(channels * area);

  // Deeper blocks get sparser, higher-contrast activations.
  const depth = spec.blocks <= 1 ? 0 : key.block / (spec.blocks - 1);
  const sparsity = 0.15 + 0.45 * depth;
  const gain = 1 + 2 * depth;

  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;

  for (let c = 0; c < channels; c++) {
    const rng = hash3(seed, key.moveNumber * 1_000 + key.block, c);
    // Roughly one channel in eight is dead, as in a real ReLU trunk.
    const dead = fract(rng * 8) < 0.125;
    const freqX = 0.4 + 2.6 * fract(rng * 13.37);
    const freqY = 0.4 + 2.6 * fract(rng * 7.91);
    const phaseX = fract(rng * 3.11) * Math.PI * 2;
    const phaseY = fract(rng * 5.77) * Math.PI * 2;
    const base = c * area;

    for (let y = 0; y < boardSize.height; y++) {
      for (let x = 0; x < boardSize.width; x++) {
        let v = 0;
        if (!dead) {
          const wave =
            Math.sin((x / boardSize.width) * freqX * Math.PI * 2 + phaseX) *
            Math.cos((y / boardSize.height) * freqY * Math.PI * 2 + phaseY);
          const grain = fract(Math.sin((x * 127.1 + y * 311.7 + rng * 100) * 43_758.545) * 43_758.545) - 0.5;
          const raw = (wave + 0.35 * grain) * gain;
          // Threshold to sparsify, then rectify -- trunk outputs are post-ReLU.
          v = raw > sparsity * gain ? raw - sparsity * gain : 0;
        }
        const value = Math.fround(v);
        floats[base + y * boardSize.width + x] = value;
        if (value < min) min = value;
        if (value > max) max = value;
      }
    }
  }

  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    min = 0;
    max = 0;
  }

  return {
    ...key,
    networkName: spec.name,
    boardSize,
    channels,
    dtype,
    data: dtype === 'float32' ? floats : quantize(floats, min, max),
    range: { min, max },
  };
}

function quantize(values: Float32Array, min: number, max: number): Uint8Array {
  const out = new Uint8Array(values.length);
  const span = max - min;
  if (span <= 0) return out;
  for (let i = 0; i < values.length; i++) {
    out[i] = Math.round((((values[i] ?? 0) - min) / span) * 255);
  }
  return out;
}

/** Cheap 32-bit integer hash mixed down to a float in [0, 1). */
function hash3(a: number, b: number, c: number): number {
  let h = (a ^ 0x9e37_79b9) >>> 0;
  for (const v of [b, c]) {
    h = (h ^ (v >>> 0)) >>> 0;
    h = Math.imul(h, 0x85eb_ca6b) >>> 0;
    h = (h ^ (h >>> 13)) >>> 0;
    h = Math.imul(h, 0xc2b2_ae35) >>> 0;
    h = (h ^ (h >>> 16)) >>> 0;
  }
  return h / 0x1_0000_0000;
}

function fract(x: number): number {
  return x - Math.floor(x);
}

/** Board size the fake store defaults to, re-exported for convenience. */
export function fakeBoardSize(): BoardSize {
  return B6C96.boardSize;
}
