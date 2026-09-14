/**
 * Talks to `katago analysis` over its JSON protocol: one query per line on
 * stdin, one response per line on stdout.
 *
 * Scope note: a KataGo query may name several turns via `analyzeTurns` and then
 * emits one response per turn, all sharing the query id. The correlator this
 * builds on expects a single response per id, so `analyze` sends exactly one
 * turn per query. Batching several turns would need a multi-response
 * correlator, and no caller needs it yet.
 *
 * Lifecycle: the engine is started lazily and can be restarted in place. A
 * crashed engine leaves this object usable -- `restart()` replaces the process
 * and the caller keeps its reference. That matters because the bridge hands
 * this object to the IPC layer once, at startup.
 */

import { moveToAnalysisPair, vertexToGtp, type BoardSize, type SetupStone } from '@katascope/core';
import { LineProcess, type JsonLine } from '../process/line-process.js';
import { RequestCorrelator } from '../process/request-correlator.js';
import type {
  AnalysisEngine,
  AnalysisQuery,
  AnalysisResult,
  EngineState,
  MoveAnalysis,
  RootAnalysis,
} from './analysis-engine.js';

export interface KataGoAnalysisEngineOptions {
  readonly katagoPath: string;
  readonly modelPath: string;
  readonly configPath: string;
  /** Milliseconds a single query may take. Defaults to 120_000 -- search is slow. */
  readonly timeoutMs?: number;
  readonly onLog?: (line: string) => void;
  /**
   * How many times to relaunch after an unexpected exit before giving up.
   * Defaults to 0: restarts are explicit. A dev tool that silently respawns a
   * crashing engine hides the crash.
   */
  readonly maxAutoRestarts?: number;
}

export class KataGoAnalysisEngine implements AnalysisEngine {
  readonly #options: KataGoAnalysisEngineOptions;
  #process: LineProcess | undefined;
  #correlator: RequestCorrelator | undefined;
  #started: Promise<void> | undefined;
  #state: EngineState = 'stopped';
  #autoRestartsUsed = 0;
  #disposed = false;

  constructor(options: KataGoAnalysisEngineOptions) {
    this.#options = options;
  }

  get state(): EngineState {
    return this.#state;
  }

  start(): Promise<void> {
    if (this.#disposed) return Promise.reject(new Error('analysis engine disposed'));
    this.#started ??= this.#launch();
    return this.#started;
  }

  async restart(): Promise<void> {
    if (this.#disposed) throw new Error('analysis engine disposed');
    await this.#teardown(new Error('analysis engine restarting'));
    this.#autoRestartsUsed = 0;
    this.#started = this.#launch();
    await this.#started;
  }

  async version(): Promise<string> {
    const response = await this.#request({ action: 'query_version' });
    const version = response['version'];
    return typeof version === 'string' ? version : 'unknown';
  }

  async analyze(query: AnalysisQuery): Promise<AnalysisResult> {
    const response = await this.#request(toKataGoQuery(query));
    return toAnalysisResult(response, query.turnNumber);
  }

  async dispose(): Promise<void> {
    this.#disposed = true;
    await this.#teardown(new Error('analysis engine disposed'));
  }

  /** Recent stderr, surfaced in Diagnostics when a start fails. */
  get log(): string {
    return this.#process?.stderrTail ?? '';
  }

  get modelPath(): string {
    return this.#options.modelPath;
  }

  async #launch(): Promise<void> {
    this.#state = 'starting';
    const process = new LineProcess({
      command: this.#options.katagoPath,
      args: ['analysis', '-model', this.#options.modelPath, '-config', this.#options.configPath],
      ...(this.#options.onLog === undefined ? {} : { onStderr: this.#options.onLog }),
    });
    const correlator = new RequestCorrelator(process, {
      timeoutMs: this.#options.timeoutMs ?? 120_000,
    });
    this.#process = process;
    this.#correlator = correlator;

    try {
      await process.start();
    } catch (error) {
      this.#state = 'failed';
      throw error;
    }
    correlator.attach();
    this.#state = 'ready';
  }

  /**
   * Sends one request, relaunching first if the engine died and auto-restart
   * is enabled. A request is never retried across a restart: search results
   * are not idempotent enough to replay behind the caller's back.
   */
  async #request(payload: Record<string, unknown>): Promise<JsonLine> {
    await this.start();

    if (this.#process?.exitError !== undefined) {
      this.#state = 'failed';
      if (this.#autoRestartsUsed >= (this.#options.maxAutoRestarts ?? 0)) {
        throw this.#process.exitError;
      }
      this.#autoRestartsUsed++;
      const previous = this.#process.exitError;
      await this.#teardown(previous);
      this.#started = this.#launch();
      await this.#started;
    }

    const correlator = this.#correlator;
    if (correlator === undefined) throw new Error('analysis engine is not running');
    const response = await correlator.request(payload);
    throwIfError(response);
    return response;
  }

  async #teardown(reason: Error): Promise<void> {
    this.#correlator?.rejectAll(reason);
    const process = this.#process;
    this.#process = undefined;
    this.#correlator = undefined;
    this.#started = undefined;
    this.#state = 'stopped';
    await process?.stop();
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
    ...(query.initialPlayer === undefined ? {} : { initialPlayer: query.initialPlayer }),
    maxVisits: query.maxVisits,
    includePolicy: query.includePolicy ?? false,
    includeOwnership: query.includeOwnership ?? false,
    // The komi we send must be the komi the network sees. Chinese rules carry
    // whiteHandicapBonus=N, which silently adds the handicap stone count to
    // White's komi -- a 4-point shift on a 4-stone game, and enough to make the
    // engine and the activation service disagree about the position.
    whiteHandicapBonus: '0',
    overrideSettings: {
      // The analysis engine defaults this to TRUE, which evaluates the root with
      // maxHistory = 0 -- no history planes at all, however many moves the query
      // supplied. The activation service always encodes the history it is given,
      // so leaving this on makes the board overlays and the activation heatmaps
      // describe different positions.
      //
      // Sent per query rather than left to `katagoConfigPath`: the config is the
      // user's file and may be KataGo's stock analysis_example.cfg, where the
      // default applies. This makes the guarantee ours.
      ignorePreRootHistory: false,
    },
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

  const policy = numberArrayOrUndefined(line['policy']);
  const ownership = numberArrayOrUndefined(line['ownership']);
  return {
    turnNumber: numberOr(line['turnNumber'], fallbackTurn),
    rootInfo: root,
    moveInfos,
    // exactOptionalPropertyTypes: omit the key rather than set it undefined.
    ...(policy === undefined ? {} : { policy }),
    ...(ownership === undefined ? {} : { ownership }),
  };
}

function numberArrayOrUndefined(value: unknown): readonly number[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
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
