/**
 * Public entry point of `@katascope/core`.
 *
 * Every other package imports from `@katascope/core` and nothing deeper --
 * see CLAUDE.md. Anything not re-exported here is internal.
 */

export {
  Board,
  boardArea,
  isOnBoard,
  neighbours,
  opposite,
  squareBoardSize,
  vertexFromIndex,
  vertexIndex,
} from './domain/board.js';
export type { BoardSize, Color, Intersection, Vertex } from './domain/board.js';

export { gtpToVertex, moveToAnalysisPair, moveToGtp, pass, play, vertexToGtp } from './domain/move.js';
export type { Move, PassMove, PlayMove, Player } from './domain/move.js';

export { playerToMoveAt, positionAt, positionCount } from './domain/game-record.js';
export {
  appendMove,
  applyMove,
  chooseMove,
  emptyGame,
  isLegalMove,
  koAt,
  legalMoves,
  ownEyes,
  playerAt,
} from './domain/play.js';
export type { ChooseMoveOptions, MoveResult, RuleState } from './domain/play.js';
export type { GameInfo, GameRecord, SetupStone } from './domain/game-record.js';

export { B6C96, blockIndices, describeNetwork } from './domain/network-spec.js';
export type { NetworkSpec } from './domain/network-spec.js';

export { channelPlane, dequantize, planeLength } from './domain/activation.js';
export {
  attributionForBlock,
  describeTarget,
  readerNormsFor,
  targetVertex,
} from './domain/attribution.js';
export type {
  Attribution,
  AttributionRequest,
  AttributionTarget,
  ReaderHead,
  ReaderWeights,
} from './domain/attribution.js';
export type {
  ActivationAvailability,
  ActivationFrame,
  ActivationKey,
  ActivationStore,
  PlaneBuffer,
  PlaneDType,
  ValueRange,
} from './domain/activation.js';

export { parseSgf, parseSgfCollection, SgfParseError, toGameRecord } from './sgf/parser.js';
export type { SgfNode } from './sgf/parser.js';

export { FakeActivationStore, fakeBoardSize, generateFrame } from './activation/fake-activation-store.js';
export type { FakeActivationStoreOptions } from './activation/fake-activation-store.js';
export { PLANTED_CHANNELS, plantedRegion } from './activation/fake-activation-store.js';
export type { PlantedChannel } from './activation/fake-activation-store.js';

export {
  addChannelBias,
  applyActivation,
  boardMask,
  conv1x1,
  fullGeometry,
  HeadShapeError,
  headInput,
  kataGPool,
  kataValueGPool,
  linear,
  maskChannels,
  mish,
  ownershipHead,
  policyHead,
  policySoftmax,
  reduceHead,
} from './heads/heads.js';
export type { HeadField, HeadGeometry, HeadReduction, PolicyHeadOutput } from './heads/heads.js';
export type {
  Conv1x1,
  HeadActivation,
  HeadKind,
  HeadWeights,
  LinearLayer,
  PolicyHeadWeights,
  ReduceMode,
  TrunkFinalWeights,
  ValueHeadWeights,
} from './heads/head-weights.js';

export {
  DEFAULT_SPECIFIC_THRESHOLD,
  DEFAULT_STD_FLOOR,
  planeRegionScore,
  prepareRegion,
  qualifyingDirection,
  rankHits,
  scoreFor,
  searchFrame,
  summariseHits,
} from './activation/region-search.js';
export type {
  ChannelSummary,
  HitDirection,
  PlaneRegionScore,
  PreparedRegion,
  RegionDirection,
  RegionHit,
  RegionQuery,
  SearchFrameInput,
} from './activation/region-search.js';

export {
  encodeKact,
  encodeKactFrameData,
  frameByteRange,
  KACT_INDEX_ENTRY_BYTES,
  kactIndexEntryBytes,
  planKact,
  KACT_MAGIC,
  KACT_VERSION,
  kactMoveNumbers,
  kactNetworkSpec,
  KactFormatError,
  readKactFrame,
  readKactIndex,
} from './kact/codec.js';
export type { KactFile, KactIndexEntry, KactMetadata, KactPlan } from './kact/codec.js';
export { bytesSource, KactActivationStore } from './kact/kact-store.js';
export type { KactByteSource } from './kact/kact-store.js';
export {
  decodeFloat16Array,
  encodeFloat16Array,
  FLOAT16_MAX,
  fromFloat16Bits,
  toFloat16Bits,
} from './kact/float16.js';

export { DEFAULT_CONFIG, parseConfig, validateConfig } from './config/config.js';
export type { ConfigParseResult, ConfigProblem, KatascopeConfig } from './config/config.js';

export { IPC_CHANNELS, IPC_METHODS, KATASCOPE_API_KEY } from './ipc/contract.js';
export type {
  BridgeMode,
  BridgeStatus,
  ConfigStatus,
  IpcChannel,
  KatascopeApi,
  LoadedCapture,
  LoadedGame,
  PositionAnalysis,
  PositionAnalysisRequest,
  SubsystemStatus,
} from './ipc/contract.js';
