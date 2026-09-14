/**
 * Talks to `katago analysis` over its JSON protocol: one query per line on
 * stdin, one response per line on stdout.
 *
 * Scope note: a KataGo query may name several turns via `analyzeTurns` and then
 * emits one response per turn, all sharing the query id. The correlator this
 * builds on expects a single response per id, so `analyze` sends exactly one
 * turn per query. Batching several turns would need a multi-response
 * correlator, and no caller needs it yet.
 */

import { moveToAnalysisPair, vertexToGtp, type BoardSize, type SetupStone } from '@katascope/core';
import { LineProcess, type JsonLine } from '../process/line-process.js';
import { RequestCorrelator } from '../process/request-correlator.js';
import type {
  AnalysisEngine,
  AnalysisQuery,
  AnalysisResult,
  MoveAnalysis,
  RootAnalysis,
} from './analysis-engine.js';

export interface KataGoAnalysisEngineOptions {
  /** Path to the `katago` executable. */
  readonly katagoPath: string;
  /** Path to the network file. */
  readonly modelPath: string;
  /** Path to the analysis `.cfg`. */
  readonly configPath: string;
  /** Milliseconds a single query may take. Defaults to 120_000 -- search is slow. */
  readonly timeoutMs?: number;
  /** Called with each stderr line, for the Diagnostics log. */
  readonly onLog?: (line: string) => void;
}

export class KataGoAnalysisEngine implements AnalysisEngine {
  readonly #options: KataGoAnalysisEngineOptions;
  readonly #process: LineProcess;
  readonly #correlator: RequestCorrelator;
  #started: Promise<void> | undefined;

  constructor(options: KataGoAnalysisEngineOptions) {
    this.#options = options;
    this.#process = new LineProcess({
      command: options.katagoPath,
      args: ['analysis', '-model', options.modelPath, '-config', options.configPath],
      ...(options.onLog === undefined ? {} : { onStderr: options.onLog }),
    });
    this.#correlator = new RequestCorrelator(this.#process, {
      timeoutMs: options.timeoutMs ?? 120_000,
    });
  }

  start(): Promise<void> {
    this.#started ??= this.#process.start().then(() => {
      this.#correlator.attach();
    });
    return this.#started;
  }

  async version(): Promise<string> {
    await this.start();
    const response = await this.#correlator.request({ action: 'query_version' });
    throwIfError(response);
    const version = response['version'];
    return typeof version === 'string' ? version : 'unknown';
  }

  async analyze(query: AnalysisQuery): Promise<AnalysisResult> {
    await this.start();
    const response = await this.#correlator.request(toKataGoQuery(query));
    throwIfError(response);
    return toAnalysisResult(response, query.turnNumber);
  }

  async dispose(): Promise<void> {
    this.#correlator.rejectAll(new Error('analysis engine disposed'));
    await this.#process.stop();
  }

  /** Recent stderr, surfaced in Diagnostics when a start fails. */
  get log(): string {
    return this.#process.stderrTail;
  }

  get modelPath(): string {
    return this.#options.modelPath;
  }
}

/** Builds the wire query. Exported so tests can assert the encoding without spawning. */
export function toKataGoQuery(query: AnalysisQuery): Record<string, unknown> {
  return {
    boardXSize: query.boardSize.width,
    boardYSize: query.boardSize.height,
    rules: query.rules,
    komi: query.komi,
    initialStones: query.initialStones.map((stone) => encodeStone(query.boardSize, stone)),
    moves: query.moves.map((move) => moveToAnalysisPair(query.boardSize, move)),
    analyzeTurns: [query.turnNumber],
    maxVisits: query.maxVisits,
    includePolicy: false,
  };
}

function encodeStone(size: BoardSize, stone: SetupStone): readonly [string, string] {
  return [stone.color === 'black' ? 'B' : 'W', vertexToGtp(size, stone.vertex)];
}

/** Narrows a raw response line into an `AnalysisResult`, tolerating absent fields. */
export function toAnalysisResult(line: JsonLine, fallbackTurn: number): AnalysisResult {
  const rootInfo = asRecord(line['rootInfo']);
  const root: RootAnalysis = {
    winrate: numberOr(rootInfo?.['winrate'], 0.5),
    scoreLead: numberOr(rootInfo?.['scoreLead'], 0),
    visits: numberOr(rootInfo?.['visits'], 0),
  };
  const rawMoves = Array.isArray(line['moveInfos']) ? line['moveInfos'] : [];
  const moveInfos: MoveAnalysis[] = [];
  for (const raw of rawMoves) {
    const info = asRecord(raw);
    const move = info?.['move'];
    if (typeof move !== 'string') continue;
    moveInfos.push({
      move,
      visits: numberOr(info?.['visits'], 0),
      winrate: numberOr(info?.['winrate'], 0.5),
      scoreLead: numberOr(info?.['scoreLead'], 0),
      prior: numberOr(info?.['prior'], 0),
      order: numberOr(info?.['order'], moveInfos.length),
      pv: Array.isArray(info?.['pv']) ? info['pv'].filter((p): p is string => typeof p === 'string') : [],
    });
  }
  return { turnNumber: numberOr(line['turnNumber'], fallbackTurn), rootInfo: root, moveInfos };
}

function throwIfError(line: JsonLine): void {
  const error = line['error'];
  if (typeof error === 'string') {
    const field = line['field'];
    throw new Error(`KataGo rejected the query: ${error}${typeof field === 'string' ? ` (${field})` : ''}`);
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}
