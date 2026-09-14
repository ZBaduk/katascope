/**
 * The channel selection, and running a head with it applied.
 *
 * "Reduce" asks a counterfactual: what would the head have said if only these
 * channels reached it, or if these ones had not? Neither can be read off any
 * output -- the head has a non-linearity and a global pool between its input
 * and anything observable -- so the only way to answer is to re-run it. That is
 * what this owns: the selection, the weights, and the two runs.
 *
 * Diagnostics-local, unlike the attribution target and the search region: there
 * is no board to pick trunk channels on, so nothing on the Board tab needs it.
 *
 * Confined to the **last block**. It is the block the heads read, so it is the
 * only one where zeroing a channel has a defined effect on a head; for any
 * other block the question would need the rest of the trunk re-run too, which
 * this does not do and does not pretend to.
 */

import { computed, inject, Injectable, signal } from '@angular/core';
import {
  squareBoardSize,
  type HeadGeometry,
  type HeadKind,
  type HeadReduction,
  type HeadWeights,
  type ReduceMode,
} from '@katascope/core';
import { KATASCOPE_API } from '../platform/katascope-api';
import { SessionStore } from '../state/session-store';
import { ActivationRenderer } from './activation-renderer';
import type { HeadLean } from './ordering';

export type ReduceState = 'idle' | 'loading' | 'ready' | 'error';

/** How many reductions to keep. Each holds three board-sized fields. */
export const REDUCE_CACHE_LIMIT = 16;

@Injectable({ providedIn: 'root' })
export class ReduceStore {
  readonly #api = inject(KATASCOPE_API);
  readonly #renderer = inject(ActivationRenderer);
  readonly #store = inject(SessionStore);

  readonly #selected = signal<ReadonlySet<number>>(new Set<number>());
  readonly #head = signal<HeadKind>('policy');
  readonly #mode = signal<ReduceMode>('only');
  readonly #weights = signal<HeadWeights | undefined>(undefined);
  readonly #weightsError = signal<string | undefined>(undefined);

  readonly #result = signal<HeadReduction | undefined>(undefined);
  readonly #state = signal<ReduceState>('idle');
  readonly #error = signal<string | undefined>(undefined);
  readonly #cache = new Map<string, HeadReduction>();
  #request = 0;

  readonly selected = this.#selected.asReadonly();
  readonly head = this.#head.asReadonly();
  readonly mode = this.#mode.asReadonly();
  readonly weights = this.#weights.asReadonly();
  readonly weightsError = this.#weightsError.asReadonly();
  readonly result = this.#result.asReadonly();
  readonly state = this.#state.asReadonly();
  readonly error = this.#error.asReadonly();

  readonly selectedCount = computed(() => this.#selected().size);
  readonly hasSelection = computed(() => this.#selected().size > 0);

  /** True once the network's head weights are in hand. */
  readonly available = computed(() => this.#weights() !== undefined);

  setHead(head: HeadKind): void {
    this.#head.set(head);
  }

  setMode(mode: ReduceMode): void {
    this.#mode.set(mode);
  }

  // ---- the selection ------------------------------------------------------

  toggle(channel: number): void {
    this.#selected.update((current) => {
      const next = new Set(current);
      if (next.has(channel)) next.delete(channel);
      else next.add(channel);
      return next;
    });
  }

  selectAll(channels: number): void {
    this.#selected.set(new Set(Array.from({ length: Math.max(0, channels) }, (_, i) => i)));
  }

  clear(): void {
    this.#selected.set(new Set<number>());
  }

  invert(channels: number): void {
    this.#selected.update((current) => {
      const next = new Set<number>();
      for (let c = 0; c < channels; c++) if (!current.has(c)) next.add(c);
      return next;
    });
  }

  /**
   * Selects every channel the head-lean classifier put in one camp.
   *
   * The tint is already on screen for the last block, so this is "select what I
   * can see" -- the fastest way to ask the question the tint invites, which is
   * what the policy-leaning channels are actually doing for the policy.
   */
  selectByLean(leans: readonly HeadLean[], lean: HeadLean): void {
    const next = new Set<number>();
    for (const [channel, value] of leans.entries()) if (value === lean) next.add(channel);
    this.#selected.set(next);
  }

  // ---- weights ------------------------------------------------------------

  /**
   * Fetches the network's head weights once.
   *
   * Static per network and about 260 KiB, so it is cached for the life of the
   * source. A source that cannot supply them -- a capture has stored planes and
   * no weights -- leaves them undefined and the panel says why rather than
   * offering a control that cannot work.
   */
  async ensureWeights(): Promise<void> {
    if (this.#api === null || this.#weights() !== undefined) return;
    try {
      this.#weights.set(await this.#api.getHeadWeights());
      this.#weightsError.set(undefined);
    } catch (error) {
      this.#weights.set(undefined);
      this.#weightsError.set(error instanceof Error ? error.message : String(error));
    }
  }

  /** Drops the weights and every result, for when the source changes. */
  reset(): void {
    this.#weights.set(undefined);
    this.#weightsError.set(undefined);
    this.#cache.clear();
    this.#result.set(undefined);
    this.#state.set('idle');
    this.#error.set(undefined);
    this.#request++;
  }

  // ---- running ------------------------------------------------------------

  /**
   * Runs the reduction for the current move, selection, mode and head.
   *
   * Cached on all four plus the block, and cancellable: stepping a move while a
   * reduction is in flight must not paint the previous position's overlay over
   * the new one.
   */
  async run(trunk: Float32Array, geometry: HeadGeometry): Promise<void> {
    const weights = this.#weights();
    if (weights === undefined) {
      this.#state.set('idle');
      return;
    }

    const selected = this.#selected();
    const key = [
      this.#store.moveNumber(),
      this.#store.block(),
      this.#head(),
      this.#mode(),
      // Sorted, so the same set reached two different ways is one cache entry.
      [...selected].sort((a, b) => a - b).join(','),
    ].join(':');

    const cached = this.#cache.get(key);
    if (cached !== undefined) {
      this.#result.set(cached);
      this.#state.set('ready');
      this.#error.set(undefined);
      return;
    }

    const token = ++this.#request;
    this.#state.set('loading');
    try {
      const result = await this.#renderer.reduce(
        trunk,
        weights,
        geometry,
        selected,
        this.#mode(),
        this.#head(),
      );
      if (token !== this.#request) return;
      remember(this.#cache, key, result, REDUCE_CACHE_LIMIT);
      this.#result.set(result);
      this.#state.set('ready');
      this.#error.set(undefined);
    } catch (error) {
      if (token !== this.#request) return;
      this.#error.set(error instanceof Error ? error.message : String(error));
      this.#state.set('error');
    }
  }

  cancel(): void {
    this.#request++;
    if (this.#state() === 'loading') this.#state.set('idle');
  }

  /**
   * Where the game sits inside the network's extent.
   *
   * The frame is the network's, the board is the game's, and they differ for
   * any game smaller than the net -- at which point the head's pooled branch
   * divides by the wrong count unless it is told. Falls back to treating the
   * frame as the board, which is right whenever they match.
   */
  geometryFor(planes: { readonly width: number; readonly height: number }): HeadGeometry {
    const board = this.#store.game()?.game.size;
    return { planes, board: board ?? planes };
  }

  /** The network's extent, for a caller with no frame yet. */
  readonly planeSize = computed(
    () => this.#store.networkSpec()?.boardSize ?? squareBoardSize(19),
  );
}

/** Bounded insert; `Map` keeps insertion order so the first key is the oldest. */
function remember<K, V>(cache: Map<K, V>, key: K, value: V, limit: number): void {
  if (limit <= 0) return;
  cache.set(key, value);
  while (cache.size > limit) {
    const oldest = cache.keys().next();
    if (oldest.done === true) break;
    cache.delete(oldest.value);
  }
}
