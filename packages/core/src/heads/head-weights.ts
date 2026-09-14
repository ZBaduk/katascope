/**
 * The weights of KataGo's two output heads, as plain data.
 *
 * Exported by the activation service so the heads can be re-run here, on a
 * trunk tensor the UI has altered -- zeroing channels to ask what the head
 * would have said without them. Re-running the head is the only honest way to
 * answer that: a channel's contribution is not additive, because the head
 * passes its input through a non-linearity and a global pool before anything
 * reaches an output.
 *
 * Everything is `Float32Array` in the layout PyTorch stores it, so the sidecar
 * can ship raw bytes and neither side reshapes: a 1x1 convolution's weight is
 * `outChannels * inChannels`, output-major, and a linear layer's is
 * `outFeatures * inFeatures`, output-major.
 */

/** A 1x1 convolution: a per-position matrix multiply over channels. */
export interface Conv1x1 {
  readonly outChannels: number;
  readonly inChannels: number;
  /** `outChannels * inChannels`, output-major. */
  readonly weight: Float32Array;
}

/** A fully-connected layer, with an optional bias. */
export interface LinearLayer {
  readonly outFeatures: number;
  readonly inFeatures: number;
  /** `outFeatures * inFeatures`, output-major. */
  readonly weight: Float32Array;
  readonly bias?: Float32Array;
}

/**
 * Activations KataGo builds with. Only the ones this codebase has met are
 * implemented; anything else must fail loudly rather than silently substitute.
 */
export type HeadActivation = 'mish' | 'relu' | 'identity';

/**
 * What the trunk's final normalisation does before either head reads it.
 *
 * For a `trunk_normless` net -- which the reference b18c384nbt is -- this is
 * KataGo's `BiasMask`: a fixed scale, a per-channel bias, and the board mask.
 * The scale is not in the checkpoint; it comes from the model's `initialize()`
 * (`1/sqrt(blocks + 1)` for the `fixscale*` norm kinds) and is applied before
 * the state dict loads, so it is part of the network as evaluated.
 */
export interface TrunkFinalWeights {
  readonly scale: number;
  /** Per-trunk-channel bias. */
  readonly beta: Float32Array;
}

/**
 * The policy head.
 *
 * Two convolutions read the trunk: `conv1p` for the spatial path and `conv1g`
 * for the pooled one. The pooled branch is where the pass logit comes from,
 * which is why a reduction that ignored it would get the pass badly wrong.
 */
export interface PolicyHeadWeights {
  readonly conv1p: Conv1x1;
  readonly conv1g: Conv1x1;
  /** Bias applied to the pooled branch before its activation. */
  readonly biasg: Float32Array;
  /** Pooled features back to the spatial path: `c_p1 x 3*c_g1`. */
  readonly linearG: LinearLayer;
  /**
   * Pooled features to the pass logits.
   *
   * At model version <= 14 this is a single bias-free linear straight to the
   * output count. From 15 it becomes two layers with an activation between,
   * and `linearPass2` is then present.
   */
  readonly linearPass: LinearLayer;
  readonly linearPass2?: LinearLayer;
  /** Bias applied to the merged spatial path before its activation. */
  readonly bias2: Float32Array;
  readonly conv2p: Conv1x1;
}

/**
 * The value head, as far as ownership.
 *
 * The scalar value outputs (winrate, score) hang off a pooled branch that this
 * does not reproduce; `conv1`, `bias1` and `convOwnership` are what the
 * ownership map needs, and the remaining trunk-reading convolutions are carried
 * because they read the trunk too and a caller may want to measure them.
 */
export interface ValueHeadWeights {
  readonly conv1: Conv1x1;
  readonly bias1: Float32Array;
  readonly convOwnership: Conv1x1;
  readonly convScoring?: Conv1x1;
  /** Reads the trunk directly, not `conv1`'s output. */
  readonly convFuturePos?: Conv1x1;
  /** Reads the trunk directly, not `conv1`'s output. */
  readonly convSeki?: Conv1x1;
}

export interface HeadWeights {
  readonly networkName: string;
  /** KataGo model version, which decides the pass path's shape. */
  readonly version: number;
  readonly activation: HeadActivation;
  readonly trunkChannels: number;
  /** Rows and columns the weights were exported for. */
  readonly posLen: number;
  readonly trunkFinal: TrunkFinalWeights;
  readonly policy: PolicyHeadWeights;
  readonly value: ValueHeadWeights;
}

/** Which head a reduction is run through. */
export type HeadKind = 'policy' | 'ownership';

/**
 * What a channel selection means.
 *
 * `only` keeps the selected channels and zeroes the rest -- "what can the head
 * still say using just these". `without` zeroes the selected ones -- "what does
 * the head lose when these go". They are not complements of each other in any
 * useful sense, because the head is not linear in its input.
 */
export type ReduceMode = 'only' | 'without';
