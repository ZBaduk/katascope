/**
 * `ActivationStore` backed by the Python activation service.
 *
 * The service owns the model and is stateless: every request carries the whole
 * position, so there is no session to get out of step. That means this store
 * must know the game in order to answer a `(moveNumber, block)` key -- it holds
 * the `GameRecord` and replays the prefix into a wire position.
 *
 * See `sidecar-protocol.ts` for the transport.
 */

import type {
  ActivationAvailability,
  ActivationFrame,
  ActivationKey,
  ActivationStore,
  Attribution,
  AttributionRequest,
  GameRecord,
  Conv1x1,
  HeadActivation,
  HeadWeights,
  LinearLayer,
  NetworkSpec,
  ReaderWeights,
} from '@katascope/core';
import { moveToAnalysisPair, playerToMoveAt, vertexToGtp } from '@katascope/core';
import { FramedProcess, type FramedMessage } from '../process/framed-process.js';
import {
  SidecarProtocolError,
  type HeadsResponse,
  type SidecarPosition,
  type SidecarRequest,
} from './sidecar-protocol.js';

export interface SidecarActivationStoreOptions {
  readonly pythonPath: string;
  readonly sidecarPath: string;
  /** Model the service loads. A `.ckpt`; see the service's README. */
  readonly modelPath: string;
  readonly extraArgs?: readonly string[];
  /** Milliseconds a single request may take. Defaults to 120_000. */
  readonly timeoutMs?: number;
  readonly onLog?: (line: string) => void;
  /** Rules passed to the model. Defaults to `chinese`. */
  readonly rules?: string;
}

interface Pending {
  readonly resolve: (message: FramedMessage) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
}

export class SidecarActivationStore implements ActivationStore {
  readonly #options: SidecarActivationStoreOptions;
  readonly #process: FramedProcess;
  readonly #pending = new Map<string, Pending>();
  #nextId = 1;
  #started: Promise<void> | undefined;
  #availability: ActivationAvailability | undefined;
  #readerWeights: ReaderWeights | undefined;
  #headWeights: HeadWeights | undefined;
  #game: GameRecord | undefined;

  constructor(options: SidecarActivationStoreOptions) {
    this.#options = options;
    this.#process = new FramedProcess({
      command: options.pythonPath,
      // -u: an unbuffered child, or every response stalls in Python's stdout buffer.
      args: ['-u', options.sidecarPath, '--model', options.modelPath, ...(options.extraArgs ?? [])],
      ...(options.onLog === undefined ? {} : { onStderr: options.onLog }),
    });
  }

  /**
   * Supplies the game whose positions will be requested.
   *
   * Required before `frame()`: the store turns a move number into a position,
   * and without a game there is nothing to turn.
   */
  setGame(game: GameRecord): void {
    this.#game = game;
  }

  start(): Promise<void> {
    this.#started ??= this.#process.start().then(() => {
      this.#process.onMessage((message) => this.#route(message));
      this.#process.onExit((error) => this.#rejectAll(error));
    });
    return this.#started;
  }

  async describe(): Promise<ActivationAvailability> {
    await this.start();
    // The network cannot change while the service lives, so ask once.
    this.#availability ??= toAvailability(await this.#send({ type: 'describe' }));
    return this.#availability;
  }

  async frame(key: ActivationKey): Promise<ActivationFrame> {
    const availability = await this.describe();
    const { spec } = availability;
    if (!Number.isInteger(key.block) || key.block < 0 || key.block >= spec.blocks) {
      throw new RangeError(`block ${key.block} outside 0..${spec.blocks - 1}`);
    }
    const message = await this.#send({
      type: 'frame',
      block: key.block,
      position: this.positionAt(key.moveNumber),
    });
    return toFrame(message, key, spec);
  }

  /**
   * Static, weight-based channel importance. Cached: it depends only on the
   * network, so asking twice would re-read every weight tensor for nothing.
   */
  async readerWeights(): Promise<ReaderWeights> {
    const availability = await this.describe();
    if (this.#readerWeights !== undefined) return this.#readerWeights;

    const message = await this.#send({ type: 'reader_weights' });
    const { header, payload } = message;
    if (payload === undefined) {
      throw new SidecarProtocolError('reader_weights arrived with no binary payload');
    }
    const channels = requirePositiveInt(header['channels'], 'channels');
    const names = header['vectors'];
    if (!Array.isArray(names)) throw new SidecarProtocolError('expected "vectors" to be an array');
    if (payload.byteLength !== names.length * channels * 4) {
      throw new SidecarProtocolError(
        `reader_weights payload is ${payload.byteLength} bytes, expected ${names.length * channels * 4}`,
      );
    }

    const floats = toFloat32(payload);
    const byBlock: Float32Array[] = [];
    const heads: Record<string, Float32Array> = {};
    for (const [index, raw] of names.entries()) {
      const name = String(raw);
      const vector = floats.slice(index * channels, (index + 1) * channels);
      if (name.startsWith('head:')) heads[name.slice(5)] = vector;
      else byBlock.push(vector);
    }
    const policy = heads['policy'];
    const value = heads['value'];
    if (policy === undefined || value === undefined) {
      throw new SidecarProtocolError('reader_weights is missing a head vector');
    }

    this.#readerWeights = {
      networkName: availability.spec.name,
      channels,
      byBlock,
      heads: { policy, value },
    };
    return this.#readerWeights;
  }

  /**
   * Both heads' parameters, so the UI can re-run them on an altered trunk.
   *
   * Cached for the life of the process: the weights are the network, and the
   * network cannot change while the service lives.
   */
  async headWeights(): Promise<HeadWeights> {
    const availability = await this.describe();
    if (this.#headWeights !== undefined) return this.#headWeights;

    const { header, payload } = await this.#send({ type: 'head_weights' });
    if (payload === undefined) {
      throw new SidecarProtocolError('head_weights arrived with no binary payload');
    }

    const descriptors = header['tensors'];
    if (!Array.isArray(descriptors)) {
      throw new SidecarProtocolError('expected "tensors" to be an array');
    }

    const floats = toFloat32(payload);
    const tensors = new Map<string, Float32Array>();
    const shapes = new Map<string, readonly number[]>();
    let offset = 0;
    for (const raw of descriptors) {
      if (typeof raw !== 'object' || raw === null) {
        throw new SidecarProtocolError('a tensor descriptor was not an object');
      }
      const entry = raw as Record<string, unknown>;
      const name = String(entry['name'] ?? '');
      const shape = entry['shape'];
      if (name === '' || !Array.isArray(shape)) {
        throw new SidecarProtocolError('a tensor descriptor is missing a name or a shape');
      }
      const dims = shape.map((value) => requirePositiveInt(value, `${name} shape entry`));
      const count = dims.reduce((product, dim) => product * dim, 1);
      if (offset + count > floats.length) {
        throw new SidecarProtocolError(
          `head_weights payload ran out at "${name}": needed ${count} more floats`,
        );
      }
      tensors.set(name, floats.slice(offset, offset + count));
      shapes.set(name, dims);
      offset += count;
    }
    // A payload longer than the descriptors account for means the two sides
    // disagree about the tensor set, which is worse than a short one: the
    // leftovers would be silently ignored.
    if (offset !== floats.length) {
      throw new SidecarProtocolError(
        `head_weights payload has ${floats.length} floats, descriptors account for ${offset}`,
      );
    }

    this.#headWeights = buildHeadWeights({
      networkName: availability.spec.name,
      version: requirePositiveInt(header['version'], 'version'),
      activation: String(header['activation'] ?? ''),
      trunkChannels: requirePositiveInt(header['trunkChannels'], 'trunkChannels'),
      posLen: requirePositiveInt(header['posLen'], 'posLen'),
      trunkFinalScale: requireFinite(header['trunkFinalScale'], 'trunkFinalScale'),
      tensors,
      shapes,
    });
    return this.#headWeights;
  }

  /** Gradient-based attribution of one output to every channel. */
  async attribute(request: AttributionRequest): Promise<Attribution> {
    const availability = await this.describe();
    const message = await this.#send({
      type: 'attribute',
      position: this.positionAt(request.moveNumber),
      target: request.target,
      ...(request.planeBlock === undefined ? {} : { planeBlock: request.planeBlock }),
    });
    const { header, payload } = message;
    if (payload === undefined) {
      throw new SidecarProtocolError('attribute arrived with no binary payload');
    }

    const blocks = requirePositiveInt(header['blocks'], 'blocks');
    const channels = requirePositiveInt(header['channels'], 'channels');
    const totals = blocks * channels;
    const floats = toFloat32(payload);
    if (floats.length < totals) {
      throw new SidecarProtocolError(
        `attribute payload holds ${floats.length} floats, expected at least ${totals}`,
      );
    }

    const byBlock = floats.slice(0, totals);
    const planeBlock = header['planeBlock'];
    if (typeof planeBlock !== 'number') {
      return { moveNumber: request.moveNumber, target: request.target, blocks, channels, byBlock };
    }

    const area = availability.spec.boardSize.width * availability.spec.boardSize.height;
    const expected = totals + channels * area;
    if (floats.length !== expected) {
      throw new SidecarProtocolError(
        `attribute payload holds ${floats.length} floats, expected ${expected} with planes`,
      );
    }
    return {
      moveNumber: request.moveNumber,
      target: request.target,
      blocks,
      channels,
      byBlock,
      planeBlock,
      planes: floats.slice(totals),
    };
  }

  /** Raw output heads for a move. Used by the golden test and by diagnostics. */
  async heads(moveNumber: number): Promise<HeadsResponse> {
    await this.start();
    const message = await this.#send({ type: 'heads', position: this.positionAt(moveNumber) });
    const { header } = message;
    return {
      ok: true,
      policy: numberArray(header['policy'], 'policy'),
      ownership: numberArray(header['ownership'], 'ownership'),
      value: numberArray(header['value'], 'value'),
      scoreLead: requireNumber(header['scoreLead'], 'scoreLead'),
    };
  }

  /**
   * Builds the wire position for a move number by replaying the game prefix.
   *
   * Setup stones (SGF `AB`/`AW`, which is how handicap is recorded) become
   * `initialStones`, exactly as the analysis engine expects -- they are not
   * moves and must not enter the move history, or the net sees the wrong
   * recent-play planes.
   */
  positionAt(moveNumber: number): SidecarPosition {
    const game = this.#game;
    if (game === undefined) {
      throw new SidecarProtocolError('no game loaded; call setGame() before requesting frames');
    }
    if (!Number.isInteger(moveNumber) || moveNumber < 0 || moveNumber > game.moves.length) {
      throw new RangeError(`move ${moveNumber} outside 0..${game.moves.length}`);
    }
    return {
      boardXSize: game.size.width,
      boardYSize: game.size.height,
      rules: this.#options.rules ?? game.info.ruleset ?? 'chinese',
      komi: game.info.komi,
      initialStones: game.setup.map(
        (stone) => [stone.color === 'black' ? 'B' : 'W', vertexToGtp(game.size, stone.vertex)] as const,
      ),
      moves: game.moves
        .slice(0, moveNumber)
        .map((move) => moveToAnalysisPair(game.size, move)),
      initialPlayer: playerToMoveAt(game, 0) === 'black' ? 'B' : 'W',
    };
  }

  async dispose(): Promise<void> {
    this.#rejectAll(new Error('activation sidecar disposed'));
    await this.#process.stop();
  }

  get log(): string {
    return this.#process.stderrTail;
  }

  async #send(request: SidecarRequest): Promise<FramedMessage> {
    await this.start();
    const id = `ks-${this.#nextId++}`;
    const timeoutMs = this.#options.timeoutMs ?? 120_000;

    const message = await new Promise<FramedMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`request ${id} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref?.();
      this.#pending.set(id, { resolve, reject, timer });
      try {
        this.#process.send({ ...request, id });
      } catch (error) {
        this.#settle(id, (pending) => pending.reject(error instanceof Error ? error : new Error(String(error))));
      }
    });

    if (message.header['ok'] !== true) {
      const error = message.header['error'];
      throw new SidecarProtocolError(typeof error === 'string' ? error : 'request failed without a reason');
    }
    return message;
  }

  #route(message: FramedMessage): void {
    const id = message.header['id'];
    if (typeof id !== 'string') return;
    this.#settle(id, (pending) => pending.resolve(message));
  }

  #rejectAll(error: Error): void {
    for (const id of [...this.#pending.keys()]) {
      this.#settle(id, (pending) => pending.reject(error));
    }
  }

  #settle(id: string, finish: (pending: Pending) => void): void {
    const pending = this.#pending.get(id);
    if (pending === undefined) return;
    this.#pending.delete(id);
    clearTimeout(pending.timer);
    finish(pending);
  }
}

function toAvailability(message: FramedMessage): ActivationAvailability {
  const network = message.header['network'];
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
    maxMoveNumber: requirePositiveInt(message.header['maxMoveNumber'], 'maxMoveNumber', 0),
    dtype: 'float32',
  };
}

function toFrame(message: FramedMessage, key: ActivationKey, spec: NetworkSpec): ActivationFrame {
  const { payload } = message;
  if (payload === undefined) {
    throw new SidecarProtocolError(`frame for block ${key.block} arrived with no binary payload`);
  }
  const expected = spec.channels * spec.boardSize.width * spec.boardSize.height;
  if (payload.byteLength !== expected * 4) {
    throw new SidecarProtocolError(
      `frame for block ${key.block} is ${payload.byteLength} bytes, expected ${expected * 4}`,
    );
  }
  // Node's pooled Buffers are rarely 4-byte aligned, so copy into a fresh one.
  const copy = new ArrayBuffer(payload.byteLength);
  new Uint8Array(copy).set(payload);

  return {
    ...key,
    networkName: spec.name,
    boardSize: spec.boardSize,
    channels: spec.channels,
    dtype: 'float32',
    data: new Float32Array(copy),
    range: {
      min: requireNumber(message.header['min'], 'min'),
      max: requireNumber(message.header['max'], 'max'),
    },
  };
}

/**
 * Reinterprets a payload as float32.
 *
 * Node's pooled Buffers are rarely 4-byte aligned, so the bytes are copied into
 * a fresh buffer rather than viewed in place.
 */
function toFloat32(payload: Buffer): Float32Array {
  if (payload.byteLength % 4 !== 0) {
    throw new SidecarProtocolError(`payload of ${payload.byteLength} bytes is not a multiple of 4`);
  }
  const copy = new ArrayBuffer(payload.byteLength);
  new Uint8Array(copy).set(payload);
  return new Float32Array(copy);
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new SidecarProtocolError(`expected "${field}" to be a string`);
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

function numberArray(value: unknown, field: string): readonly number[] {
  if (!Array.isArray(value)) throw new SidecarProtocolError(`expected "${field}" to be an array`);
  return value.map((v, i) => requireNumber(v, `${field}[${i}]`));
}


/** Everything the header and payload yielded, before it is given a shape. */
interface RawHeadWeights {
  readonly networkName: string;
  readonly version: number;
  readonly activation: string;
  readonly trunkChannels: number;
  readonly posLen: number;
  readonly trunkFinalScale: number;
  readonly tensors: ReadonlyMap<string, Float32Array>;
  readonly shapes: ReadonlyMap<string, readonly number[]>;
}

/**
 * Assembles the flat named tensors into the structure `@katascope/core` runs.
 *
 * Every lookup is checked. A missing tensor here would otherwise become a
 * zero-filled convolution somewhere in the head, and a head with one layer
 * quietly zeroed still returns a plausible-looking policy -- which is the one
 * failure mode this whole feature has to avoid.
 */
function buildHeadWeights(raw: RawHeadWeights): HeadWeights {
  const conv = (name: string): Conv1x1 => {
    const weight = raw.tensors.get(name);
    const shape = raw.shapes.get(name);
    if (weight === undefined || shape === undefined) {
      throw new SidecarProtocolError(`head_weights is missing "${name}"`);
    }
    const [outChannels, inChannels] = shape;
    if (outChannels === undefined || inChannels === undefined) {
      throw new SidecarProtocolError(`"${name}" should be a 2-D convolution, got ${shape.length}-D`);
    }
    return { outChannels, inChannels, weight };
  };

  const linear = (name: string, biasName?: string): LinearLayer => {
    const weight = raw.tensors.get(name);
    const shape = raw.shapes.get(name);
    if (weight === undefined || shape === undefined) {
      throw new SidecarProtocolError(`head_weights is missing "${name}"`);
    }
    const [outFeatures, inFeatures] = shape;
    if (outFeatures === undefined || inFeatures === undefined) {
      throw new SidecarProtocolError(`"${name}" should be a 2-D linear, got ${shape.length}-D`);
    }
    const bias = biasName === undefined ? undefined : raw.tensors.get(biasName);
    return { outFeatures, inFeatures, weight, ...(bias === undefined ? {} : { bias }) };
  };

  const vector = (name: string): Float32Array => {
    const values = raw.tensors.get(name);
    if (values === undefined) throw new SidecarProtocolError(`head_weights is missing "${name}"`);
    return values;
  };

  const optionalConv = (name: string): Conv1x1 | undefined =>
    raw.tensors.has(name) ? conv(name) : undefined;

  // The pass path gained a hidden layer at model version 15.
  const hasPass2 = raw.tensors.has('policy.linear_pass2');
  const futurePos = optionalConv('value.conv_futurepos');
  const seki = optionalConv('value.conv_seki');
  const scoring = optionalConv('value.conv_scoring');

  return {
    networkName: raw.networkName,
    version: raw.version,
    activation: toHeadActivation(raw.activation),
    trunkChannels: raw.trunkChannels,
    posLen: raw.posLen,
    trunkFinal: { scale: raw.trunkFinalScale, beta: vector('trunkfinal.beta') },
    policy: {
      conv1p: conv('policy.conv1p'),
      conv1g: conv('policy.conv1g'),
      biasg: vector('policy.biasg'),
      linearG: linear('policy.linear_g'),
      linearPass: hasPass2
        ? linear('policy.linear_pass', 'policy.linear_pass.bias')
        : linear('policy.linear_pass'),
      ...(hasPass2 ? { linearPass2: linear('policy.linear_pass2') } : {}),
      bias2: vector('policy.bias2'),
      conv2p: conv('policy.conv2p'),
    },
    value: {
      conv1: conv('value.conv1'),
      bias1: vector('value.bias1'),
      convOwnership: conv('value.conv_ownership'),
      ...(scoring === undefined ? {} : { convScoring: scoring }),
      ...(futurePos === undefined ? {} : { convFuturePos: futurePos }),
      ...(seki === undefined ? {} : { convSeki: seki }),
    },
  };
}

/**
 * Narrows KataGo's activation name to one this codebase implements.
 *
 * Throwing rather than defaulting is the point. Substituting ReLU for an
 * unimplemented activation would produce a head that runs, returns numbers of
 * the right shape and magnitude, and is wrong everywhere.
 */
function toHeadActivation(name: string): HeadActivation {
  if (name === 'mish' || name === 'relu' || name === 'identity') return name;
  throw new SidecarProtocolError(
    `head activation "${name}" is not implemented; heads cannot be re-run for this network`,
  );
}

/** A finite number from untrusted JSON. */
function requireFinite(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new SidecarProtocolError(`expected "${field}" to be a finite number`);
  }
  return value;
}
