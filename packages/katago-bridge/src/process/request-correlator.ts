/**
 * Matches JSON-line responses back to the requests that caused them.
 *
 * Both peer protocols tag every message with an `id` the peer echoes, so one
 * correlator serves both. Pending requests reject on timeout and on child exit,
 * which is what keeps a crashed engine from stalling the UI forever.
 */

import { isProcessExitLine, type JsonLine, type LineProcess } from './line-process.js';

export interface CorrelatorOptions {
  /** Milliseconds before a request gives up. Defaults to 30_000. */
  readonly timeoutMs?: number;
  /** Property carrying the correlation id in both directions. Defaults to `id`. */
  readonly idField?: string;
}

interface Pending {
  readonly resolve: (line: JsonLine) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
}

export class RequestCorrelator {
  readonly #process: LineProcess;
  readonly #timeoutMs: number;
  readonly #idField: string;
  readonly #pending = new Map<string, Pending>();
  #nextId = 1;
  #unsubscribe: (() => void) | undefined;

  constructor(process: LineProcess, options: CorrelatorOptions = {}) {
    this.#process = process;
    this.#timeoutMs = options.timeoutMs ?? 30_000;
    this.#idField = options.idField ?? 'id';
  }

  /** Begins routing the process's stdout lines. Call after `LineProcess.start()`. */
  attach(): void {
    this.#unsubscribe ??= this.#process.onLine((line) => this.#handle(line));
  }

  /**
   * Sends `payload` with a fresh id and resolves with the matching response.
   * `payload` must not already contain the id field.
   */
  request(payload: Record<string, unknown>): Promise<JsonLine> {
    const id = `ks-${this.#nextId++}`;
    return new Promise<JsonLine>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`request ${id} timed out after ${this.#timeoutMs}ms`));
      }, this.#timeoutMs);
      timer.unref?.();
      this.#pending.set(id, { resolve, reject, timer });
      try {
        this.#process.send({ ...payload, [this.#idField]: id });
      } catch (error) {
        this.#settle(id, (pending) => pending.reject(toError(error)));
      }
    });
  }

  /** Fails every in-flight request. Called on shutdown and on child exit. */
  rejectAll(error: Error): void {
    for (const id of [...this.#pending.keys()]) {
      this.#settle(id, (pending) => pending.reject(error));
    }
  }

  #handle(line: JsonLine): void {
    if (isProcessExitLine(line)) {
      this.rejectAll(this.#process.exitError ?? new Error('child process exited'));
      return;
    }
    const id = line[this.#idField];
    if (typeof id !== 'string') return;
    this.#settle(id, (pending) => pending.resolve(line));
  }

  #settle(id: string, finish: (pending: Pending) => void): void {
    const pending = this.#pending.get(id);
    if (pending === undefined) return;
    this.#pending.delete(id);
    clearTimeout(pending.timer);
    finish(pending);
  }
}

export function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
