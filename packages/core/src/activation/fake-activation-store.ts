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
import type {
  Attribution,
  AttributionRequest,
  AttributionTarget,
  ReaderWeights,
} from '../domain/attribution.js';
import type { HeadWeights } from '../heads/head-weights.js';
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

  /**
   * Synthetic reader norms, so the impact ordering is exercisable offline.
   *
   * Shaped to be *useful* rather than merely present: the policy and value head
   * vectors are deliberately near-uncorrelated, because on the real net they
   * are (0.13 on kata1-b18c384nbt) and a UI that tints the last block by which
   * head leans on a channel would look identical for every channel if the fake
   * made them agree.
   */
  async readerWeights(): Promise<ReaderWeights> {
    this.#assertOpen();
    const { blocks, channels } = this.#spec;
    const byBlock: Float32Array[] = [];
    for (let block = 0; block < blocks - 1; block++) {
      byBlock.push(this.#normVector(block * 31 + 5));
    }
    return {
      networkName: this.#spec.name,
      channels,
      byBlock,
      heads: { policy: this.#normVector(9001), value: this.#normVector(4242) },
    };
  }

  /**
   * Synthetic head weights, so the reduce path is exercisable offline.
   *
   * Shaped like the reference net's heads but tiny: 8 head channels rather than
   * 48, which keeps a fake run cheap while exercising every layer -- both
   * trunk-reading convolutions, the pooled branch, the pass path, and the
   * ownership convolution.
   *
   * The numbers mean nothing, but they are **not** uniform: a weight set where
   * every channel mattered equally would make every reduction look the same,
   * and a UI bug that ignored the selection would be invisible.
   */
  async headWeights(): Promise<HeadWeights> {
    this.#assertOpen();
    const trunk = this.#spec.channels;
    const heads = 8;
    const policyOutputs = 6;

    const draw = (salt: number, count: number, spread = 1): Float32Array => {
      const out = new Float32Array(count);
      for (let i = 0; i < count; i++) {
        out[i] = Math.fround((hash3(this.#seed ^ salt, salt, i) - 0.5) * 2 * spread);
      }
      return out;
    };
    const conv = (salt: number, outChannels: number, inChannels: number) => ({
      outChannels,
      inChannels,
      // Scaled down by fan-in, so a fake head's outputs stay in a range where
      // the colour mapping shows structure rather than saturating.
      weight: draw(salt, outChannels * inChannels, 2 / Math.sqrt(inChannels)),
    });

    return {
      networkName: this.#spec.name,
      version: 14,
      activation: 'mish',
      trunkChannels: trunk,
      posLen: this.#spec.boardSize.width,
      trunkFinal: { scale: 1 / Math.sqrt(this.#spec.blocks + 1), beta: draw(0x51, trunk, 0.2) },
      policy: {
        conv1p: conv(0x52, heads, trunk),
        conv1g: conv(0x53, heads, trunk),
        biasg: draw(0x54, heads, 0.2),
        linearG: { outFeatures: heads, inFeatures: 3 * heads, weight: draw(0x55, heads * 3 * heads, 0.3) },
        linearPass: {
          outFeatures: policyOutputs,
          inFeatures: 3 * heads,
          weight: draw(0x56, policyOutputs * 3 * heads, 0.3),
        },
        bias2: draw(0x57, heads, 0.2),
        conv2p: conv(0x58, policyOutputs, heads),
      },
      value: {
        conv1: conv(0x59, heads, trunk),
        bias1: draw(0x5a, heads, 0.2),
        // Deliberately louder than fan-in scaling would give. The ownership map
        // is a tanh, and a faithfully-scaled fake lands so close to zero that
        // the overlay renders blank -- which makes a working pipeline look
        // broken offline, and a broken one look the same as a working one.
        convOwnership: {
          outChannels: 1,
          inChannels: heads,
          weight: draw(0x5b, heads, 8 / Math.sqrt(heads)),
        },
      },
    };
  }

  /**
   * Synthetic attribution, deterministic in `(move, target, block, channel)`.
   *
   * Different targets give visibly different orderings, so a UI bug that
   * ignores the target selector shows up rather than hiding behind noise.
   */
  async attribute(request: AttributionRequest): Promise<Attribution> {
    this.#assertOpen();
    const { blocks, channels, boardSize } = this.#spec;
    const area = boardArea(boardSize);
    const salt = targetSalt(request.target);

    const byBlock = new Float32Array(blocks * channels);
    for (let block = 0; block < blocks; block++) {
      for (let channel = 0; channel < channels; channel++) {
        const noise = hash3(this.#seed ^ salt, request.moveNumber * 97 + block, channel);
        byBlock[block * channels + channel] = Math.fround(noise * noise * 10);
      }
    }

    if (request.planeBlock === undefined) {
      return { moveNumber: request.moveNumber, target: request.target, blocks, channels, byBlock };
    }
    if (request.planeBlock < 0 || request.planeBlock >= blocks) {
      throw new RangeError(`block ${request.planeBlock} outside 0..${blocks - 1}`);
    }

    const planes = new Float32Array(channels * area);
    for (let channel = 0; channel < channels; channel++) {
      const base = channel * area;
      for (let i = 0; i < area; i++) {
        // Signed, like the real thing: the totals drop the sign, the planes keep it.
        const noise = hash3(this.#seed ^ salt, request.planeBlock * 131 + channel, i);
        planes[base + i] = Math.fround((noise - 0.5) * 2);
      }
    }
    return {
      moveNumber: request.moveNumber,
      target: request.target,
      blocks,
      channels,
      byBlock,
      planeBlock: request.planeBlock,
      planes,
    };
  }

  /** A positive, varied vector of per-channel norms. */
  #normVector(salt: number): Float32Array {
    const out = new Float32Array(this.#spec.channels);
    for (let channel = 0; channel < out.length; channel++) {
      out[channel] = Math.fround(hash3(this.#seed ^ salt, salt, channel) * 3);
    }
    return out;
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

/**
 * Channels the fake store makes respond to a known region.
 *
 * The region search needs something to find. Pure noise would occasionally
 * throw up a hit and just as occasionally not, so a spec asserting "the search
 * finds them" would be flaky in both directions. These channels fire on
 * `plantedRegion()` at every move and every block, hard enough to clear a
 * sensible threshold and quiet enough elsewhere to pass the `specific` test.
 *
 * Their indices are all >= 3 on purpose: `fixtures/kact/tiny-b2c3.kact` is a
 * byte-exact 3-channel fixture generated from this function, and planting
 * inside its range would change bytes the codec tests compare against.
 */
export const PLANTED_CHANNELS: readonly PlantedChannel[] = [
  { channel: 7, direction: 'high' },
  { channel: 23, direction: 'high' },
  { channel: 42, direction: 'high' },
  { channel: 11, direction: 'low' },
];

export interface PlantedChannel {
  readonly channel: number;
  /** `high` fires on the region and is flat elsewhere; `low` is the inverse. */
  readonly direction: 'high' | 'low';
}

/** Peak value a planted channel reaches, well clear of the noise floor. */
const PLANTED_LEVEL = 5;

/**
 * The region the planted channels respond to: a 2x2 square at (3,3).
 *
 * Empty for boards too small to hold it, which leaves those nets unplanted
 * rather than silently planting a different region.
 */
export function plantedRegion(size: BoardSize): readonly { readonly x: number; readonly y: number }[] {
  if (size.width < 5 || size.height < 5) return [];
  return [
    { x: 3, y: 3 },
    { x: 4, y: 3 },
    { x: 3, y: 4 },
    { x: 4, y: 4 },
  ];
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

  // Resolved once: the membership test runs per cell of every planted plane.
  const region = plantedRegion(boardSize);
  const regionMask = new Uint8Array(area);
  for (const vertex of region) {
    regionMask[vertex.y * boardSize.width + vertex.x] = 1;
  }
  const planted = new Map(PLANTED_CHANNELS.map((entry) => [entry.channel, entry]));

  // Deeper blocks get sparser, higher-contrast activations.
  const depth = spec.blocks <= 1 ? 0 : key.block / (spec.blocks - 1);
  const sparsity = 0.15 + 0.45 * depth;
  const gain = 1 + 2 * depth;

  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;

  for (let c = 0; c < channels; c++) {
    const rng = hash3(seed, key.moveNumber * 1_000 + key.block, c);
    const plant = region.length === 0 ? undefined : planted.get(c);

    if (plant !== undefined) {
      const base = c * area;
      for (let i = 0; i < area; i++) {
        const inRegion = regionMask[i] === 1;
        // A little deterministic jitter, so the plane is not literally constant
        // -- a constant plane has zero variance and the "hide unused" slider
        // would collapse the very channels the search is meant to surface.
        const jitter = hash3(seed ^ 0x9107, c, i) * 0.2;
        const hot = plant.direction === 'high' ? inRegion : !inRegion;
        const value = Math.fround(hot ? PLANTED_LEVEL + jitter : jitter);
        floats[base + i] = value;
        if (value < min) min = value;
        if (value > max) max = value;
      }
      continue;
    }

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

/** A per-target salt, so different targets give different orderings. */
function targetSalt(target: AttributionTarget): number {
  switch (target.kind) {
    case 'ownership_total':
      return 0x1111;
    case 'winrate':
      return 0x2222;
    case 'policy_pass':
      return 0x3333;
    case 'ownership_point':
      return 0x4444 + target.x * 31 + target.y;
    case 'policy_move':
      return 0x5555 + target.x * 31 + target.y;
  }
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
