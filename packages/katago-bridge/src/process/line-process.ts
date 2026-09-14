/**
 * A child process that speaks newline-delimited JSON on stdin/stdout.
 *
 * Both things katascope spawns -- the KataGo analysis engine and the Python
 * activation sidecar -- use that shape, so the framing, request correlation and
 * failure handling live here once.
 *
 * Failure policy: if the child dies, every in-flight request rejects with the
 * exit status and the tail of stderr. Callers never hang on a dead process.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface, type Interface } from 'node:readline';

export interface LineProcessOptions {
  readonly command: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  /** Lines of stderr to retain for error messages. Defaults to 40. */
  readonly stderrHistory?: number;
  /** Called for each stderr line, for the Diagnostics log. */
  readonly onStderr?: (line: string) => void;
}

export class ProcessExitError extends Error {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stderr: string;

  constructor(command: string, code: number | null, signal: NodeJS.Signals | null, stderr: string) {
    const how = signal !== null ? `signal ${signal}` : `exit code ${code ?? 'unknown'}`;
    super(`${command} exited with ${how}${stderr === '' ? '' : `\n${stderr}`}`);
    this.name = 'ProcessExitError';
    this.code = code;
    this.signal = signal;
    this.stderr = stderr;
  }
}

/** A parsed stdout line. Shape is whatever the peer protocol defines. */
export type JsonLine = Record<string, unknown>;

export class LineProcess {
  readonly #options: LineProcessOptions;
  #child: ChildProcessWithoutNullStreams | undefined;
  #reader: Interface | undefined;
  #stderrTail: string[] = [];
  #listeners = new Set<(line: JsonLine) => void>();
  #exit: ProcessExitError | undefined;
  #closing = false;

  constructor(options: LineProcessOptions) {
    this.#options = options;
  }

  get running(): boolean {
    return this.#child !== undefined && this.#exit === undefined;
  }

  /** Recent stderr, newest last. Useful in Diagnostics when a spawn fails. */
  get stderrTail(): string {
    return this.#stderrTail.join('\n');
  }

  /**
   * Spawns the child. Rejects if the binary cannot be executed -- an ENOENT
   * here is the common "katago is not on your PATH" case.
   */
  async start(): Promise<void> {
    if (this.#child !== undefined) return;
    const { command, args = [], cwd, env } = this.#options;

    const child = spawn(command, [...args], {
      ...(cwd === undefined ? {} : { cwd }),
      ...(env === undefined ? {} : { env }),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.#child = child;

    const spawned = new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', (error: NodeJS.ErrnoException) => {
        const hint =
          error.code === 'ENOENT' ? ` -- is "${command}" installed and on your PATH?` : '';
        reject(new Error(`failed to start ${command}${hint}`, { cause: error }));
      });
    });

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');

    const limit = this.#options.stderrHistory ?? 40;
    createInterface({ input: child.stderr }).on('line', (line) => {
      this.#stderrTail.push(line);
      if (this.#stderrTail.length > limit) this.#stderrTail.shift();
      this.#options.onStderr?.(line);
    });

    this.#reader = createInterface({ input: child.stdout });
    this.#reader.on('line', (line) => {
      if (line.trim() === '') return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        // Engines print banners and progress chatter on stdout; skip non-JSON.
        return;
      }
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return;
      for (const listener of this.#listeners) listener(parsed as JsonLine);
    });

    child.once('exit', (code, signal) => {
      this.#exit = new ProcessExitError(command, code, signal, this.stderrTail);
      if (!this.#closing) {
        // Wake anyone waiting: listeners decide how to fail their requests.
        for (const listener of [...this.#listeners]) listener({ __processExit: true });
      }
    });

    await spawned;
  }

  /** Subscribes to parsed stdout lines. Returns an unsubscribe function. */
  onLine(listener: (line: JsonLine) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** The error the process exited with, if it has exited. */
  get exitError(): ProcessExitError | undefined {
    return this.#exit;
  }

  /** Writes one JSON line to stdin. */
  send(message: unknown): void {
    const child = this.#child;
    if (child === undefined) throw new Error('process has not been started');
    if (this.#exit !== undefined) throw this.#exit;
    child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  /** Terminates the child. Idempotent; safe on a process that never started. */
  async stop(): Promise<void> {
    this.#closing = true;
    const child = this.#child;
    this.#reader?.close();
    this.#listeners.clear();
    if (child === undefined || child.exitCode !== null || child.signalCode !== null) return;

    await new Promise<void>((resolve) => {
      const forceKill = setTimeout(() => child.kill('SIGKILL'), 2_000);
      child.once('exit', () => {
        clearTimeout(forceKill);
        resolve();
      });
      child.stdin.end();
      child.kill('SIGTERM');
    });
  }
}

/** Marker line synthesised on child exit; see `LineProcess`'s exit handler. */
export function isProcessExitLine(line: JsonLine): boolean {
  return line['__processExit'] === true;
}
