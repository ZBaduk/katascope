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

export { positionAt, positionCount } from './domain/game-record.js';
export type { GameInfo, GameRecord, SetupStone } from './domain/game-record.js';

export { B6C96, blockIndices, describeNetwork } from './domain/network-spec.js';
export type { NetworkSpec } from './domain/network-spec.js';

export { channelPlane, dequantize, planeLength } from './domain/activation.js';
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

export { DEFAULT_CONFIG, parseConfig, validateConfig } from './config/config.js';
export type { ConfigParseResult, ConfigProblem, KatascopeConfig } from './config/config.js';

export { IPC_CHANNELS, IPC_METHODS, KATASCOPE_API_KEY } from './ipc/contract.js';
export type {
  BridgeMode,
  BridgeStatus,
  ConfigStatus,
  IpcChannel,
  KatascopeApi,
  SubsystemStatus,
} from './ipc/contract.js';
