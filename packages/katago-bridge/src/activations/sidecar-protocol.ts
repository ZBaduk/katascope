/**
 * Wire protocol between katascope and the Python activation service.
 *
 * Transport is **newline-delimited JSON with an optional binary payload**.
 * Every message is a single JSON object on one line; if that object carries a
 * positive `binaryBytes`, exactly that many raw bytes follow the newline
 * before the next JSON line begins.
 *
 *     {"id":"ks-2","ok":true,...,"binaryBytes":554496}\n<554496 raw bytes>
 *
 * Why not base64 inside the JSON, as the first draft of this protocol did: a
 * frame is `channels * width * height` float32s, which for the b18c384 net is
 * 384 x 361 x 4 = 554 KiB. Base64 inflates that by a third and forces the whole
 * payload through `JSON.parse`, which copies it twice more. Raw bytes go
 * straight into a `Float32Array` with one copy, and the copy is only there to
 * fix alignment.
 *
 * Control messages -- `describe`, errors -- carry no payload and are plain
 * JSON lines, so the protocol is still readable in a terminal.
 *
 * Byte order is little-endian, which every platform katascope targets uses
 * natively. The service asserts this rather than converting.
 *
 *   -> {"id":"ks-1","type":"describe"}
 *   <- {"id":"ks-1","ok":true,"network":{"name":"kata1-b18c384nbt-...","blocks":18,
 *       "channels":384,"boardXSize":19,"boardYSize":19},"maxMoveNumber":1000,
 *       "dtype":"float32"}
 *
 *   -> {"id":"ks-2","type":"frame","block":3,"position":{...}}
 *   <- {"id":"ks-2","ok":true,"dtype":"float32","min":0.0,"max":6.21,
 *       "binaryBytes":554496}\n<bytes>
 *
 *   -> {"id":"ks-3","type":"heads","position":{...}}
 *   <- {"id":"ks-3","ok":true,"policy":[...],"ownership":[...],"value":[...]}
 *
 *   -> {"id":"ks-4","type":"reader_weights"}
 *   <- {"id":"ks-4","ok":true,"channels":384,
 *       "vectors":["block:0",...,"block:16","head:policy","head:value"],
 *       "binaryBytes":29184}\n<one `channels`-float run per vector, in order>
 *
 *   -> {"id":"ks-5","type":"attribute","position":{...},
 *       "target":{"kind":"ownership_point","x":3,"y":4},"planeBlock":5}
 *   <- {"id":"ks-5","ok":true,"blocks":18,"channels":384,
 *       "planeBlock":5,"planeShape":[384,19,19],"binaryBytes":580608}
 *       \n<blocks*channels floats, then channels*h*w floats if planeBlock was set>
 *
 *   <- {"id":"ks-4","ok":false,"error":"block 99 out of range"}
 */

/**
 * A position, in the same encoding the KataGo analysis engine takes: GTP
 * coordinate pairs plus the rules that were in force.
 *
 * The service is **stateless** -- every request carries its whole position.
 * That costs a few hundred bytes per request and buys a service with no
 * session, no move-number bookkeeping, and no way for the two sides to
 * disagree about what position is loaded.
 */
export interface SidecarPosition {
  readonly boardXSize: number;
  readonly boardYSize: number;
  /** KataGo ruleset name, e.g. `chinese`. */
  readonly rules: string;
  readonly komi: number;
  /** `[["B","D4"], ...]` -- stones placed before play, e.g. SGF `AB`/`AW`. */
  readonly initialStones: readonly (readonly [string, string])[];
  /** `[["B","Q16"], ...]` in order; `"pass"` is a legal coordinate. */
  readonly moves: readonly (readonly [string, string])[];
  /**
   * Who is to move, `"B"` or `"W"`. **Always sent**, never inferred.
   *
   * With an empty move list and handicap stones in `initialStones`, nothing in
   * the position says whose turn it is, and the two sides guessed differently:
   * the service assumed Black while the analysis engine inferred White. The
   * ownership head came back with a correlation of -0.9 -- perfectly wrong.
   */
  readonly initialPlayer: 'B' | 'W';
}

/** Ask for the network's shape. */
export interface DescribeRequest {
  readonly type: 'describe';
}

/** Ask for every channel of one residual block's output at a position. */
export interface FrameRequest {
  readonly type: 'frame';
  readonly block: number;
  readonly position: SidecarPosition;
}

/**
 * Ask for the raw output heads at a position.
 *
 * Exists for the golden test: these are the values that can be compared against
 * `katago`'s own raw-net output, and so are the only evidence that the feature
 * encoding is right.
 */
export interface HeadsRequest {
  readonly type: 'heads';
  readonly position: SidecarPosition;
}

/**
 * Ask for the static, weight-based importance of every trunk channel.
 *
 * A channel only matters to the extent something downstream reads it, and the
 * weight slice its consumer applies bounds how much it can influence anything
 * whatever its activation happens to be. That makes it a cheap prior on
 * importance: no position, no forward pass, one request per network.
 */
export interface ReaderWeightsRequest {
  readonly type: 'reader_weights';
}

/**
 * Ask for both output heads' parameters, so the heads can be re-run elsewhere.
 *
 * This is what makes the "reduce" feature possible: zeroing trunk channels and
 * asking what the head would then have said cannot be answered by inspecting
 * outputs, only by re-running the head on an altered input. Static per network,
 * about 260 KiB for the reference net, so it is fetched once.
 *
 * The response names every tensor rather than relying on a fixed order,
 * because the set is version-dependent: at model version 15 the pass path gains
 * `policy.linear_pass.bias` and `policy.linear_pass2`, and a consumer counting
 * tensors instead of naming them would misread every later one.
 *
 *   -> {"id":"ks-5","type":"head_weights"}
 *   <- {"id":"ks-5","ok":true,"dtype":"float32","version":14,"activation":"mish",
 *       "trunkChannels":384,"posLen":19,"trunkFinalScale":0.22941573,
 *       "tensors":[{"name":"trunkfinal.beta","shape":[384]},
 *                  {"name":"policy.conv1p","shape":[48,384]}, ...],
 *       "binaryBytes":265152}
 *   <- <265152 bytes: each tensor's values, flat, in the order listed>
 *
 * Shapes are PyTorch's own, untransposed: a 1x1 convolution is `[out, in]` and
 * a linear layer is `[outFeatures, inFeatures]`, both output-major. Nothing is
 * rearranged in transit, so a layout disagreement surfaces as a golden-test
 * failure rather than as plausible wrong numbers.
 *
 * **`trunkFinalScale` is not in the checkpoint.** KataGo's `initialize()` sets
 * it (to `1/sqrt(blocks + 1)` for the `fixscale*` norm kinds) before the state
 * dict loads, so it is part of the network as evaluated while appearing in no
 * saved tensor. Defaulting it to 1 scales the whole head input by about 4.4 and
 * still yields a tidy-looking policy.
 */
export interface HeadWeightsRequest {
  readonly type: 'head_weights';
}

/** What an attribution run differentiates. */
export type AttributionTarget =
  /** The predicted territory balance: the signed sum of the ownership map. */
  | { readonly kind: 'ownership_total' }
  /** Predicted ownership of one intersection. */
  | { readonly kind: 'ownership_point'; readonly x: number; readonly y: number }
  /**
   * The policy **logit** for one move -- not the probability, whose gradient is
   * entangled with every other move through the softmax normaliser.
   */
  | { readonly kind: 'policy_move'; readonly x: number; readonly y: number }
  | { readonly kind: 'policy_pass' }
  /** Win probability for the side to move. */
  | { readonly kind: 'winrate' };

/**
 * Ask what each trunk channel contributed to one scalar output.
 *
 * Runs a forward pass with gradients and backpropagates the target, returning
 * `sum over the board of |activation * gradient|` per block per channel. Far
 * more expensive than `reader_weights` -- a forward and a backward per request
 * -- and exact for the position asked about rather than a static prior.
 */
export interface AttributeRequest {
  readonly type: 'attribute';
  readonly position: SidecarPosition;
  readonly target: AttributionTarget;
  /**
   * Also return the signed per-point `activation * gradient` planes for this
   * block, for callers that want to see *where* a channel earned its score.
   * Omit to get per-channel totals only.
   */
  readonly planeBlock?: number;
}

export type SidecarRequest =
  | DescribeRequest
  | FrameRequest
  | HeadsRequest
  | ReaderWeightsRequest
  | HeadWeightsRequest
  | AttributeRequest;

/** Network shape as the service reports it, before conversion to `NetworkSpec`. */
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
  readonly dtype: 'float32';
}

export interface FrameResponse {
  readonly ok: true;
  readonly dtype: 'float32';
  readonly min: number;
  readonly max: number;
  /** Bytes following this line: `channels * width * height * 4`. */
  readonly binaryBytes: number;
}

export interface HeadsResponse {
  readonly ok: true;
  /** `width * height + 1` probabilities, row-major, pass last. */
  readonly policy: readonly number[];
  /** `width * height` in [-1, 1], row-major, from the side to move's view. */
  readonly ownership: readonly number[];
  /** `[win, loss, noResult]` for the side to move. */
  readonly value: readonly number[];
  readonly scoreLead: number;
}

export interface ReaderWeightsResponse {
  readonly ok: true;
  readonly channels: number;
  /**
   * One name per `channels`-float run, in payload order: `block:i` for block
   * `i` as read by block `i + 1`, then `head:policy` and `head:value` for the
   * last block, which the heads read instead.
   */
  readonly vectors: readonly string[];
  readonly binaryBytes: number;
}

/** One exported tensor: its name and the logical shape its flat run unpacks to. */
export interface HeadWeightTensor {
  readonly name: string;
  readonly shape: readonly number[];
}

export interface HeadWeightsResponse {
  readonly ok: true;
  /** KataGo model version, which decides the pass path's shape. */
  readonly version: number;
  /** The head's non-linearity, by KataGo's own name: `mish` on the reference net. */
  readonly activation: string;
  readonly trunkChannels: number;
  /** The network's extent; a smaller game sits in the top-left of it. */
  readonly posLen: number;
  /** Fixed multiplier the trunk's final norm applies. See the request's note. */
  readonly trunkFinalScale: number;
  /** Tensors in payload order. */
  readonly tensors: readonly HeadWeightTensor[];
  readonly binaryBytes: number;
}

export interface AttributeResponse {
  readonly ok: true;
  readonly blocks: number;
  readonly channels: number;
  /** Present only when `planeBlock` was requested. */
  readonly planeBlock?: number;
  /** `[channels, height, width]`, present only alongside `planeBlock`. */
  readonly planeShape?: readonly number[];
  readonly binaryBytes: number;
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
