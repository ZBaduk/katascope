/**
 * The channel search: a query over a board region, and its results.
 *
 * The query is assembled here and executed by `ChannelSearch`; the region
 * itself comes from `SessionStore`, because it is selected on the Board tab.
 * Everything this component decides is presentational -- which sliders, what
 * they are labelled, how a result row reads -- and the scoring it reports on
 * lives in `@katascope/core`.
 *
 * Two results views, because they answer different questions. The **hits**
 * table is "where was this strongest", ranked by score. The **channels**
 * summary is "which channels do this consistently", ranked by how many moves
 * each qualified on. A channel that fires on the region all game is the
 * interesting one, and it loses the score ranking to whichever single position
 * happened to spike.
 */

import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import type { ChannelSummary, RegionDirection, RegionHit } from '@katascope/core';
import { SessionStore } from '../state/session-store';
import { ChannelSearch, MAX_SEARCH_HITS, type SearchScope } from './channel-search';

/** Where a result row points. */
export interface SearchJump {
  readonly moveNumber: number;
  readonly block: number;
  readonly channel: number;
}

@Component({
  selector: 'ks-search-panel',
  template: `
    <section class="search" data-testid="search-panel">
      <header class="search__head">
        <h2 class="search__title">Region search</h2>
        @if (region().length === 0) {
          <span class="search__hint" data-testid="search-region">
            no region — set “Click: select region” on the Board tab
          </span>
        } @else {
          <span class="search__hint" data-testid="search-region">
            {{ region().length }} intersection{{ region().length === 1 ? '' : 's' }} selected
          </span>
        }
      </header>

      <div class="search__query">
        <label class="field field--select">
          Direction
          <select
            [value]="direction()"
            (change)="direction.set($any($event.target).value)"
            aria-label="Search direction"
          >
            <option value="high" [selected]="direction() === 'high'">all high</option>
            <option value="low" [selected]="direction() === 'low'">all low</option>
            <option value="either" [selected]="direction() === 'either'">either</option>
          </select>
        </label>

        <label class="field" title="Minimum score, in standard deviations from the plane's mean">
          Threshold
          <input
            type="range"
            min="0.25"
            max="6"
            step="0.25"
            [value]="threshold()"
            (input)="threshold.set(+$any($event.target).value)"
            aria-label="Score threshold"
          />
          <span class="field__value" data-testid="search-threshold">{{ threshold().toFixed(2) }}σ</span>
        </label>

        <label class="field field--check" title="Also require the channel to be quiet outside the region">
          <input
            type="checkbox"
            [checked]="specific()"
            (change)="specific.set(!specific())"
            aria-label="Specific to the region"
          />
          Specific
        </label>

        @if (specific()) {
          <label class="field" title="Ceiling on mean |z| outside the region">
            Quiet below
            <input
              type="range"
              min="0.1"
              max="2"
              step="0.05"
              [value]="specificThreshold()"
              (input)="specificThreshold.set(+$any($event.target).value)"
              aria-label="Outside-region ceiling"
            />
            <span class="field__value">{{ specificThreshold().toFixed(2) }}σ</span>
          </label>
        }

        <label class="field field--select" title="Which positions to search">
          Scope
          <select
            [value]="scope()"
            (change)="scope.set($any($event.target).value)"
            aria-label="Search scope"
          >
            <option value="move" [selected]="scope() === 'move'">current move</option>
            <option value="all" [selected]="scope() === 'all'" [disabled]="!search.canSearchAllMoves()">
              all moves of the capture
            </option>
          </select>
        </label>
      </div>

      @if (!search.canSearchAllMoves()) {
        <p class="search__note" data-testid="search-scope-note">
          Activations are coming from the live model, which runs a forward pass per frame, so the
          search covers the current move only. Open a <code>.kact</code> capture to search a
          whole game.
        </p>
      }

      <div class="search__blocks">
        <span class="search__blocks-label">Blocks</span>
        @for (block of allBlocks(); track block) {
          <button
            type="button"
            class="chip"
            [class.chip--on]="selectedBlocks().has(block)"
            [attr.data-block]="block"
            [attr.aria-pressed]="selectedBlocks().has(block)"
            (click)="toggleBlock(block)"
          >
            {{ block }}
          </button>
        }
        <button type="button" class="chip chip--action" (click)="selectAllBlocks()">all</button>
        <button type="button" class="chip chip--action" (click)="selectThisBlock()">this</button>
      </div>

      <div class="search__actions">
        @if (search.running()) {
          <button type="button" class="search__run" (click)="search.cancel()">Cancel</button>
        } @else {
          <button
            type="button"
            class="search__run"
            [disabled]="!canRun()"
            (click)="run()"
            data-testid="search-run"
          >
            Search
          </button>
        }
        <span class="search__status" data-testid="search-status">
          @switch (search.state()) {
            @case ('running') {
              scanning {{ search.scanned() }} / {{ search.total() }} frames…
            }
            @case ('done') {
              {{ search.hits().length }} hit{{ search.hits().length === 1 ? '' : 's' }} ·
              {{ search.summaries().length }} channel{{ search.summaries().length === 1 ? '' : 's' }} ·
              {{ search.scanned() }} frame{{ search.scanned() === 1 ? '' : 's' }}
              @if (search.truncated()) {
                · stopped at the frame budget
              }
              @if (search.hits().length >= maxHits) {
                · showing the best {{ maxHits }}
              }
            }
            @case ('error') {
              <span class="search__status--bad">{{ search.error() }}</span>
            }
            @default {
              idle
            }
          }
        </span>
      </div>

      @if (search.hits().length > 0 || search.summaries().length > 0) {
        <nav class="search__views" role="tablist" aria-label="Result view">
          <button
            type="button"
            role="tab"
            class="search__view"
            [class.search__view--on]="view() === 'hits'"
            [attr.aria-selected]="view() === 'hits'"
            (click)="view.set('hits')"
          >
            By score
          </button>
          <button
            type="button"
            role="tab"
            class="search__view"
            [class.search__view--on]="view() === 'channels'"
            [attr.aria-selected]="view() === 'channels'"
            (click)="view.set('channels')"
          >
            By channel
          </button>
        </nav>

        <div class="search__results">
          @if (view() === 'hits') {
            <table class="results" data-testid="search-hits">
              <thead>
                <tr>
                  <th scope="col">move</th>
                  <th scope="col">block</th>
                  <th scope="col">channel</th>
                  <th scope="col">dir</th>
                  <th scope="col">score</th>
                </tr>
              </thead>
              <tbody>
                @for (hit of search.hits(); track $index) {
                  <tr
                    class="results__row"
                    [class.results__row--current]="isCurrent(hit)"
                    tabindex="0"
                    (click)="jumpTo(hit)"
                    (keydown.enter)="jumpTo(hit)"
                  >
                    <td>{{ hit.moveNumber }}</td>
                    <td>{{ hit.block }}</td>
                    <td>{{ hit.channel }}</td>
                    <td>{{ hit.direction }}</td>
                    <td class="results__score">{{ hit.score.toFixed(2) }}</td>
                  </tr>
                }
              </tbody>
            </table>
          } @else {
            <table class="results" data-testid="search-channels">
              <thead>
                <tr>
                  <th scope="col">block</th>
                  <th scope="col">channel</th>
                  <th scope="col">moves</th>
                  <th scope="col">dir</th>
                  <th scope="col">best</th>
                </tr>
              </thead>
              <tbody>
                @for (summary of search.summaries(); track $index) {
                  <tr
                    class="results__row"
                    [class.results__row--current]="isCurrentChannel(summary)"
                    tabindex="0"
                    (click)="jumpToSummary(summary)"
                    (keydown.enter)="jumpToSummary(summary)"
                  >
                    <td>{{ summary.block }}</td>
                    <td>{{ summary.channel }}</td>
                    <td>{{ summary.moves }}</td>
                    <td>{{ summary.direction }}</td>
                    <td class="results__score">{{ summary.bestScore.toFixed(2) }}</td>
                  </tr>
                }
              </tbody>
            </table>
          }
        </div>
      } @else if (search.state() === 'done') {
        <p class="search__note" data-testid="search-empty">
          Nothing qualified. Lower the threshold, widen the direction, or turn off “specific”.
        </p>
      }
    </section>
  `,
  styles: `
    :host {
      display: block;
      height: 100%;
      min-height: 0;
      overflow: hidden;
    }

    .search {
      display: flex;
      flex-direction: column;
      gap: 8px;
      height: 100%;
      min-height: 0;
      padding: 10px;
      border-left: 1px solid var(--ks-border);
      background: var(--ks-surface);
      font-size: 12px;
    }

    .search__head {
      display: flex;
      align-items: baseline;
      gap: 8px;
      flex-wrap: wrap;
    }

    .search__title {
      margin: 0;
      font-size: 13px;
      font-weight: 600;
    }

    .search__hint,
    .search__note {
      margin: 0;
      color: var(--ks-text-dim);
    }

    .search__query,
    .search__blocks,
    .search__actions {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
    }

    .field,
    .field--check {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      color: var(--ks-text-dim);
    }

    .field input[type='range'] {
      width: 96px;
    }

    .field__value {
      min-width: 44px;
      font-variant-numeric: tabular-nums;
      color: var(--ks-text);
    }

    select {
      font: inherit;
      color: var(--ks-text);
      background: var(--ks-surface-raised);
      border: 1px solid var(--ks-border);
      border-radius: var(--ks-radius);
      padding: 2px 4px;
    }

    .search__blocks-label {
      color: var(--ks-text-dim);
    }

    .chip {
      min-width: 24px;
      padding: 2px 6px;
      font: inherit;
      font-variant-numeric: tabular-nums;
      color: var(--ks-text-dim);
      background: var(--ks-surface-raised);
      border: 1px solid var(--ks-border);
      border-radius: var(--ks-radius);
      cursor: pointer;
    }

    .chip--on {
      color: var(--ks-bg);
      background: var(--ks-accent);
      border-color: var(--ks-accent);
    }

    .chip--action {
      font-style: italic;
    }

    .search__run {
      padding: 4px 12px;
      font: inherit;
      color: var(--ks-text);
      background: var(--ks-surface-raised);
      border: 1px solid var(--ks-border);
      border-radius: var(--ks-radius);
      cursor: pointer;
    }

    .search__run:hover:not(:disabled) {
      border-color: var(--ks-accent);
    }

    .search__run:disabled {
      opacity: 0.5;
      cursor: default;
    }

    .search__status {
      color: var(--ks-text-dim);
    }

    .search__status--bad {
      color: var(--ks-bad, #ff6b6b);
    }

    .search__views {
      display: flex;
      gap: 4px;
    }

    .search__view {
      padding: 2px 8px;
      font: inherit;
      color: var(--ks-text-dim);
      background: none;
      border: 1px solid transparent;
      border-radius: var(--ks-radius);
      cursor: pointer;
    }

    .search__view--on {
      color: var(--ks-text);
      border-color: var(--ks-border);
      background: var(--ks-surface-raised);
    }

    .search__results {
      flex: 1 1 auto;
      min-height: 0;
      overflow: auto;
    }

    .results {
      width: 100%;
      border-collapse: collapse;
      font-variant-numeric: tabular-nums;
    }

    .results th {
      position: sticky;
      top: 0;
      z-index: 1;
      padding: 2px 6px;
      text-align: right;
      font-weight: 600;
      color: var(--ks-text-dim);
      background: var(--ks-surface);
    }

    .results td {
      padding: 1px 6px;
      text-align: right;
    }

    .results__row {
      cursor: pointer;
    }

    .results__row:hover,
    .results__row:focus-visible {
      background: var(--ks-surface-raised);
      outline: none;
    }

    .results__row--current {
      color: var(--ks-accent);
    }

    .results__score {
      color: var(--ks-text);
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SearchPanel {
  protected readonly store = inject(SessionStore);
  protected readonly search = inject(ChannelSearch);

  /** How many blocks the loaded network has. */
  readonly blocks = input.required<number>();

  readonly resultPicked = output<SearchJump>();

  protected readonly maxHits = MAX_SEARCH_HITS;

  protected readonly direction = signal<RegionDirection>('high');
  protected readonly threshold = signal(2);
  protected readonly specific = signal(false);
  protected readonly specificThreshold = signal(0.5);
  protected readonly scope = signal<SearchScope>('move');
  protected readonly view = signal<'hits' | 'channels'>('hits');

  protected readonly region = this.store.searchRegion;

  /**
   * Blocks to search.
   *
   * `undefined` means "follow the selected block", which is the default: a
   * search across every block of a b18c384 capture is eighteen times the work
   * and is rarely what someone wants first. Picking any chip pins the set.
   */
  readonly #blockFilter = signal<ReadonlySet<number> | undefined>(undefined);

  protected readonly allBlocks = computed(() =>
    Array.from({ length: this.blocks() }, (_, index) => index),
  );

  protected readonly selectedBlocks = computed<ReadonlySet<number>>(
    () => this.#blockFilter() ?? new Set([this.store.block()]),
  );

  protected readonly canRun = computed(
    () => this.region().length > 0 && this.selectedBlocks().size > 0 && this.blocks() > 0,
  );

  protected toggleBlock(block: number): void {
    const current = new Set(this.selectedBlocks());
    if (current.has(block)) current.delete(block);
    else current.add(block);
    this.#blockFilter.set(current);
  }

  protected selectAllBlocks(): void {
    this.#blockFilter.set(new Set(this.allBlocks()));
  }

  /** Goes back to following the selected block. */
  protected selectThisBlock(): void {
    this.#blockFilter.set(undefined);
  }

  protected run(): void {
    void this.search.run({
      region: this.region(),
      direction: this.direction(),
      threshold: this.threshold(),
      specific: this.specific(),
      specificThreshold: this.specificThreshold(),
      // A live model cannot afford a whole game, so the scope is forced back
      // whatever the select says -- it is disabled, but a stale signal from
      // before a capture was closed would otherwise slip through.
      scope: this.search.canSearchAllMoves() ? this.scope() : 'move',
      blocks: [...this.selectedBlocks()].sort((a, b) => a - b),
    });
  }

  protected jumpTo(hit: RegionHit): void {
    this.resultPicked.emit({
      moveNumber: hit.moveNumber,
      block: hit.block,
      channel: hit.channel,
    });
  }

  protected jumpToSummary(summary: ChannelSummary): void {
    this.resultPicked.emit({
      moveNumber: summary.bestMoveNumber,
      block: summary.block,
      channel: summary.channel,
    });
  }

  protected isCurrent(hit: RegionHit): boolean {
    return (
      hit.moveNumber === this.store.moveNumber() &&
      hit.block === this.store.block() &&
      hit.channel === this.store.channel()
    );
  }

  protected isCurrentChannel(summary: ChannelSummary): boolean {
    return summary.block === this.store.block() && summary.channel === this.store.channel();
  }
}
