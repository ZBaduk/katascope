/**
 * The activation view: block rail, channel grid, and a detail pane.
 *
 * Orchestration only. Every number it draws comes from a pure function in
 * `grid-layout`, `normalization` or `channel-stats`, and the pixels come from
 * the render worker. What is left here is deciding *when* to ask.
 */

import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import {
  attributionForBlock,
  describeTarget,
  squareBoardSize,
  targetVertex,
  type ActivationFrame,
  type AttributionTarget,
  type ReaderHead,
} from '@katascope/core';
import { KATASCOPE_API } from '../platform/katascope-api';
import { SessionStore } from '../state/session-store';
import { ActivationRenderer } from './activation-renderer';
import { BlockRail } from './block-rail';
import { ChannelGrid, type GridHover } from './channel-grid';
import { maxVariance, planeStats, unusedChannels } from './channel-stats';
import { headLeans, orderByScore, ranksFromOrder, type HeadLean } from './ordering';
import { PlaneDetail } from './plane-detail';
import { ReducePanel } from './reduce-panel';
import { ReduceStore } from './reduce-store';
import { SearchPanel, type SearchJump } from './search-panel';

/**
 * How many moves to read when computing per-channel statistics.
 *
 * A capture serves frames from disk and can afford a generous sample; the live
 * sidecar runs a forward pass per frame and cannot. Whichever applies, the
 * count actually used is shown, because "normalised over 12 of 240 moves" is a
 * materially weaker claim than "normalised over the game".
 */
const STATS_SAMPLE_CAPTURE = 64;
const STATS_SAMPLE_LIVE = 12;

/** The orderings the grid offers. */
export type Ordering = 'channel' | 'change' | 'impact' | 'attribution';

const TARGET_CHOICES = [
  { value: 'ownership_total', label: 'total ownership' },
  { value: 'winrate', label: 'winrate' },
] as const;

@Component({
  selector: 'ks-activation-view',
  imports: [BlockRail, ChannelGrid, PlaneDetail, ReducePanel, SearchPanel],
  templateUrl: './activation-view.html',
  styleUrl: './activation-view.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ActivationView {
  readonly #api = inject(KATASCOPE_API);
  readonly #renderer = inject(ActivationRenderer);
  protected readonly store = inject(SessionStore);
  protected readonly reduce = inject(ReduceStore);

  private readonly gridRef = viewChild<ChannelGrid>(ChannelGrid);

  protected readonly connected = this.#api !== null;

  protected readonly changeFraction = signal(0.5);
  protected readonly showChange = signal(false);
  protected readonly hideUnusedFraction = signal(0);

  /** How the tiles are ordered. One at a time: they answer different questions. */
  protected readonly ordering = signal<Ordering>('channel');
  /** Show attribution planes on the tiles instead of raw activations. */
  protected readonly showAttributionPlanes = signal(false);
  /** Whether the region-search panel is open beside the grid. */
  protected readonly showSearch = signal(false);
  /** Whether the reduce panel is open below the grid. */
  protected readonly showReduce = signal(false);

  protected readonly hover = signal<GridHover | undefined>(undefined);
  protected readonly picked = signal<number | undefined>(undefined);
  protected readonly rendering = signal(false);

  readonly #pixels = signal<Uint8ClampedArray | undefined>(undefined);
  readonly #changes = signal<Float64Array>(new Float64Array(0));
  readonly #impact = signal<Float64Array>(new Float64Array(0));
  #renderToken = 0;

  protected readonly pixels = this.#pixels.asReadonly();
  protected readonly usingMainThread = this.#renderer.usingMainThread;

  protected readonly spec = this.store.networkSpec;
  protected readonly boardSize = computed(() => this.spec()?.boardSize ?? squareBoardSize(19));
  protected readonly channels = computed(() => this.spec()?.channels ?? 0);
  protected readonly blocks = computed(() => this.spec()?.blocks ?? 0);
  protected readonly area = computed(() => this.boardSize().width * this.boardSize().height);

  /** Variance threshold in raw units, from the slider's 0..1 fraction. */
  protected readonly varianceThreshold = computed(
    () => this.hideUnusedFraction() * maxVariance(this.store.stats()),
  );

  protected readonly hiddenChannels = computed(() =>
    unusedChannels(this.store.stats(), this.varianceThreshold()),
  );

  protected readonly hiddenCount = computed(() => this.hiddenChannels().size);

  /** The scores the current ordering sorts on, or undefined for channel order. */
  protected readonly orderingScores = computed<ArrayLike<number> | undefined>(() => {
    switch (this.ordering()) {
      case 'change':
        return this.#changes();
      case 'impact':
        return this.#impact();
      case 'attribution': {
        const attribution = this.store.attribution();
        if (attribution === undefined) return undefined;
        try {
          return attributionForBlock(attribution, this.store.block());
        } catch {
          // The attribution was computed for a different network shape.
          return undefined;
        }
      }
      default:
        return undefined;
    }
  });

  protected readonly order = computed<readonly number[] | undefined>(() => {
    const scores = this.orderingScores();
    return scores === undefined ? undefined : orderByScore(scores);
  });

  /** Rank of each channel in the current ordering, for the detail pane. */
  protected readonly ranks = computed(() => {
    const order = this.order();
    return order === undefined ? undefined : ranksFromOrder(order);
  });

  /** Which head reads each channel hardest. Only meaningful for the last block. */
  protected readonly leans = computed<readonly HeadLean[] | undefined>(() => {
    const weights = this.store.readerWeights();
    if (weights === undefined || !this.store.isLastBlock()) return undefined;
    // Computed once per network: the vectors do not depend on the position.
    return headLeans(weights.heads.policy, weights.heads.value);
  });

  protected readonly attributionAvailable = computed(
    () => this.connected && !this.store.hasCapture(),
  );

  protected readonly targetLabel = computed(() => {
    const target = this.store.attributionTarget();
    return target === undefined ? undefined : describeTarget(target);
  });

  /**
   * The label for a target picked on the board, which has no fixed option.
   *
   * `undefined` for the whole-output targets, which the select already lists.
   */
  protected readonly pointTargetLabel = computed(() => {
    const target = this.store.attributionTarget();
    if (target === undefined) return undefined;
    return targetVertex(target) === undefined ? undefined : describeTarget(target);
  });

  protected readonly hoverStats = computed(() => {
    const channel = this.detailChannel();
    const at = channel === undefined ? undefined : { channel };
    const frame = this.store.frame();
    if (at === undefined || frame === undefined) return undefined;
    const area = this.area();
    const base = at.channel * area;
    const plane = frame.data.subarray(base, base + area);
    const previous = this.#comparison()?.data.subarray(base, base + area);
    return planeStats(plane, previous);
  });

  /**
   * Which channel the drawer shows: a pinned one, or whatever is under the
   * pointer. A pin wins, so clicking a channel and then moving the mouse does
   * not replace what was just pinned.
   */
  protected readonly detailChannel = computed(() => this.picked() ?? this.hover()?.channel);

  /** The channel's impact and where it ranks in this block. */
  protected readonly detailImpact = computed(() => {
    const channel = this.detailChannel();
    const impact = this.#impact();
    if (channel === undefined || channel >= impact.length) return undefined;
    // Ranked against impact specifically, whatever the grid is sorted by --
    // otherwise "#3" would silently mean a different thing per ordering.
    const rank = ranksFromOrder(orderByScore(impact))[channel] ?? 0;
    return { value: impact[channel] ?? 0, rank };
  });

  protected readonly detailReaderNorm = computed(() => {
    const channel = this.detailChannel();
    const norms = this.store.blockReaderNorms();
    if (channel === undefined || norms === undefined) return undefined;
    return norms[channel];
  });

  protected readonly detailAttribution = computed(() => {
    const channel = this.detailChannel();
    const attribution = this.store.attribution();
    if (channel === undefined || attribution === undefined) return undefined;
    let scores: Float32Array;
    try {
      scores = attributionForBlock(attribution, this.store.block());
    } catch {
      return undefined;
    }
    if (channel >= scores.length) return undefined;
    const rank = ranksFromOrder(orderByScore(scores))[channel] ?? 0;
    return { value: scores[channel] ?? 0, rank };
  });

  /**
   * The hover coordinates, but only while they belong to the channel on show.
   *
   * With a channel pinned, hovering a different tile would otherwise print that
   * tile's intersection under the pinned channel's plane -- a coordinate that
   * refers to a plane the reader is not looking at.
   */
  protected readonly detailHover = computed(() => {
    const at = this.hover();
    return at !== undefined && at.channel === this.detailChannel() ? at : undefined;
  });

  protected readonly detailPixels = computed(() => {
    const channel = this.detailChannel();
    const pixels = this.#pixels();
    if (channel === undefined || pixels === undefined) return undefined;
    const area = this.area();
    const offset = channel * area * 4;
    if (offset + area * 4 > pixels.length) return undefined;
    return pixels.slice(offset, offset + area * 4);
  });

  readonly #comparison = signal<ActivationFrame | undefined>(undefined);

  /** Which move the change overlay is measured against, for the status line. */
  protected readonly comparisonMove = computed(() => {
    this.store.moveNumber();
    this.store.capture();
    return this.store.comparisonMove();
  });

  constructor() {
    // Learn the network shape once the bridge can describe it.
    void this.#describe();

    // Static per network, so once is enough.
    void this.store.ensureReaderWeights();

    // Attribution follows the move, the target and the block-planes request.
    effect(() => {
      this.store.moveNumber();
      this.store.attributionTarget();
      const wantsPlanes = this.showAttributionPlanes();
      const block = this.store.block();
      untracked(() => {
        if (this.store.attributionTarget() === undefined) this.store.cancelAttribution();
        else void this.store.ensureAttribution(wantsPlanes ? block : undefined);
      });
    });

    // Frames follow the move and the block.
    effect(() => {
      this.store.moveNumber();
      this.store.block();
      untracked(() => void this.store.ensureFrame());
    });

    // Statistics follow the block and the network, and are cached per block.
    // The spec has to be a dependency: it arrives asynchronously from
    // describeActivations(), and without it this effect ran once before there
    // was anything to compute against and never again.
    effect(() => {
      this.store.block();
      this.store.capture();
      this.store.networkSpec();
      untracked(() => {
        void this.store.ensureStats(
          (frames, channels, area) => this.#renderer.computeStats(frames, channels, area),
          this.store.hasCapture() ? STATS_SAMPLE_CAPTURE : STATS_SAMPLE_LIVE,
        );
      });
    });

    // Head weights are static per network, so once is enough -- but only for
    // the last block, since a reduction is only defined there.
    effect(() => {
      const wanted = this.showReduce() && this.store.isLastBlock();
      untracked(() => {
        if (wanted) void this.reduce.ensureWeights();
      });
    });

    // The reduction follows the frame, the selection, the mode and the head.
    // Keyed off the frame rather than the move number because it needs the
    // frame's data, and a move whose frame has not arrived has nothing to run.
    effect(() => {
      const frame = this.store.frame();
      const open = this.showReduce();
      const lastBlock = this.store.isLastBlock();
      this.reduce.selected();
      this.reduce.mode();
      this.reduce.head();
      this.reduce.weights();
      untracked(() => {
        if (!open || !lastBlock || frame === undefined) {
          this.reduce.cancel();
          return;
        }
        const data =
          frame.data instanceof Float32Array ? frame.data : Float32Array.from(frame.data);
        void this.reduce.run(data, this.reduce.geometryFor(frame.boardSize));
      });
    });

    // Pixels follow the frame, the statistics and the overlay controls.
    effect(() => {
      const frame = this.store.frame();
      const stats = this.store.stats();
      const showChange = this.showChange();
      const fraction = this.changeFraction();
      const hidden = this.hiddenChannels();
      // Reader norms feed the impact score, which the worker computes, so a
      // change of head has to trigger a repaint rather than only a re-sort.
      this.store.blockReaderNorms();
      this.leans();
      this.showAttributionPlanes();
      this.store.attribution();
      untracked(() => void this.#repaint(frame, stats, showChange, fraction, hidden));
    });
  }

  protected onHover(hover: GridHover | undefined): void {
    this.hover.set(hover);
  }

  protected onPick(channel: number): void {
    this.picked.update((current) => (current === channel ? undefined : channel));
    this.store.setChannel(channel);
  }

  protected selectBlock(block: number): void {
    this.store.setBlock(block);
    this.picked.set(undefined);
  }

  protected setOrdering(value: string): void {
    this.ordering.set(value as Ordering);
  }

  protected setReaderHead(value: string): void {
    this.store.setReaderHead(value as ReaderHead);
  }

  protected setTarget(value: string): void {
    if (value === '') {
      this.store.setAttributionTarget(undefined);
      return;
    }
    this.store.setAttributionTarget({ kind: value } as AttributionTarget);
  }

  protected readonly targetChoices = TARGET_CHOICES;

  protected async openCapture(): Promise<void> {
    if (this.#api === null) return;
    const loaded = await this.#api.openKact();
    if (loaded === null) return;
    // A capture has no weights, so anything computed from the previous
    // source's would be a claim about a network that is no longer loaded.
    this.reduce.reset();
    this.store.setCapture(loaded);
    if (loaded.game !== undefined) {
      this.store.setGame({ path: loaded.path, game: loaded.game });
      this.store.setCapture(loaded);
    }
  }

  protected async closeCapture(): Promise<void> {
    if (this.#api === null) return;
    await this.#api.closeKact();
    this.store.clearCapture();
    this.reduce.reset();
    await this.#describe();
  }

  async #describe(): Promise<void> {
    if (this.#api === null) return;
    try {
      const availability = await this.#api.describeActivations();
      this.store.setNetworkSpec(availability.spec);
    } catch {
      // Diagnostics reports subsystem failures; the grid simply stays empty.
    }
  }

  async #repaint(
    frame: ActivationFrame | undefined,
    stats: readonly { channel: number; min: number; max: number }[],
    showChange: boolean,
    fraction: number,
    hidden: ReadonlySet<number>,
  ): Promise<void> {
    if (frame === undefined) {
      this.#pixels.set(undefined);
      return;
    }
    const token = ++this.#renderToken;
    this.rendering.set(true);

    const needsComparison = showChange || this.ordering() === 'change';
    const previous = needsComparison ? await this.store.comparisonFrame() : undefined;
    if (token !== this.#renderToken) return;
    this.#comparison.set(previous);

    const data = frame.data instanceof Float32Array ? frame.data : Float32Array.from(frame.data);
    const previousData =
      previous === undefined
        ? undefined
        : previous.data instanceof Float32Array
          ? previous.data
          : Float32Array.from(previous.data);

    // Attribution planes replace the activations on the tiles when asked for:
    // same grid, different quantity, so the layout and hit-testing are unchanged.
    const attribution = this.store.attribution();
    const planes =
      this.showAttributionPlanes() &&
      attribution?.planes !== undefined &&
      attribution.planeBlock === this.store.block()
        ? attribution.planes
        : undefined;
    const drawn = planes ?? data;

    const readerNorms = this.store.blockReaderNorms();
    const leans = this.leans();
    const result = await this.#renderer.render(drawn, previousData, {
      channels: frame.channels,
      area: this.area(),
      // Attribution planes are signed and have no game-wide range, so they are
      // scaled symmetrically about zero instead.
      stats: planes === undefined ? stats.map((s) => ({ ...s, mean: 0, stdev: 0, variance: 0 })) : [],
      ...(planes === undefined ? {} : { diverging: true }),
      ...(showChange && planes === undefined ? { changeFraction: fraction } : {}),
      hidden: [...hidden],
      ...(readerNorms === undefined ? {} : { readerNorms }),
      ...(leans === undefined ? {} : { leans }),
    });
    // A repaint for a move the user has already left must not land.
    if (token !== this.#renderToken) return;

    this.#pixels.set(result.rgba);
    this.#changes.set(result.changes);
    this.#impact.set(result.impact);
    this.rendering.set(false);
  }

  protected revealSelected(): void {
    const channel = this.detailChannel();
    if (channel !== undefined) this.gridRef()?.revealChannel(channel);
  }

  protected toggleSearch(): void {
    this.showSearch.update((on) => !on);
  }

  protected toggleReduce(): void {
    this.showReduce.update((on) => !on);
  }

  protected onSelectionToggled(channel: number): void {
    this.reduce.toggle(channel);
  }

  /**
   * Follows a search result: its move, its block, and its channel.
   *
   * Pinning the channel rather than merely selecting it is deliberate. The
   * grid highlights `detailChannel`, which a stray pointer movement would
   * otherwise take over the instant the user reaches for the scrollbar --
   * losing the very result they just clicked.
   */
  protected onSearchResult(jump: SearchJump): void {
    this.store.setMoveNumber(jump.moveNumber);
    this.store.setBlock(jump.block);
    this.store.setChannel(jump.channel);
    this.picked.set(jump.channel);
    // The grid may be scrolled somewhere else entirely at 384 channels.
    this.gridRef()?.revealChannel(jump.channel);
  }
}
