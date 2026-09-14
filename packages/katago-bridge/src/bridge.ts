/**
 * Assembles the Node-side subsystems from a config.
 *
 * This is the only place that decides fake-versus-live. Everything downstream
 * -- including the whole Electron main process -- sees only `AnalysisEngine`
 * and `ActivationStore`.
 *
 * Starting is lazy and non-fatal: a missing KataGo binary must not stop the app
 * from opening. `probe()` reports what actually came up, and Diagnostics shows
 * that to the user.
 */

import { FakeActivationStore, type ActivationStore, type SubsystemStatus, type KatascopeConfig } from '@katascope/core';
import type { AnalysisEngine } from './analysis/analysis-engine.js';
import { FakeAnalysisEngine } from './analysis/fake-analysis-engine.js';
import { KataGoAnalysisEngine } from './analysis/katago-analysis-engine.js';
import { SidecarActivationStore } from './activations/sidecar-activation-store.js';

export interface BridgeOptions {
  /** Receives log lines from both subsystems, tagged with their origin. */
  readonly onLog?: (source: 'katago' | 'sidecar', line: string) => void;
}

export interface Bridge {
  readonly mode: 'fake' | 'live';
  readonly analysisEngine: AnalysisEngine;
  readonly activationStore: ActivationStore;
  /** Attempts to reach both subsystems and reports what happened. Never throws. */
  probe(): Promise<readonly SubsystemStatus[]>;
  dispose(): Promise<void>;
}

export function createBridge(config: KatascopeConfig, options: BridgeOptions = {}): Bridge {
  return config.useFakes ? createFakeBridge() : createLiveBridge(config, options);
}

function createFakeBridge(): Bridge {
  const analysisEngine = new FakeAnalysisEngine();
  const activationStore = new FakeActivationStore();
  return {
    mode: 'fake',
    analysisEngine,
    activationStore,
    probe: async () => [
      {
        name: 'analysis-engine',
        mode: 'fake',
        ready: true,
        detail: `FakeAnalysisEngine ${await analysisEngine.version()}`,
      },
      {
        name: 'activation-store',
        mode: 'fake',
        ready: true,
        detail: describeStore(await activationStore.describe()),
      },
    ],
    dispose: async () => {
      await Promise.all([analysisEngine.dispose(), activationStore.dispose()]);
    },
  };
}

function createLiveBridge(config: KatascopeConfig, options: BridgeOptions): Bridge {
  const analysisEngine = new KataGoAnalysisEngine({
    katagoPath: config.katagoPath,
    modelPath: config.modelPath,
    configPath: config.katagoConfigPath,
    ...(options.onLog === undefined ? {} : { onLog: (line) => options.onLog?.('katago', line) }),
  });
  const activationStore = new SidecarActivationStore({
    pythonPath: config.pythonPath,
    sidecarPath: config.sidecarPath,
    modelPath: config.modelPath,
    ...(options.onLog === undefined ? {} : { onLog: (line) => options.onLog?.('sidecar', line) }),
  });

  return {
    mode: 'live',
    analysisEngine,
    activationStore,
    probe: async () => [
      await probeOne('analysis-engine', async () => `KataGo ${await analysisEngine.version()}`),
      await probeOne('activation-store', async () => describeStore(await activationStore.describe())),
    ],
    dispose: async () => {
      await Promise.all([analysisEngine.dispose(), activationStore.dispose()]);
    },
  };
}

async function probeOne(
  name: SubsystemStatus['name'],
  detail: () => Promise<string>,
): Promise<SubsystemStatus> {
  try {
    return { name, mode: 'live', ready: true, detail: await detail() };
  } catch (error) {
    return { name, mode: 'live', ready: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

function describeStore(availability: Awaited<ReturnType<ActivationStore['describe']>>): string {
  const { spec, maxMoveNumber, dtype } = availability;
  const { width, height } = spec.boardSize;
  return `${spec.name} b${spec.blocks}c${spec.channels} @ ${width}x${height}, moves 0..${maxMoveNumber}, ${dtype}`;
}
