/**
 * Playing against the reduced network, in real time.
 *
 * The reduce panel answers "what would the head have said here"; this answers
 * the more interesting version of the same question -- "what would it *do*" --
 * by feeding its own move back in and going again. A channel set that looks
 * plausible on one position tends to reveal itself over twenty.
 *
 * The loop, per move:
 *
 *   1. Ask the bridge for the last block's frame at the current position.
 *   2. Re-run the policy head with the current selection applied.
 *   3. Take the best **legal** move -- the head has no idea what is legal, and
 *      an illegal move would be appended to the record and sent to the sidecar
 *      as a position that cannot exist.
 *   4. Append it, which tells the bridge, and repeat.
 *
 * Speed is bounded by step 1, not by anything here. A forward pass on the real
 * net is tens to hundreds of milliseconds; the fake store answers instantly.
 * The delay control exists to slow a fast source down to something watchable,
 * never to speed a slow one up.
 *
 * Greedy, not sampled: see `chooseMove`. Two runs of the same selection give
 * the same game, so a difference between two selections is the selection.
 */

import { computed, inject, Injectable, signal } from '@angular/core';
import {
  chooseMove,
  ownEyes,
  policySoftmax,
  positionAt,
  playerToMoveAt,
  type Move,
  type Player,
} from '@katascope/core';
import { KATASCOPE_API } from '../platform/katascope-api';
import { SessionStore } from '../state/session-store';
import { ActivationRenderer } from './activation-renderer';
import { ReduceStore } from './reduce-store';

/** Which colours the network plays. */
export type NetSide = 'off' | 'black' | 'white' | 'both';

/**
 * `finished` is a real end -- two passes. `capped` is the move limit, which is
 * a safety net rather than a result; reporting it as "game over" would claim
 * the network decided the game was over when it did no such thing.
 */
export type PlayState = 'idle' | 'thinking' | 'waiting' | 'error' | 'finished' | 'capped';

/**
 * Most moves one run will play.
 *
 * A self-play game that never passes would otherwise fill the board and keep
 * going; this is the backstop, and hitting it is reported rather than silent.
 */
export const MAX_PLAY_MOVES = 400;

@Injectable({ providedIn: 'root' })
export class PlaySession {
  readonly #api = inject(KATASCOPE_API);
  readonly #renderer = inject(ActivationRenderer);
  readonly #store = inject(SessionStore);
  readonly #reduce = inject(ReduceStore);

  readonly #side = signal<NetSide>('off');
  readonly #running = signal(false);
  readonly #state = signal<PlayState>('idle');
  readonly #error = signal<string | undefined>(undefined);
  readonly #delayMs = signal(250);
  readonly #lastMove = signal<Move | undefined>(undefined);
  readonly #played = signal(0);
  readonly #avoidEyes = signal(true);
  #token = 0;

  readonly side = this.#side.asReadonly();
  readonly running = this.#running.asReadonly();
  readonly state = this.#state.asReadonly();
  readonly error = this.#error.asReadonly();
  readonly delayMs = this.#delayMs.asReadonly();
  readonly lastMove = this.#lastMove.asReadonly();
  /** How many moves this run has generated. */
  readonly played = this.#played.asReadonly();
  readonly avoidEyes = this.#avoidEyes.asReadonly();
  /** The move limit, for the status line to name. */
  readonly maxMoves = MAX_PLAY_MOVES;

  /** Whose turn it is, or `undefined` with no game open. */
  readonly toPlay = computed<Player | undefined>(() => {
    const loaded = this.#store.game();
    if (loaded === undefined) return undefined;
    return playerToMoveAt(loaded.game, this.#store.moveNumber());
  });

  /** True when the network owns the current turn. */
  readonly netToPlay = computed(() => {
    const side = this.#side();
    const player = this.toPlay();
    if (side === 'off' || player === undefined) return false;
    return side === 'both' || side === player;
  });

  readonly canPlay = computed(
    () => this.#api !== null && this.#store.hasGame() && this.#reduce.available(),
  );

  setSide(side: NetSide): void {
    this.#side.set(side);
    if (side === 'off') this.stop();
  }

  setDelay(ms: number): void {
    this.#delayMs.set(Math.max(0, Math.min(5_000, Math.round(ms))));
  }

  setAvoidEyes(avoid: boolean): void {
    this.#avoidEyes.set(avoid);
  }

  /**
   * Starts the loop.
   *
   * Returns once the loop stops, which callers do not need to await: everything
   * it produces arrives through the store and these signals.
   */
  async start(): Promise<void> {
    if (this.#running()) return;
    if (!this.canPlay()) {
      this.#error.set('Load a game and open Reduce before playing.');
      this.#state.set('error');
      return;
    }
    const token = ++this.#token;
    this.#running.set(true);
    this.#played.set(0);
    this.#error.set(undefined);

    try {
      while (token === this.#token && this.#played() < MAX_PLAY_MOVES) {
        if (!this.netToPlay()) {
          // The human owns this turn. Stop the loop rather than spinning: a
          // board click restarts it.
          this.#state.set('waiting');
          break;
        }
        const chosen = await this.#nextMove(token);
        if (token !== this.#token) return;
        if (chosen === undefined) return;
        if (!this.#stillCurrent(chosen.at)) {
          // Someone played while this was thinking. Go round again from the
          // position that is actually on the board.
          continue;
        }

        await this.#store.playMove(chosen.move);
        if (token !== this.#token) return;
        this.#lastMove.set(chosen.move);
        this.#played.update((count) => count + 1);

        if (this.#endsGame(chosen.move)) {
          this.#state.set('finished');
          break;
        }
        if (this.#delayMs() > 0) await delay(this.#delayMs());
        if (token !== this.#token) return;
      }
      if (token === this.#token && this.#played() >= MAX_PLAY_MOVES) {
        this.#state.set('capped');
      }
    } catch (error) {
      if (token !== this.#token) return;
      this.#error.set(error instanceof Error ? error.message : String(error));
      this.#state.set('error');
    } finally {
      if (token === this.#token) this.#running.set(false);
    }
  }

  stop(): void {
    this.#token++;
    this.#running.set(false);
    if (this.#state() === 'thinking') this.#state.set('idle');
  }

  /**
   * Plays one move for the network, without starting the loop.
   *
   * What the "step" button calls, and what a human move triggers so the network
   * replies once rather than running away with the game.
   */
  async step(): Promise<void> {
    if (this.#running() || !this.canPlay() || !this.netToPlay()) return;
    const token = ++this.#token;
    try {
      const chosen = await this.#nextMove(token);
      if (token !== this.#token || chosen === undefined) return;
      if (!this.#stillCurrent(chosen.at)) return;
      await this.#store.playMove(chosen.move);
      if (token !== this.#token) return;
      this.#lastMove.set(chosen.move);
      this.#played.update((count) => count + 1);
      this.#state.set(this.#endsGame(chosen.move) ? 'finished' : 'waiting');
    } catch (error) {
      if (token !== this.#token) return;
      this.#error.set(error instanceof Error ? error.message : String(error));
      this.#state.set('error');
    }
  }

  /** Clears the run's counters, leaving the game alone. */
  reset(): void {
    this.stop();
    this.#played.set(0);
    this.#lastMove.set(undefined);
    this.#error.set(undefined);
    this.#state.set('idle');
  }

  /**
   * The move the reduced head wants here, and the position it is a reply to.
   *
   * The move number comes back with the move because the token alone does not
   * catch everything: a human playing a stone while the loop is thinking
   * changes the position without touching the token, and the move the loop is
   * about to apply was chosen for a board that no longer exists.
   *
   * `undefined` when the run has been superseded.
   */
  async #nextMove(token: number): Promise<{ move: Move; at: number } | undefined> {
    const loaded = this.#store.game();
    const weights = this.#reduce.weights();
    const spec = this.#store.networkSpec();
    if (this.#api === null || loaded === undefined || weights === undefined || spec === undefined) {
      return undefined;
    }

    this.#state.set('thinking');
    const moveNumber = this.#store.moveNumber();
    const player = playerToMoveAt(loaded.game, moveNumber);

    // Always the last block: it is the one the heads read, whatever the rail
    // happens to have selected.
    const frame = await this.#api.getActivationFrame({
      moveNumber,
      block: spec.blocks - 1,
    });
    if (token !== this.#token) return undefined;

    const data = frame.data instanceof Float32Array ? frame.data : Float32Array.from(frame.data);
    const result = await this.#renderer.reduce(
      data,
      weights,
      this.#reduce.geometryFor(frame.boardSize),
      this.#reduce.selected(),
      this.#reduce.mode(),
      'policy',
    );
    if (token !== this.#token) return undefined;

    const probabilities = policySoftmax(result.reduced.values, result.reduced.pass ?? 0);
    const board = positionAt(loaded.game, moveNumber);
    const ko = this.#store.koPoint();

    const move = chooseMove(
      this.#cropToBoard(probabilities, frame.boardSize, loaded.game.size),
      board,
      player,
      ko === undefined ? {} : { ko },
      // Without this a raw policy fills its own eyes once the position is
      // settled, and a demonstration game ends in a massacre rather than
      // anything a reader would recognise as Go.
      this.#avoidEyes() ? { forbidden: ownEyes(board, player) } : {},
    );
    return { move, at: moveNumber };
  }

  /**
   * True when the board is still the one a move was chosen for.
   *
   * Applying a reply to a position that has since changed would put a move on
   * the board that answers nothing -- and, worse, one the rules were checked
   * against on a different board, so it need not even be legal on this one.
   */
  #stillCurrent(at: number): boolean {
    return this.#store.moveNumber() === at;
  }

  /**
   * Reshapes a network-extent policy to the game board, pass last.
   *
   * The head runs over the network's extent and `chooseMove` indexes by the
   * game's. They are the same for a 19x19 game on the reference net, which is
   * exactly why getting it wrong would go unnoticed until someone opened a 9x9.
   */
  #cropToBoard(
    probabilities: Float32Array,
    planes: { readonly width: number; readonly height: number },
    board: { readonly width: number; readonly height: number },
  ): number[] {
    const out: number[] = [];
    for (let y = 0; y < board.height; y++) {
      for (let x = 0; x < board.width; x++) out.push(probabilities[y * planes.width + x] ?? 0);
    }
    out.push(probabilities[probabilities.length - 1] ?? 0);
    return out;
  }

  /** Two passes in a row end the game, as they do everywhere else. */
  #endsGame(move: Move): boolean {
    if (move.kind !== 'pass') return false;
    const loaded = this.#store.game();
    if (loaded === undefined) return false;
    const previous = loaded.game.moves.at(-2);
    return previous?.kind === 'pass';
  }
}

/**
 * `setTimeout` as a promise.
 *
 * The renderer is zoneless, so a timer does not itself trigger change
 * detection -- but everything this loop changes is a signal, and those do.
 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
