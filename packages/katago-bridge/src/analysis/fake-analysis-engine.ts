/**
 * An `AnalysisEngine` that spawns nothing.
 *
 * Values are deterministic functions of the query, so the UI shows stable,
 * plausible-looking numbers with no KataGo installed. They mean nothing.
 */

import { gtpToVertex, vertexToGtp, type Vertex } from '@katascope/core';
import type {
  AnalysisEngine,
  AnalysisQuery,
  AnalysisResult,
  EngineState,
  MoveAnalysis,
} from './analysis-engine.js';

export interface FakeAnalysisEngineOptions {
  /** Candidate moves to report per query. Defaults to 8. */
  readonly candidates?: number;
  readonly version?: string;
}

export class FakeAnalysisEngine implements AnalysisEngine {
  readonly #candidates: number;
  readonly #version: string;
  #disposed = false;
  #state: EngineState = 'stopped';

  constructor(options: FakeAnalysisEngineOptions = {}) {
    this.#candidates = options.candidates ?? 8;
    this.#version = options.version ?? 'fake-0.1.0';
  }

  get state(): EngineState {
    return this.#state;
  }

  async start(): Promise<void> {
    this.#assertOpen();
    this.#state = 'ready';
  }

  /** Nothing to relaunch, but the interface promises it works. */
  async restart(): Promise<void> {
    this.#assertOpen();
    this.#state = 'ready';
  }

  async version(): Promise<string> {
    this.#assertOpen();
    return this.#version;
  }

  async analyze(query: AnalysisQuery): Promise<AnalysisResult> {
    this.#assertOpen();
    const { boardSize, turnNumber, maxVisits } = query;
    const moveInfos: MoveAnalysis[] = [];
    let remaining = maxVisits;

    for (let order = 0; order < this.#candidates; order++) {
      const seed = turnNumber * 31 + order * 7 + 1;
      const vertex: Vertex = {
        x: (seed * 5) % boardSize.width,
        y: (seed * 11) % boardSize.height,
      };
      const share = 1 / 2 ** (order + 1);
      const visits = Math.max(1, Math.floor(maxVisits * share));
      remaining -= visits;
      moveInfos.push({
        move: vertexToGtp(boardSize, vertex),
        visits,
        winrate: clamp01(0.5 + 0.18 * Math.sin(seed) - order * 0.012),
        scoreLead: Math.fround(2.4 * Math.cos(seed) - order * 0.4),
        prior: clamp01(share * 0.9),
        order,
        pv: [vertexToGtp(boardSize, vertex)],
      });
    }

    const area = boardSize.width * boardSize.height;
    const policy = query.includePolicy === true ? fakePolicy(moveInfos, boardSize, area) : undefined;
    const ownership =
      query.includeOwnership === true
        ? Array.from({ length: area }, (_, i) => Math.fround(Math.sin(turnNumber + i * 0.37)))
        : undefined;

    return {
      turnNumber,
      ...(policy === undefined ? {} : { policy }),
      ...(ownership === undefined ? {} : { ownership }),
      rootInfo: {
        winrate: moveInfos[0]?.winrate ?? 0.5,
        scoreLead: moveInfos[0]?.scoreLead ?? 0,
        visits: Math.max(maxVisits - Math.max(0, remaining), 1),
      },
      moveInfos,
    };
  }

  async dispose(): Promise<void> {
    this.#disposed = true;
    this.#state = 'stopped';
  }

  #assertOpen(): void {
    if (this.#disposed) throw new Error('FakeAnalysisEngine has been disposed');
  }
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/**
 * A policy vector shaped like KataGo's: probabilities summing to 1 over the
 * candidates, `-1` everywhere the fake considers illegal (nowhere, here), and
 * pass last.
 */
function fakePolicy(
  moveInfos: readonly MoveAnalysis[],
  boardSize: { readonly width: number; readonly height: number },
  area: number,
): number[] {
  const policy = new Array<number>(area + 1).fill(0);
  let total = 0;
  for (const info of moveInfos) {
    const vertex = gtpToVertex(boardSize, info.move);
    if (vertex === undefined) continue;
    const index = vertex.y * boardSize.width + vertex.x;
    policy[index] = info.prior;
    total += info.prior;
  }
  policy[area] = Math.max(0, 1 - total);
  return policy;
}
