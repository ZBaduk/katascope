/**
 * Drives the render worker, falling back to the main thread.
 *
 * The fallback is not a nicety: a packaged Electron build serves the renderer
 * from `file://`, and worker construction there is exactly the kind of thing
 * that works on one platform and not another. Both paths call the same
 * `render-core` functions, so the slow path cannot produce different pixels
 * from the fast one -- only later ones.
 */

import { Injectable, signal } from '@angular/core';
import {
  reduceHead,
  searchFrame,
  type HeadGeometry,
  type HeadKind,
  type HeadReduction,
  type HeadWeights,
  type PreparedRegion,
  type ReduceMode,
  type RegionHit,
  type RegionQuery,
} from '@katascope/core';
import type { ChannelStats } from './channel-stats';
import { accumulateStats, renderFrame, type RenderResult } from './render-core';
import type { RenderOptions, RenderRequest, RenderResponse } from './render-protocol';

@Injectable({ providedIn: 'root' })
export class ActivationRenderer {
  #worker: Worker | undefined;
  /** A signal, so the view can say so: a component reading a plain getter
   * would never learn that the worker went away. */
  readonly #workerFailed = signal(false);
  #nextId = 1;
  readonly #pending = new Map<number, (response: RenderResponse) => void>();

  /** True once the worker has been asked for and could not be had. */
  readonly usingMainThread = this.#workerFailed.asReadonly();

  /** Colours a frame. Resolves with an RGBA buffer and per-channel change totals. */
  async render(
    data: Float32Array,
    previous: Float32Array | undefined,
    options: RenderOptions,
  ): Promise<RenderResult> {
    const worker = this.#ensureWorker();
    if (worker === undefined) return renderFrame(data, previous, options);

    const id = this.#nextId++;
    const request: RenderRequest = {
      type: 'render',
      id,
      // Copies, because the caller keeps its frame in the cache; transferring
      // would detach the buffer the grid still needs for hover readouts.
      data: data.slice(),
      ...(previous === undefined ? {} : { previous: previous.slice() }),
      options,
    };
    const response = await this.#send(worker, request, id, [request.data.buffer]);
    return response.type === 'rendered'
      ? { rgba: response.rgba, changes: response.changes, impact: response.impact }
      : renderFrame(data, previous, options);
  }

  /**
   * Folds a set of frames into per-channel statistics.
   *
   * Streamed one frame at a time rather than posted as an array: the frames are
   * hundreds of kilobytes each and a whole game's worth at once would be worse
   * than doing it on the main thread.
   */
  async computeStats(
    frames: readonly Float32Array[],
    channels: number,
    area: number,
  ): Promise<readonly ChannelStats[]> {
    const worker = this.#ensureWorker();
    if (worker === undefined) return accumulateStats(frames, channels, area);

    worker.postMessage({ type: 'statsBegin', channels, area } satisfies RenderRequest);
    for (const frame of frames) {
      const copy = frame.slice();
      worker.postMessage({ type: 'statsAdd', data: copy } satisfies RenderRequest, [copy.buffer]);
    }
    const id = this.#nextId++;
    const response = await this.#send(worker, { type: 'statsEnd', id }, id);
    return response.type === 'stats' ? response.stats : accumulateStats(frames, channels, area);
  }

  /**
   * Scores one frame against a region, off the main thread.
   *
   * One frame per call, because that is the granularity the caller fetches at
   * and the granularity the results table fills in at.
   *
   * Copied rather than transferred, for the same reason as `render`: the frame
   * may be one the store has cached, and detaching a cached buffer would break
   * the next reader of it. It also leaves the buffer intact for the main-thread
   * fallback, which a transfer would make impossible -- a worker that dies
   * mid-search would otherwise silently return no hits, which reads as "nothing
   * matched" rather than as a failure.
   */
  async scoreFrame(
    frame: { readonly moveNumber: number; readonly block: number; readonly channels: number },
    data: Float32Array,
    region: PreparedRegion,
    query: RegionQuery,
  ): Promise<readonly RegionHit[]> {
    const worker = this.#ensureWorker();
    if (worker === undefined) return searchFrame({ ...frame, data }, region, query);

    const id = this.#nextId++;
    const copy = data.slice();
    const request: RenderRequest = { type: 'search', id, ...frame, data: copy, region, query };
    const response = await this.#send(worker, request, id, [copy.buffer]);
    return response.type === 'searched'
      ? response.hits
      : searchFrame({ ...frame, data }, region, query);
  }

  /**
   * Re-runs a head twice -- whole and reduced -- off the main thread.
   *
   * At 384 trunk channels into 48 head channels over 361 points this is a few
   * million multiply-adds per run, and two runs per request. On the main thread
   * that is a visible stall every time a checkbox is ticked.
   */
  async reduce(
    trunk: Float32Array,
    weights: HeadWeights,
    geometry: HeadGeometry,
    selected: ReadonlySet<number>,
    mode: ReduceMode,
    head: HeadKind,
  ): Promise<HeadReduction> {
    const worker = this.#ensureWorker();
    const run = (): HeadReduction =>
      reduceHead(trunk, weights, geometry, selected, mode, head);
    if (worker === undefined) return run();

    const id = this.#nextId++;
    const copy = trunk.slice();
    const request: RenderRequest = {
      type: 'reduce',
      id,
      trunk: copy,
      weights,
      geometry,
      // A Set does not survive structured clone; the worker rebuilds it.
      selected: [...selected],
      mode,
      head,
    };
    const response = await this.#send(worker, request, id, [copy.buffer]);
    return response.type === 'reduced' ? response.result : run();
  }

  #send(
    worker: Worker,
    request: RenderRequest,
    id: number,
    transfer: Transferable[] = [],
  ): Promise<RenderResponse> {
    return new Promise<RenderResponse>((resolve) => {
      this.#pending.set(id, resolve);
      worker.postMessage(request, transfer);
    });
  }

  #ensureWorker(): Worker | undefined {
    if (this.#worker !== undefined) return this.#worker;
    if (this.#workerFailed()) return undefined;

    // `typeof Worker` rather than a try/catch alone: jsdom has no Worker at all,
    // and component tests must take the fallback rather than fail.
    if (typeof Worker === 'undefined') {
      this.#workerFailed.set(true);
      return undefined;
    }
    try {
      const worker = new Worker(new URL('./render.worker', import.meta.url), { type: 'module' });
      worker.addEventListener('message', (event: MessageEvent<RenderResponse>) => {
        const resolve = this.#pending.get(event.data.id);
        if (resolve === undefined) return;
        this.#pending.delete(event.data.id);
        resolve(event.data);
      });
      worker.addEventListener('error', () => {
        // Whatever is in flight will never answer; fail them back to the main
        // thread rather than leaving the grid blank.
        this.#workerFailed.set(true);
        this.#worker = undefined;
        for (const [, resolve] of this.#pending) {
          resolve({
            type: 'rendered',
            id: -1,
            rgba: new Uint8ClampedArray(0),
            changes: new Float64Array(0),
            impact: new Float64Array(0),
          });
        }
        this.#pending.clear();
      });
      this.#worker = worker;
      return worker;
    } catch {
      this.#workerFailed.set(true);
      return undefined;
    }
  }
}
