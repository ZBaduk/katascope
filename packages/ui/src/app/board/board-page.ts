/**
 * The Board tab: a goban, a move navigator, and two analysis overlays.
 *
 * Holds the overlay toggles and the top-N setting. Everything else it reads
 * from `SessionStore`, so switching tabs does not lose the position and the
 * Diagnostics tab sees the same move.
 *
 * Overlays are fetched lazily and cancellably by the store. This component's
 * only job in that respect is to ask when something changes and to stop asking
 * when the overlays are off.
 */

import {
  ChangeDetectionStrategy,
  Component,
  HostListener,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import {
  describeNetwork,
  describeTarget,
  isLegalMove,
  pass,
  play,
  playerToMoveAt,
  squareBoardSize,
  targetVertex,
  type Vertex,
} from '@katascope/core';
import { KATASCOPE_API } from '../platform/katascope-api';
import { PlaySession, type NetSide } from '../activation/play-session';
import { ReduceStore } from '../activation/reduce-store';
import { SessionStore } from '../state/session-store';
import { BoardCanvas } from './board-canvas';
import { columnLabel, rowLabel } from './board-geometry';
import { MoveNavigator } from './move-navigator';
import { topPolicyMoves, type PolicyMove } from './overlays';

/** Candidate counts the top-N control offers. */
const TOP_N_CHOICES = [1, 3, 5, 10] as const;

/** What clicking an intersection does. */
export type ClickAction = 'off' | 'ownership' | 'policy' | 'region' | 'play';

@Component({
  selector: 'ks-board-page',
  imports: [BoardCanvas, MoveNavigator],
  templateUrl: './board-page.html',
  styleUrl: './board-page.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class BoardPage {
  readonly #api = inject(KATASCOPE_API);
  protected readonly store = inject(SessionStore);
  protected readonly playSession = inject(PlaySession);
  protected readonly reduce = inject(ReduceStore);

  protected readonly connected = this.#api !== null;
  protected readonly topNChoices = TOP_N_CHOICES;

  protected readonly showOwnership = signal(false);
  protected readonly showPolicy = signal(false);
  protected readonly showCoordinates = signal(true);
  protected readonly topN = signal(5);

  /**
   * What a click on the board does.
   *
   * `region` toggles intersections in the channel-search region; the others
   * pick an attribution target, or navigate when off.
   */
  protected readonly pickTarget = signal<ClickAction>('off');

  protected readonly targetLabel = computed(() => {
    const target = this.store.attributionTarget();
    return target === undefined ? undefined : describeTarget(target);
  });

  /** The point the current target names, for marking it on the board. */
  protected readonly targetVertex = computed(() => {
    const target = this.store.attributionTarget();
    return target === undefined ? undefined : targetVertex(target);
  });

  protected readonly opening = signal(false);
  protected readonly openError = signal<string | undefined>(undefined);

  /** `undefined` until the bridge answers; `true` when the engine is a fake. */
  protected readonly usingFakeEngine = signal<boolean | undefined>(undefined);
  protected readonly engineDetail = signal<string | undefined>(undefined);

  /** The board size of the loaded game, or a 19x19 default to draw an empty board. */
  protected readonly boardSize = computed(() => this.store.game()?.game.size ?? squareBoardSize(19));

  protected readonly wantsAnalysis = computed(() => this.showOwnership() || this.showPolicy());

  protected readonly ownership = computed<readonly number[] | undefined>(() =>
    this.showOwnership() ? this.store.analysis()?.ownership : undefined,
  );

  protected readonly policyMoves = computed<readonly PolicyMove[]>(() => {
    if (!this.showPolicy()) return [];
    const policy = this.store.analysis()?.policy;
    if (policy === undefined) return [];
    return topPolicyMoves(policy, this.boardSize(), this.topN());
  });

  protected readonly gameSummary = computed(() => {
    const loaded = this.store.game();
    if (loaded === undefined) return undefined;
    const { info, size } = loaded.game;
    const players = [info.blackName ?? 'Black', info.whiteName ?? 'White'].join(' vs ');
    return `${players} · ${size.width}×${size.height} · komi ${info.komi}${
      info.result === undefined ? '' : ` · ${info.result}`
    }`;
  });

  constructor() {
    // Ask the bridge what the analysis engine actually is, so the fake-data
    // banner reflects reality rather than the config's intent.
    void this.#refreshEngineMode();

    // The head weights live behind the Diagnostics tab's Reduce panel, but
    // playing needs them here. Asked for as soon as a side is chosen, so the
    // Play button is not disabled for a reason the user cannot see.
    effect(() => {
      const wanted = this.playSession.side() !== 'off';
      untracked(() => {
        if (wanted) void this.reduce.ensureWeights();
      });
    });

    effect(() => {
      // Depend on the move and on the toggles; re-read the rest untracked so
      // this fires when the user navigates, not when an answer arrives.
      this.store.moveNumber();
      const wanted = this.wantsAnalysis();
      untracked(() => {
        if (wanted) void this.store.ensureAnalysis();
        else this.store.cancelAnalysis();
      });
    });
  }

  /** Keyboard navigation. Ignored while the user is typing in a control. */
  @HostListener('window:keydown', ['$event'])
  protected onKeydown(event: KeyboardEvent): void {
    if (!this.store.hasGame() || event.metaKey || event.ctrlKey || event.altKey) return;
    const target = event.target as HTMLElement | null;
    // The slider handles its own arrow keys; intercepting them would double-step.
    if (target !== null && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return;

    switch (event.key) {
      case 'ArrowLeft':
        this.store.stepMove(-1);
        break;
      case 'ArrowRight':
        this.store.stepMove(1);
        break;
      case 'ArrowUp':
        this.store.stepMove(-10);
        break;
      case 'ArrowDown':
        this.store.stepMove(10);
        break;
      case 'Home':
        this.store.firstMove();
        break;
      case 'End':
        this.store.lastMove();
        break;
      default:
        return;
    }
    event.preventDefault();
  }

  protected async openSgf(): Promise<void> {
    if (this.#api === null) return;
    this.opening.set(true);
    this.openError.set(undefined);
    try {
      const loaded = await this.#api.openSgf();
      // A cancelled dialog is not an error and must not clear the open game.
      if (loaded !== null) this.store.setGame(loaded);
    } catch (error) {
      this.openError.set(error instanceof Error ? error.message : String(error));
    } finally {
      this.opening.set(false);
    }
  }

  protected toggleOwnership(): void {
    this.showOwnership.update((on) => !on);
  }

  protected togglePolicy(): void {
    this.showPolicy.update((on) => !on);
  }

  protected toggleCoordinates(): void {
    this.showCoordinates.update((on) => !on);
  }

  protected setTopN(value: number): void {
    this.topN.set(value);
  }

  /**
   * Clicking an intersection.
   *
   * In attribution mode it picks the point to attribute to -- which is why the
   * target lives in `SessionStore` rather than on the Diagnostics tab: it is
   * chosen here and read there. Otherwise it jumps to the move played there,
   * which is the more useful default when nobody is asking about gradients.
   */
  protected onVertexClicked(vertex: Vertex): void {
    const action = this.pickTarget();

    // Region selection works on an empty board too: choosing which part of the
    // board to ask about does not need a game, and a capture may carry frames
    // without one.
    if (action === 'region') {
      this.store.toggleRegionPoint(vertex);
      return;
    }

    const loaded = this.store.game();
    if (loaded === undefined) return;

    if (action === 'play') {
      void this.playHere(vertex);
      return;
    }

    if (action !== 'off') {
      const kind = action === 'ownership' ? 'ownership_point' : 'policy_move';
      this.store.setAttributionTarget({ kind, x: vertex.x, y: vertex.y });
      return;
    }

    const index = loaded.game.moves.findIndex(
      (move) => move.kind === 'play' && move.vertex.x === vertex.x && move.vertex.y === vertex.y,
    );
    if (index >= 0) this.store.setMoveNumber(index + 1);
  }

  /**
   * Plays a stone for the human, then lets the network reply once.
   *
   * One reply rather than restarting the loop: with the network on both
   * colours the loop runs itself, and with it on one colour a human move should
   * produce a move back, not a cascade.
   */
  protected async playHere(vertex: Vertex): Promise<void> {
    const loaded = this.store.game();
    if (loaded === undefined) return;
    const player = playerToMoveAt(loaded.game, this.store.moveNumber());
    const board = this.store.board();
    const ko = this.store.koPoint();
    if (board === undefined) return;

    // Checked here rather than left to `playMove`, which throws: a click on an
    // occupied point is an ordinary thing to do and should do nothing.
    if (!isLegalMove(board, player, vertex, ko === undefined ? {} : { ko })) {
      this.playError.set(`${columnLabel(vertex.x)}${rowLabel(loaded.game.size, vertex.y)} is not a legal move for ${player}`);
      return;
    }

    this.playError.set(undefined);
    try {
      await this.store.playMove(play(player, vertex));
      await this.playSession.step();
    } catch (error) {
      this.playError.set(error instanceof Error ? error.message : String(error));
    }
  }

  protected async passHere(): Promise<void> {
    const loaded = this.store.game();
    if (loaded === undefined) return;
    const player = playerToMoveAt(loaded.game, this.store.moveNumber());
    try {
      await this.store.playMove(pass(player));
      await this.playSession.step();
    } catch (error) {
      this.playError.set(error instanceof Error ? error.message : String(error));
    }
  }

  protected async newGame(): Promise<void> {
    this.playSession.reset();
    this.playError.set(undefined);
    try {
      await this.store.newGame(squareBoardSize(19));
      // Playing is the point of a new game, so the click action follows.
      this.pickTarget.set('play');
    } catch (error) {
      this.playError.set(error instanceof Error ? error.message : String(error));
    }
  }

  /**
   * Chooses which colours the network plays, and follows the click action.
   *
   * Turning the network on switches clicking from "go to move" to "play a
   * stone", because otherwise the first thing a player does -- click the board
   * -- navigates them back through the game instead of playing, which reads as
   * the board having stopped accepting moves. Switching the select rather than
   * quietly reinterpreting the click keeps what will happen visible.
   *
   * Only the default is moved. A deliberate choice -- picking an attribution
   * target, selecting a search region -- is left alone, and setting the click
   * action back to "go to move" by hand keeps working.
   */
  protected setNetSide(value: string): void {
    const side = value as NetSide;
    const previous = this.playSession.side();
    this.playSession.setSide(side);

    if (side !== 'off' && this.pickTarget() === 'off') this.pickTarget.set('play');
    else if (side === 'off' && previous !== 'off' && this.pickTarget() === 'play') {
      this.pickTarget.set('off');
    }
  }

  protected readonly playError = signal<string | undefined>(undefined);

  /** What the play bar says about the selection the network is playing with. */
  protected readonly reduceSummary = computed(() => {
    if (!this.reduce.available()) return 'open Reduce on the Diagnostics tab first';
    const count = this.reduce.selectedCount();
    const mode = this.reduce.mode() === 'only' ? 'only' : 'without';
    if (count === 0) {
      return this.reduce.mode() === 'only'
        ? 'no channels selected — the head sees nothing'
        : 'no channels removed — the full head';
    }
    return `${mode} ${count} channel${count === 1 ? '' : 's'}`;
  });

  protected setPickTarget(value: string): void {
    this.pickTarget.set(value as ClickAction);
  }

  protected clearTarget(): void {
    this.store.setAttributionTarget(undefined);
  }

  protected clearRegion(): void {
    this.store.clearSearchRegion();
  }

  /** The region as coordinates, for the notice that reports the selection. */
  protected readonly regionLabel = computed(() => {
    const region = this.store.searchRegion();
    if (region.length === 0) return undefined;
    const size = this.boardSize();
    return region.map((v) => `${columnLabel(v.x)}${rowLabel(size, v.y)}`).join(' ');
  });

  async #refreshEngineMode(): Promise<void> {
    if (this.#api === null) return;
    try {
      const status = await this.#api.getStatus();
      const engine = status.subsystems.find((s) => s.name === 'analysis-engine');
      this.usingFakeEngine.set(engine?.mode === 'fake');
      this.engineDetail.set(engine?.detail);
    } catch {
      // Diagnostics reports bridge failures; the board just stops claiming.
      this.usingFakeEngine.set(undefined);
    }
  }

  protected readonly describeNetwork = describeNetwork;
}
