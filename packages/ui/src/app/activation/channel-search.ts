/**
 * Running a region search across a capture.
 *
 * Orchestration only: the scoring is `@katascope/core`'s and runs in the render
 * worker, and what is left here is deciding which frames to feed it, in what
 * order, and when to stop.
 *
 * Three properties matter and each costs something:
 *
 * * **Streaming.** A search over a whole capture is thousands of frames; a
 *   result table that appears only at the end is indistinguishable from a hung
 *   one. Partial results are published as they accumulate, throttled so that
 *   publishing does not itself become the bottleneck.
 * * **Cancellable.** Every frame is an `await`, and each resumption checks
 *   whether the search it belongs to is still the current one. A search the
 *   user has moved on from stops at the next frame rather than running to
 *   completion in the background.
 * * **Bounded.** Moves times blocks grows fast -- a 240-move b18c384 capture is
 *   4,320 frames -- so there is a frame budget, and the UI is told when it was
 *   hit rather than quietly reporting a partial search as a complete one.
 *
 * Frames are fetched straight from the bridge rather than through
 * `SessionStore`'s cache on purpose. That cache holds 24 entries for the grid
 * to draw from; pouring a few thousand search frames through it would evict
 * exactly the frames the user is looking at, to cache frames that will not be
 * read twice.
 */

import { Injectable, computed, inject, signal } from '@angular/core';
import {
  prepareRegion,
  rankHits,
  summariseHits,
  type ChannelSummary,
  type RegionDirection,
  type RegionHit,
  type RegionQuery,
  type Vertex,
} from '@katascope/core';
import { KATASCOPE_API } from '../platform/katascope-api';
import { SessionStore } from '../state/session-store';
import { ActivationRenderer } from './activation-renderer';

/** Which positions a search covers. */
export type SearchScope = 'move' | 'all';

export type SearchState = 'idle' | 'running' | 'done' | 'error';

export interface SearchPlan {
  readonly region: readonly Vertex[];
  readonly direction: RegionDirection;
  readonly threshold: number;
  readonly specific: boolean;
  readonly specificThreshold: number;
  readonly scope: SearchScope;
  /** Blocks to search, ascending. Never empty -- the caller defaults it. */
  readonly blocks: readonly number[];
}

/**
 * Most frames one search will read.
 *
 * Chosen so that the worst case stays in the seconds rather than the minutes:
 * at b18c384 a frame is 384 planes of 361 cells, and scoring one is about
 * 280,000 operations. The cap is reported when it bites.
 */
export const MAX_SEARCH_FRAMES = 2_000;

/**
 * Most hits kept.
 *
 * A loose threshold over a whole capture can qualify most channels on most
 * moves, which is hundreds of thousands of rows that nobody will read and that
 * would cost more to sort than to find. The kept set is the best-scoring ones.
 */
export const MAX_SEARCH_HITS = 2_000;

/** Minimum gap between result publications, in milliseconds. */
const PUBLISH_INTERVAL_MS = 80;

@Injectable({ providedIn: 'root' })
export class ChannelSearch {
  readonly #api = inject(KATASCOPE_API);
  readonly #renderer = inject(ActivationRenderer);
  readonly #store = inject(SessionStore);

  readonly #state = signal<SearchState>('idle');
  readonly #hits = signal<readonly RegionHit[]>([]);
  readonly #summaries = signal<readonly ChannelSummary[]>([]);
  readonly #scanned = signal(0);
  readonly #total = signal(0);
  readonly #truncated = signal(false);
  readonly #error = signal<string | undefined>(undefined);
  readonly #plan = signal<SearchPlan | undefined>(undefined);
  #request = 0;

  readonly state = this.#state.asReadonly();
  readonly hits = this.#hits.asReadonly();
  readonly summaries = this.#summaries.asReadonly();
  /** Frames scored so far, and how many the search will read in total. */
  readonly scanned = this.#scanned.asReadonly();
  readonly total = this.#total.asReadonly();
  /** True when the frame budget cut the search short. */
  readonly truncated = this.#truncated.asReadonly();
  readonly error = this.#error.asReadonly();
  /** The plan the current results came from, so the UI can label them. */
  readonly plan = this.#plan.asReadonly();

  readonly running = computed(() => this.#state() === 'running');

  /**
   * Which moves a scope covers.
   *
   * A capture knows exactly which moves it holds and they need not be
   * contiguous. Without one there is only the current move: the sidecar runs a
   * forward pass per frame, so "all moves" against a live model would be a
   * request to evaluate the whole game, which is not a thing to do behind a
   * button.
   */
  movesFor(scope: SearchScope): readonly number[] {
    if (scope === 'move') return [this.#store.moveNumber()];
    return this.#store.activationMoves() ?? [this.#store.moveNumber()];
  }

  /** True when scope `all` is meaningful, i.e. a capture is open. */
  readonly canSearchAllMoves = computed(() => this.#store.hasCapture());

  /**
   * Runs a search, replacing any previous results.
   *
   * Resolves when the search finishes, is cancelled, or fails; callers do not
   * need to await it, since everything it produces arrives through signals.
   */
  async run(plan: SearchPlan): Promise<void> {
    const token = ++this.#request;
    const boardSize = this.#store.networkSpec()?.boardSize;

    this.#plan.set(plan);
    this.#hits.set([]);
    this.#summaries.set([]);
    this.#scanned.set(0);
    this.#truncated.set(false);
    this.#error.set(undefined);

    if (this.#api === null || boardSize === undefined) {
      this.#total.set(0);
      this.#state.set('idle');
      return;
    }

    const region = prepareRegion(boardSize, plan.region);
    if (region.cells.length === 0) {
      this.#total.set(0);
      this.#error.set('Select at least one intersection on the Board tab.');
      this.#state.set('error');
      return;
    }

    const query: RegionQuery = {
      direction: plan.direction,
      threshold: plan.threshold,
      specific: plan.specific,
      specificThreshold: plan.specificThreshold,
    };

    const moves = this.movesFor(plan.scope);
    const blocks = plan.blocks;
    const targets: { moveNumber: number; block: number }[] = [];
    for (const moveNumber of moves) {
      for (const block of blocks) targets.push({ moveNumber, block });
    }

    const truncated = targets.length > MAX_SEARCH_FRAMES;
    const budgeted = truncated ? targets.slice(0, MAX_SEARCH_FRAMES) : targets;
    this.#truncated.set(truncated);
    this.#total.set(budgeted.length);
    this.#state.set('running');

    const collected: RegionHit[] = [];
    let lastPublished = 0;

    try {
      for (const [index, target] of budgeted.entries()) {
        const frame = await this.#api.getActivationFrame(target);
        // The user may have cancelled, or started another search, while this
        // frame was in flight.
        if (token !== this.#request) return;

        const data =
          frame.data instanceof Float32Array ? frame.data : Float32Array.from(frame.data);
        const hits = await this.#renderer.scoreFrame(
          { moveNumber: target.moveNumber, block: target.block, channels: frame.channels },
          data,
          region,
          query,
        );
        if (token !== this.#request) return;

        collected.push(...hits);
        this.#scanned.set(index + 1);

        const now = Date.now();
        if (now - lastPublished >= PUBLISH_INTERVAL_MS) {
          lastPublished = now;
          this.#publish(collected);
        }
      }

      this.#publish(collected);
      this.#state.set('done');
    } catch (error) {
      if (token !== this.#request) return;
      // Whatever was found before the failure is still worth showing; the view
      // reports the error alongside it rather than throwing the results away.
      this.#publish(collected);
      this.#error.set(error instanceof Error ? error.message : String(error));
      this.#state.set('error');
    }
  }

  /** Abandons an in-flight search. Results found so far are kept on screen. */
  cancel(): void {
    this.#request++;
    if (this.#state() === 'running') this.#state.set('done');
  }

  /** Throws away the results, so the panel goes back to its empty state. */
  reset(): void {
    this.#request++;
    this.#hits.set([]);
    this.#summaries.set([]);
    this.#scanned.set(0);
    this.#total.set(0);
    this.#truncated.set(false);
    this.#error.set(undefined);
    this.#plan.set(undefined);
    this.#state.set('idle');
  }

  /**
   * Publishes ranked results.
   *
   * The summary is built from **every** hit, not from the truncated table: a
   * channel's qualifying-move count is the whole point of the summary, and
   * counting only the top-scoring rows would undercount exactly the persistent
   * channels it exists to surface.
   */
  #publish(collected: readonly RegionHit[]): void {
    const ranked = rankHits(collected);
    this.#hits.set(ranked.length > MAX_SEARCH_HITS ? ranked.slice(0, MAX_SEARCH_HITS) : ranked);
    this.#summaries.set(summariseHits(collected));
  }
}
