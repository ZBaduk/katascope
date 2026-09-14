/**
 * Public entry point of `@katascope/katago-bridge`.
 *
 * Node-only: this package touches `child_process` and `fs`, so it must never be
 * imported from the renderer. The Electron main process is its only consumer.
 */

export { createBridge } from './bridge.js';
export type { Bridge, BridgeOptions } from './bridge.js';

export type {
  AnalysisEngine,
  AnalysisQuery,
  AnalysisResult,
  MoveAnalysis,
  RootAnalysis,
} from './analysis/analysis-engine.js';
export { KataGoAnalysisEngine, toAnalysisResult, toKataGoQuery } from './analysis/katago-analysis-engine.js';
export type { KataGoAnalysisEngineOptions } from './analysis/katago-analysis-engine.js';
export { FakeAnalysisEngine } from './analysis/fake-analysis-engine.js';
export type { FakeAnalysisEngineOptions } from './analysis/fake-analysis-engine.js';

export { decodePlanes, SidecarActivationStore } from './activations/sidecar-activation-store.js';
export type { SidecarActivationStoreOptions } from './activations/sidecar-activation-store.js';
export { SidecarProtocolError } from './activations/sidecar-protocol.js';
export type {
  DescribeRequest,
  DescribeResponse,
  FrameRequest,
  FrameResponse,
  SidecarErrorResponse,
  SidecarNetwork,
  SidecarRequest,
} from './activations/sidecar-protocol.js';

export { checkConfigPaths, CONFIG_FILENAMES, loadConfig, resolvePaths } from './config/load-config.js';

export { LineProcess, ProcessExitError } from './process/line-process.js';
export type { LineProcessOptions } from './process/line-process.js';
