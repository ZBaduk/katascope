/**
 * A child process speaking JSON lines with optional binary payloads.
 *
 * `LineProcess` handles the pure-JSON peers (KataGo). The activation service
 * also ships bulk float data, and putting half a megabyte of base64 through
 * `JSON.parse` per frame is wasteful, so its stdout is a two-mode stream:
 *
 *     <json line>\n[<binaryBytes> raw bytes]<json line>\n...
 *
 * Reading that needs a byte-level state machine rather than `readline`: the
 * payload may contain newlines, so line splitting alone would desynchronise
 * the stream permanently. This is that state machine.
 *
 * Everything else -- request correlation, timeouts, rejecting in flight work
 * when the child dies -- matches `LineProcess`, because those behaviours are
 * not worth having two versions of.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';

export interface FramedProcessOptions {
  readonly command: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly stderrHistory?: number;
  readonly onStderr?: (line: string) => void;
}

/** One decoded message: the JSON header, plus its payload when it had one. */
export interface FramedMessage {
  readonly header: Record<string, unknown>;
  /** Exactly `header.binaryBytes` bytes, or `undefined` when there were none. */
  readonly payload?: Buffer;
}

export class FramedProcessExitError extends Error {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stderr: string;

  constructor(command: string, code: number | null, signal: NodeJS.Signals | null, stderr: string) {
    const how = signal !== null ? `signal ${signal}` : `exit code ${code ?? 'unknown'}`;
    super(`${command} exited with ${how}${stderr === '' ? '' : `\n${stderr}`}`);
    this.name = 'FramedProcessExitError';
    this.code = code;
    this.signal = signal;
    this.stderr = stderr;
  }
}

export class FramedProcess {
  readonly #options: FramedProcessOptions;
  #child: ChildProcessWithoutNullStreams | undefined;
  #stderrTail: string[] = [];
  #listeners = new Set<(message: FramedMessage) => void>();
  #exitListeners = new Set<(error: FramedProcessExitError) => void>();
  #exit: FramedProcessExitError | undefined;
  #closing = false;

  // Decoder state. `#pending` holds bytes not yet consumed; when `#awaiting` is
  // set we are mid-payload and must not look for newlines.
  #buffered: Buffer[] = [];
  #bufferedLength = 0;
  #awaiting: { readonly header: Record<string, unknown>; readonly bytes: number } | undefined;

  constructor(options: FramedProcessOptions) {
    this.#options = options;
  }

  get running(): boolean {
    return this.#child !== undefined && this.#exit === undefined;
  }

  get stderrTail(): string {
    return this.#stderrTail.join('\n');
  }

  get exitError(): FramedProcessExitError | undefined {
    return this.#exit;
  }

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
        const hint = error.code === 'ENOENT' ? ` -- is "${command}" installed and on your PATH?` : '';
        reject(new Error(`failed to start ${command}${hint}`, { cause: error }));
      });
    });

    // stdout stays binary; only stderr is text.
    child.stderr.setEncoding('utf8');
    const limit = this.#options.stderrHistory ?? 40;
    createInterface({ input: child.stderr }).on('line', (line) => {
      this.#stderrTail.push(line);
      if (this.#stderrTail.length > limit) this.#stderrTail.shift();
      this.#options.onStderr?.(line);
    });

    child.stdout.on('data', (chunk: Buffer) => this.#consume(chunk));

    child.once('exit', (code, signal) => {
      this.#exit = new FramedProcessExitError(command, code, signal, this.stderrTail);
      if (!this.#closing) {
        for (const listener of [...this.#exitListeners]) listener(this.#exit);
      }
    });

    await spawned;
  }

  onMessage(listener: (message: FramedMessage) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  onExit(listener: (error: FramedProcessExitError) => void): () => void {
    this.#exitListeners.add(listener);
    return () => this.#exitListeners.delete(listener);
  }

  send(message: unknown): void {
    const child = this.#child;
    if (child === undefined) throw new Error('process has not been started');
    if (this.#exit !== undefined) throw this.#exit;
    child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  async stop(): Promise<void> {
    this.#closing = true;
    const child = this.#child;
    this.#listeners.clear();
    this.#exitListeners.clear();
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

  /** Feeds bytes through the header/payload state machine. */
  #consume(chunk: Buffer): void {
    this.#buffered.push(chunk);
    this.#bufferedLength += chunk.length;

    // Each pass either completes one frame or runs out of bytes.
    for (;;) {
      if (this.#awaiting !== undefined) {
        if (this.#bufferedLength < this.#awaiting.bytes) return;
        const payload = this.#take(this.#awaiting.bytes);
        const { header } = this.#awaiting;
        this.#awaiting = undefined;
        this.#emit({ header, payload });
        continue;
      }

      const newline = this.#indexOfNewline();
      if (newline < 0) return;
      const line = this.#take(newline).toString('utf8');
      this.#take(1); // the newline itself
      if (line.trim() === '') continue;

      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        // Startup banners and warnings land on stdout in some Python setups.
        continue;
      }
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
      const header = parsed as Record<string, unknown>;

      const bytes = header['binaryBytes'];
      if (typeof bytes === 'number' && Number.isInteger(bytes) && bytes > 0) {
        this.#awaiting = { header, bytes };
        continue;
      }
      this.#emit({ header });
    }
  }

  #emit(message: FramedMessage): void {
    for (const listener of [...this.#listeners]) listener(message);
  }

  /** Index of the next newline across the buffered chunks, or -1. */
  #indexOfNewline(): number {
    let scanned = 0;
    for (const chunk of this.#buffered) {
      const at = chunk.indexOf(0x0a);
      if (at >= 0) return scanned + at;
      scanned += chunk.length;
    }
    return -1;
  }

  /** Removes and returns the first `count` buffered bytes. */
  #take(count: number): Buffer {
    if (count === 0) return Buffer.alloc(0);
    // Coalesce only what is needed; a large payload arrives as many chunks and
    // concatenating the whole backlog each time would be quadratic.
    const parts: Buffer[] = [];
    let remaining = count;
    while (remaining > 0) {
      const head = this.#buffered[0];
      if (head === undefined) break;
      if (head.length <= remaining) {
        parts.push(head);
        remaining -= head.length;
        this.#buffered.shift();
      } else {
        parts.push(head.subarray(0, remaining));
        this.#buffered[0] = head.subarray(remaining);
        remaining = 0;
      }
    }
    this.#bufferedLength -= count - remaining;
    return parts.length === 1 ? (parts[0] as Buffer) : Buffer.concat(parts);
  }
}
