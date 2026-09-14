/**
 * The app's shared state: which game is open and which move is selected.
 *
 * Both tabs read this, so stepping a move on the Board tab moves the
 * Diagnostics tab with it. It is `providedIn: 'root'` precisely so there is one
 * instance and one answer to "which position are we looking at".
 *
 * It also owns the two lazy caches -- analysis for the board overlays,
 * activation frames for the channel grid -- because caching and cancellation
 * are the same problem in both cases and worth solving once:
 *
 * * **Lazy.** Nothing is fetched until something asks. Toggling an overlay off
 *   and stepping through fifty moves must not run fifty analyses.
 * * **Cancellable.** A response for a move the user has already left is
 *   discarded. Holding the arrow key down would otherwise repaint the board
 *   with whatever arrived last, which is not necessarily the current move.
 * * **Bounded.** The cache evicts; a long game at 550 KiB a frame would
 *   otherwise consume the renderer's heap.
 *
 * Rendering decisions live in `board-geometry` and `overlays`, not here.
 */

import { computed, Injectable, inject, signal } from '@angular/core';
import {
  appendMove,
  Board,
  emptyGame,
  koAt,
  playerToMoveAt,
  positionAt,
  readerNormsFor,
  type ActivationFrame,
  type GameRecord,
  type Attribution,
  type AttributionTarget,
  type LoadedCapture,
  type NetworkSpec,
  type ReaderHead,
  type ReaderWeights,
  type BoardSize,
  type Move,
  type PositionAnalysis,
  type Vertex,
} from '@katascope/core';
import { KATASCOPE_API } from '../platform/katascope-api';
import type { ChannelStats } from '../activation/channel-stats';

/** How many entries each cache holds before evicting the oldest. */
export const ANALYSIS_CACHE_LIMIT = 256;
export const FRAME_CACHE_LIMIT = 24;
export const ATTRIBUTION_CACHE_LIMIT = 32;

/** Why a lazily fetched value is not available. */
export type FetchState = 'idle' | 'loading' | 'ready' | 'error';

export interface LoadedGameInfo {
  readonly path: string;
  readonly game: GameRecord;
}

@Injectable({ providedIn: 'root' })
export class SessionStore {
  readonly #api = inject(KATASCOPE_API);

  // ---- game and move selection -------------------------------------------

  readonly #game = signal<LoadedGameInfo | undefined>(undefined);
  readonly #moveNumber = signal(0);

  readonly game = this.#game.asReadonly();
  readonly moveNumber = this.#moveNumber.asReadonly();

  /** True once a game is open. Everything else degrades quietly until then. */
  readonly hasGame = computed(() => this.#game() !== undefined);

  /**
   * Highest selectable move number: the position after the last move.
   *
   * Falls back to the capture's highest move when no game is loaded. Captures
   * embed their SGF, so that only happens for ones written before the format
   * did -- but without the fallback those are unbrowsable, with the slider
   * pinned at zero and frames the capture plainly holds unreachable.
   */
  readonly lastMoveNumber = computed(() => {
    const loaded = this.#game();
    if (loaded !== undefined) return loaded.game.moves.length;
    const moves = this.#capture()?.moveNumbers;
    return moves === undefined || moves.length === 0 ? 0 : Math.max(...moves);
  });

  /** The board at the selected move. Recomputed from the record, never mutated. */
  readonly board = computed<Board | undefined>(() => {
    const loaded = this.#game();
    if (loaded === undefined) return undefined;
    return positionAt(loaded.game, this.#moveNumber());
  });

  /** The move that produced the current position, for the last-move marker. */
  readonly lastPlayedMove = computed(() => {
    const loaded = this.#game();
    const index = this.#moveNumber() - 1;
    if (loaded === undefined || index < 0) return undefined;
    return loaded.game.moves[index];
  });

  /**
   * Replaces the open game and resets the selection.
   *
   * Both caches are cleared: they are keyed by move number, and a move number
   * means something different in a different game.
   */
  setGame(loaded: LoadedGameInfo): void {
    this.#game.set(loaded);
    this.#moveNumber.set(0);
    this.#analysisCache.clear();
    this.#frameCache.clear();
    this.#analysisRequest++;
    this.#frameRequest++;
    this.#analysis.set(undefined);
    this.#analysisState.set('idle');
    this.#frame.set(undefined);
    this.#frameState.set('idle');
  }

  /** Selects a move, clamped to the loaded game. Out-of-range is not an error. */
  setMoveNumber(moveNumber: number): void {
    const last = this.lastMoveNumber();
    const clamped = Number.isFinite(moveNumber) ? Math.round(moveNumber) : 0;
    this.#moveNumber.set(Math.max(0, Math.min(clamped, last)));
  }

  stepMove(delta: number): void {
    this.setMoveNumber(this.#moveNumber() + delta);
  }

  firstMove(): void {
    this.setMoveNumber(0);
  }

  lastMove(): void {
    this.setMoveNumber(this.lastMoveNumber());
  }

  /**
   * Plays a move, extending the game and telling the bridge.
   *
   * The bridge is updated **first and awaited**. Everything downstream -- the
   * analysis engine, the activation service -- turns a move number into a
   * position using the record it holds, so a renderer that advanced first would
   * spend the gap asking for frames of a position the sidecar has never heard
   * of. Making the bridge agree before the UI moves keeps that window shut.
   *
   * Playing from a move the user has navigated back to truncates what followed:
   * it is a new branch, and keeping the old continuation would leave a record
   * whose board does not match its own move list.
   */
  async playMove(move: Move): Promise<void> {
    const loaded = this.#game();
    if (loaded === undefined) throw new Error('no game is open');

    const at = this.#moveNumber();
    const next = appendMove(loaded.game, move, at);
    if (this.#api !== null) await this.#api.setGame(next);

    this.#game.set({ ...loaded, game: next });
    // A branch invalidates everything cached beyond the branch point; the
    // positions before it are untouched and their entries stay good.
    this.#forgetFrom(at);
    this.setMoveNumber(next.moves.length);
  }

  /** Starts a fresh game, replacing whatever is open. */
  async newGame(size: BoardSize, komi = 7.5): Promise<void> {
    const game = emptyGame(size, komi);
    if (this.#api !== null) await this.#api.setGame(game);
    this.setGame({ path: '(new game)', game });
  }

  /** Drops cached values for every move number at or after `moveNumber`. */
  #forgetFrom(moveNumber: number): void {
    for (const key of [...this.#analysisCache.keys()]) {
      if (key >= moveNumber) this.#analysisCache.delete(key);
    }
    for (const key of [...this.#frameCache.keys()]) {
      const move = Number.parseInt(key.split(':')[0] ?? '', 10);
      if (Number.isFinite(move) && move >= moveNumber) this.#frameCache.delete(key);
    }
    // The per-channel statistics are computed across the whole game, so a new
    // move makes every block's sample stale rather than only the later ones.
    this.#statsCache.clear();
    this.#attributionCache.clear();
    this.#analysisRequest++;
    this.#frameRequest++;
  }

  /** The ko point in force at the selected move, for legality. */
  readonly koPoint = computed(() => {
    const loaded = this.#game();
    return loaded === undefined ? undefined : koAt(loaded.game, this.#moveNumber());
  });

  // ---- activation selection ----------------------------------------------

  readonly #spec = signal<NetworkSpec | undefined>(undefined);
  readonly #block = signal(0);
  readonly #channel = signal(0);

  readonly networkSpec = this.#spec.asReadonly();
  readonly block = this.#block.asReadonly();
  readonly channel = this.#channel.asReadonly();

  /** Records the network shape, then re-clamps the block to it. */
  setNetworkSpec(spec: NetworkSpec): void {
    this.#spec.set(spec);
    this.setBlock(this.#block());
  }

  // ---- the open capture, if any ------------------------------------------

  readonly #capture = signal<LoadedCapture | undefined>(undefined);
  readonly capture = this.#capture.asReadonly();

  /** True while activations come from a `.kact` rather than a live model. */
  readonly hasCapture = computed(() => this.#capture() !== undefined);

  /**
   * Move numbers activations can be had for.
   *
   * A capture may hold a subset of the game's moves -- `npm run dump` takes
   * `--max-moves` and `--blocks` -- so the grid must not offer frames that do
   * not exist. Undefined means "whatever the game has".
   */
  readonly activationMoves = computed<readonly number[] | undefined>(
    () => this.#capture()?.moveNumbers,
  );

  readonly activationBlocks = computed<readonly number[] | undefined>(
    () => this.#capture()?.blockNumbers,
  );

  /**
   * Opens a capture: its network shape, its blocks, and the game it carries.
   *
   * Clears the frame cache and the statistics, which are keyed by block and
   * would otherwise describe the previous source.
   */
  setCapture(capture: LoadedCapture): void {
    this.#capture.set(capture);
    this.#readerWeights.set(undefined);
    this.#attributionCache.clear();
    this.setNetworkSpec(capture.spec);
    this.#frameCache.clear();
    this.#statsCache.clear();
    this.#frameRequest++;
    this.#frame.set(undefined);
    this.#frameState.set('idle');
    const firstBlock = capture.blockNumbers[0];
    if (firstBlock !== undefined) this.setBlock(firstBlock);
  }

  /** Goes back to the live or fake source. */
  clearCapture(): void {
    this.#capture.set(undefined);
    this.#readerWeights.set(undefined);
    this.#attributionCache.clear();
    this.#frameCache.clear();
    this.#statsCache.clear();
    this.#frameRequest++;
    this.#frame.set(undefined);
    this.#frameState.set('idle');
  }

  setBlock(block: number): void {
    const blocks = this.#spec()?.blocks;
    const clamped = Number.isFinite(block) ? Math.round(block) : 0;
    const limit = blocks === undefined ? clamped : Math.min(clamped, blocks - 1);
    this.#block.set(Math.max(0, limit));
  }

  /**
   * Selects a channel, clamped to the frame actually received.
   *
   * The frame is the authority rather than the spec: if a store served a
   * narrower frame than the spec advertises, a selection inside the spec would
   * index past the data.
   */
  setChannel(channel: number): void {
    const channels = this.#frame()?.channels;
    const clamped = Number.isFinite(channel) ? Math.round(channel) : 0;
    const limit = channels === undefined ? clamped : Math.min(clamped, channels - 1);
    this.#channel.set(Math.max(0, limit));
  }

  // ---- the region the channel search asks about --------------------------

  readonly #searchRegion = signal<readonly Vertex[]>([]);

  /**
   * Intersections the region search scores against.
   *
   * App-wide for the same reason as the attribution target: it is selected on
   * the Board tab, where there is a board to click, and consumed on the
   * Diagnostics tab, where the search runs.
   *
   * Deliberately **not** cleared when a game is loaded. Unlike a move number, an
   * intersection means the same thing in every game -- "the top-left corner" is
   * the top-left corner -- and comparing the same region across games is a
   * reasonable thing to want. It is cleared only when the user clears it.
   */
  readonly searchRegion = this.#searchRegion.asReadonly();

  readonly hasSearchRegion = computed(() => this.#searchRegion().length > 0);

  /** Adds an intersection to the region, or removes it if already selected. */
  toggleRegionPoint(vertex: Vertex): void {
    this.#searchRegion.update((region) => {
      const index = region.findIndex((v) => v.x === vertex.x && v.y === vertex.y);
      if (index < 0) return [...region, vertex];
      return [...region.slice(0, index), ...region.slice(index + 1)];
    });
  }

  clearSearchRegion(): void {
    this.#searchRegion.set([]);
  }

  // ---- lazy analysis for the board overlays ------------------------------

  readonly #analysisCache = new Map<number, PositionAnalysis>();
  readonly #analysis = signal<PositionAnalysis | undefined>(undefined);
  readonly #analysisState = signal<FetchState>('idle');
  readonly #analysisError = signal<string | undefined>(undefined);
  #analysisRequest = 0;

  readonly analysis = this.#analysis.asReadonly();
  readonly analysisState = this.#analysisState.asReadonly();
  readonly analysisError = this.#analysisError.asReadonly();

  /**
   * Ensures analysis for the current move, fetching only if needed.
   *
   * Safe to call on every change: a cache hit is synchronous and an in-flight
   * request for the same move is not duplicated.
   */
  async ensureAnalysis(maxVisits = 1): Promise<void> {
    const moveNumber = this.#moveNumber();
    if (this.#api === null || !this.hasGame()) {
      this.#analysisState.set('idle');
      return;
    }

    const cached = this.#analysisCache.get(moveNumber);
    if (cached !== undefined) {
      this.#analysis.set(cached);
      this.#analysisState.set('ready');
      this.#analysisError.set(undefined);
      return;
    }

    const token = ++this.#analysisRequest;
    this.#analysisState.set('loading');
    try {
      const result = await this.#api.analyzePosition({ moveNumber, maxVisits });
      // The user may have stepped on while this was in flight.
      if (token !== this.#analysisRequest) return;
      remember(this.#analysisCache, moveNumber, result, ANALYSIS_CACHE_LIMIT);
      this.#analysis.set(result);
      this.#analysisState.set('ready');
      this.#analysisError.set(undefined);
    } catch (error) {
      if (token !== this.#analysisRequest) return;
      // Keep the last good analysis on screen; an empty board is less useful
      // than a stale one plus a visible error.
      this.#analysisError.set(error instanceof Error ? error.message : String(error));
      this.#analysisState.set('error');
    }
  }

  /** Abandons any in-flight analysis, so a late reply cannot land. */
  cancelAnalysis(): void {
    this.#analysisRequest++;
    if (this.#analysisState() === 'loading') this.#analysisState.set('idle');
  }

  // ---- lazy activation frames --------------------------------------------

  readonly #frameCache = new Map<string, ActivationFrame>();
  readonly #frame = signal<ActivationFrame | undefined>(undefined);
  readonly #frameState = signal<FetchState>('idle');
  readonly #frameError = signal<string | undefined>(undefined);
  #frameRequest = 0;

  readonly frame = this.#frame.asReadonly();
  readonly frameState = this.#frameState.asReadonly();
  readonly frameError = this.#frameError.asReadonly();

  /** Ensures a frame for the current (move, block). */
  async ensureFrame(): Promise<void> {
    const moveNumber = this.#moveNumber();
    const block = this.#block();
    if (this.#api === null) {
      this.#frameState.set('idle');
      return;
    }

    const key = `${moveNumber}:${block}`;
    const cached = this.#frameCache.get(key);
    if (cached !== undefined) {
      this.#frame.set(cached);
      this.#frameState.set('ready');
      this.#frameError.set(undefined);
      this.setChannel(this.#channel());
      return;
    }

    const token = ++this.#frameRequest;
    this.#frameState.set('loading');
    try {
      const result = await this.#api.getActivationFrame({ moveNumber, block });
      if (token !== this.#frameRequest) return;
      remember(this.#frameCache, key, result, FRAME_CACHE_LIMIT);
      this.#frame.set(result);
      this.#frameState.set('ready');
      this.#frameError.set(undefined);
      this.setChannel(this.#channel());
    } catch (error) {
      if (token !== this.#frameRequest) return;
      this.#frameError.set(error instanceof Error ? error.message : String(error));
      this.#frameState.set('error');
    }
  }

  cancelFrame(): void {
    this.#frameRequest++;
    if (this.#frameState() === 'loading') this.#frameState.set('idle');
  }

  // ---- weight-based importance and gradient attribution -------------------

  readonly #readerWeights = signal<ReaderWeights | undefined>(undefined);
  readonly #readerHead = signal<ReaderHead>('policy');
  readonly readerWeights = this.#readerWeights.asReadonly();
  /** Which head's reader norms apply to the last block. */
  readonly readerHead = this.#readerHead.asReadonly();

  setReaderHead(head: ReaderHead): void {
    this.#readerHead.set(head);
  }

  /**
   * Fetches the network's reader norms once.
   *
   * Static per network, so this is cached for the life of the source and reset
   * only when a capture is opened or closed. A source that cannot supply them
   * -- a capture has no weights to measure -- leaves them undefined, and the
   * impact ordering falls back to raw loudness.
   */
  async ensureReaderWeights(): Promise<void> {
    if (this.#api === null || this.#readerWeights() !== undefined) return;
    try {
      this.#readerWeights.set(await this.#api.getReaderWeights());
    } catch {
      this.#readerWeights.set(undefined);
    }
  }

  /** Reader norms for the selected block, honouring the head selector. */
  readonly blockReaderNorms = computed<Float32Array | undefined>(() => {
    const weights = this.#readerWeights();
    const spec = this.#spec();
    if (weights === undefined || spec === undefined) return undefined;
    return readerNormsFor(weights, this.#block(), spec.blocks, this.#readerHead());
  });

  /** True when the selected block is the one the heads read. */
  readonly isLastBlock = computed(() => {
    const spec = this.#spec();
    return spec !== undefined && this.#block() === spec.blocks - 1;
  });

  readonly #attributionTarget = signal<AttributionTarget | undefined>(undefined);
  readonly #attribution = signal<Attribution | undefined>(undefined);
  readonly #attributionState = signal<FetchState>('idle');
  readonly #attributionError = signal<string | undefined>(undefined);
  readonly #attributionCache = new Map<string, Attribution>();
  #attributionRequest = 0;

  /**
   * What attribution is measured against.
   *
   * App-wide, because it is set on the Board tab -- clicking a point picks it --
   * and read on the Diagnostics tab. `undefined` means the ordering is
   * unavailable rather than defaulted: attribution costs a forward and a
   * backward pass, and guessing a target would spend that on a question nobody
   * asked.
   */
  readonly attributionTarget = this.#attributionTarget.asReadonly();
  readonly attribution = this.#attribution.asReadonly();
  readonly attributionState = this.#attributionState.asReadonly();
  readonly attributionError = this.#attributionError.asReadonly();

  setAttributionTarget(target: AttributionTarget | undefined): void {
    this.#attributionTarget.set(target);
    this.#attributionRequest++;
    this.#attribution.set(undefined);
    this.#attributionState.set('idle');
  }

  /**
   * Ensures attribution for the current move and target.
   *
   * Cached per `(move, target)` -- including the plane block, since a request
   * with planes returns strictly more than one without. Cancellable like the
   * board overlays: a reply for a move or target the user has left is dropped.
   */
  async ensureAttribution(planeBlock?: number): Promise<void> {
    const target = this.#attributionTarget();
    const moveNumber = this.#moveNumber();
    if (this.#api === null || target === undefined) {
      this.#attributionState.set('idle');
      return;
    }

    const key = `${moveNumber}:${JSON.stringify(target)}:${planeBlock ?? '-'}`;
    const cached = this.#attributionCache.get(key);
    if (cached !== undefined) {
      this.#attribution.set(cached);
      this.#attributionState.set('ready');
      this.#attributionError.set(undefined);
      return;
    }

    const token = ++this.#attributionRequest;
    this.#attributionState.set('loading');
    try {
      const result = await this.#api.attribute({
        moveNumber,
        target,
        ...(planeBlock === undefined ? {} : { planeBlock }),
      });
      if (token !== this.#attributionRequest) return;
      remember(this.#attributionCache, key, result, ATTRIBUTION_CACHE_LIMIT);
      this.#attribution.set(result);
      this.#attributionState.set('ready');
      this.#attributionError.set(undefined);
    } catch (error) {
      if (token !== this.#attributionRequest) return;
      this.#attributionError.set(error instanceof Error ? error.message : String(error));
      this.#attributionState.set('error');
    }
  }

  cancelAttribution(): void {
    this.#attributionRequest++;
    if (this.#attributionState() === 'loading') this.#attributionState.set('idle');
  }

  // ---- per-channel statistics --------------------------------------------

  readonly #statsCache = new Map<number, readonly ChannelStats[]>();
  readonly #stats = signal<readonly ChannelStats[]>([]);
  readonly #statsState = signal<FetchState>('idle');
  readonly #statsSampled = signal(0);
  readonly #statsError = signal<string | undefined>(undefined);
  #statsRequest = 0;

  readonly stats = this.#stats.asReadonly();
  readonly statsState = this.#statsState.asReadonly();
  /** How many moves the current statistics were computed from. */
  readonly statsSampled = this.#statsSampled.asReadonly();
  readonly statsError = this.#statsError.asReadonly();

  /**
   * Ensures per-channel statistics for the selected block.
   *
   * The grid normalises each channel across the **whole game**, not per move --
   * per-move scaling would make a channel that goes quiet look identical to one
   * that never moved, and comparing moves is the point of the tab. Getting that
   * range means reading every move's frame for the block once.
   *
   * `sampleLimit` bounds how many moves are read. A capture serves frames from
   * disk and can afford all of them; the live sidecar runs a forward pass per
   * frame and cannot. The count actually used is reported, because
   * "normalised over 16 of 240 moves" is a materially different claim from
   * "normalised over the game".
   */
  async ensureStats(
    compute: (frames: readonly Float32Array[], channels: number, area: number) => Promise<readonly ChannelStats[]>,
    sampleLimit: number,
  ): Promise<void> {
    const block = this.#block();
    const spec = this.#spec();
    if (this.#api === null || spec === undefined) {
      this.#statsState.set('idle');
      return;
    }

    const cached = this.#statsCache.get(block);
    if (cached !== undefined) {
      this.#stats.set(cached);
      this.#statsState.set('ready');
      return;
    }

    const moves = this.#sampleMoves(sampleLimit);
    const token = ++this.#statsRequest;
    this.#statsState.set('loading');
    try {
      const frames: Float32Array[] = [];
      for (const moveNumber of moves) {
        const frame = await this.#api.getActivationFrame({ moveNumber, block });
        if (token !== this.#statsRequest) return;
        frames.push(frame.data instanceof Float32Array ? frame.data : Float32Array.from(frame.data));
      }
      const area = spec.boardSize.width * spec.boardSize.height;
      const stats = await compute(frames, spec.channels, area);
      if (token !== this.#statsRequest) return;
      this.#statsCache.set(block, stats);
      this.#stats.set(stats);
      this.#statsSampled.set(moves.length);
      this.#statsState.set('ready');
    } catch (error) {
      if (token !== this.#statsRequest) return;
      // Without stats the grid scales each plane to itself: legible, just not
      // comparable between channels or between moves. Better than an empty
      // panel, but the view says so rather than pretending.
      this.#stats.set([]);
      this.#statsError.set(error instanceof Error ? error.message : String(error));
      this.#statsState.set('error');
    }
  }

  cancelStats(): void {
    this.#statsRequest++;
    if (this.#statsState() === 'loading') this.#statsState.set('idle');
  }

  /** Evenly spaced move numbers to sample statistics from, endpoints included. */
  #sampleMoves(limit: number): readonly number[] {
    const available = this.activationMoves() ?? range(0, this.lastMoveNumber());
    if (available.length === 0) return [];
    if (limit <= 0 || available.length <= limit) return available;

    const picked: number[] = [];
    for (let i = 0; i < limit; i++) {
      const index = Math.round((i * (available.length - 1)) / (limit - 1));
      const move = available[index];
      if (move !== undefined && picked.at(-1) !== move) picked.push(move);
    }
    return picked;
  }

  /** Cache sizes, for tests and for Diagnostics. */
  cacheSizes(): {
    readonly analysis: number;
    readonly frames: number;
    readonly stats: number;
    readonly attribution: number;
  } {
    return {
      analysis: this.#analysisCache.size,
      frames: this.#frameCache.size,
      stats: this.#statsCache.size,
      attribution: this.#attributionCache.size,
    };
  }

  /**
   * The frame to compare the current one against, for the change overlay.
   *
   * **The same side to move, not the previous move.** KataGo's input planes are
   * relative to whoever is on move -- feature 1 is "my stones", feature 2 is
   * "theirs" -- so consecutive positions have every stone swapped between those
   * planes. That relabelling propagates through the trunk and swamps the change
   * the new stone actually caused.
   *
   * Measured on kata1-b18c384nbt at move 5: the delta against the previous
   * position was 4.5x the delta against two positions back at block 0, 2.7x at
   * block 8 and 1.6x at block 17 -- despite two-back being two stones further
   * away, and with 376 of 384 channels moving more against the previous
   * position. Almost all of that was the perspective flip, not the move.
   *
   * So this walks back to the nearest earlier frame with the same player to
   * move. In an ordinary game that is exactly two moves back. It is keyed on
   * the player rather than on parity because a handicap game starts with White
   * and an SGF need not alternate, and on the frames the source actually holds
   * because a capture may be sparse.
   */
  async comparisonFrame(): Promise<ActivationFrame | undefined> {
    const target = this.comparisonMove();
    if (target === undefined) return undefined;

    const block = this.#block();
    const key = `${target}:${block}`;
    const cached = this.#frameCache.get(key);
    if (cached !== undefined) return cached;
    if (this.#api === null) return undefined;
    try {
      const frame = await this.#api.getActivationFrame({ moveNumber: target, block });
      remember(this.#frameCache, key, frame, FRAME_CACHE_LIMIT);
      return frame;
    } catch {
      // The overlay is an extra; without a comparison frame it simply does not
      // draw, which is better than failing the whole repaint.
      return undefined;
    }
  }

  /**
   * Which move the change overlay compares against.
   *
   * `undefined` when there is none: the opening positions have no same-side
   * predecessor, and a sparse capture may not hold one.
   */
  comparisonMove(): number | undefined {
    const current = this.#moveNumber();
    const available = this.activationMoves();
    const loaded = this.#game();

    const sameSide = (candidate: number): boolean =>
      loaded === undefined
        ? (current - candidate) % 2 === 0
        : playerToMoveAt(loaded.game, candidate) === playerToMoveAt(loaded.game, current);

    if (available === undefined) {
      for (let move = current - 1; move >= 0; move--) {
        if (sameSide(move)) return move;
      }
      return undefined;
    }

    const index = available.indexOf(current);
    for (let i = index - 1; i >= 0; i--) {
      const move = available[i];
      if (move !== undefined && sameSide(move)) return move;
    }
    return undefined;
  }
}

/**
 * Inserts into a bounded cache, evicting the oldest entry when full.
 *
 * `Map` preserves insertion order, so the first key is the oldest. Re-inserting
 * an existing key does not refresh its position -- this is a size bound, not an
 * LRU, and an LRU here would buy nothing: the access pattern is a user stepping
 * through moves, which is sequential, not recency-clustered.
 */
/** Inclusive integer range. */
function range(from: number, to: number): number[] {
  const out: number[] = [];
  for (let i = from; i <= to; i++) out.push(i);
  return out;
}

function remember<K, V>(cache: Map<K, V>, key: K, value: V, limit: number): void {
  if (limit <= 0) return;
  cache.set(key, value);
  while (cache.size > limit) {
    const oldest = cache.keys().next();
    if (oldest.done === true) break;
    cache.delete(oldest.value);
  }
}
