/// <reference lib="webworker" />
/**
 * Decoding and normalisation, off the main thread.
 *
 * A b18c384 frame is 384 channels of 361 cells; normalising and colouring all
 * of it is a few million operations, and doing that on the main thread between
 * arrow-key presses is exactly how a grid stops feeling like a grid.
 *
 * The worker holds no state beyond an in-progress statistics accumulation. All
 * the arithmetic is in `render-core`, which the main thread also runs when a
 * worker cannot be constructed.
 */

import { reduceHead, searchFrame } from '@katascope/core';
import { ChannelStatsAccumulator } from './channel-stats';
import { renderFrame } from './render-core';
import type { RenderRequest, RenderResponse } from './render-protocol';

let accumulator: ChannelStatsAccumulator | undefined;

addEventListener('message', (event: MessageEvent<RenderRequest>) => {
  const request = event.data;

  switch (request.type) {
    case 'statsBegin':
      accumulator = new ChannelStatsAccumulator(request.channels, request.area);
      return;

    case 'statsAdd':
      accumulator?.add(request.data);
      return;

    case 'statsEnd': {
      const stats = accumulator?.result() ?? [];
      accumulator = undefined;
      const response: RenderResponse = { type: 'stats', id: request.id, stats };
      postMessage(response);
      return;
    }

    case 'render': {
      const { rgba, changes, impact } = renderFrame(request.data, request.previous, request.options);
      const response: RenderResponse = { type: 'rendered', id: request.id, rgba, changes, impact };
      // Transfer rather than copy: the buffer is up to 550 KiB per repaint.
      postMessage(response, [rgba.buffer, changes.buffer, impact.buffer]);
      return;
    }

    case 'reduce': {
      const result = reduceHead(
        request.trunk,
        request.weights,
        request.geometry,
        new Set(request.selected),
        request.mode,
        request.head,
      );
      const response: RenderResponse = { type: 'reduced', id: request.id, result };
      postMessage(response);
      return;
    }

    case 'search': {
      const hits = searchFrame(
        {
          moveNumber: request.moveNumber,
          block: request.block,
          channels: request.channels,
          data: request.data,
        },
        request.region,
        request.query,
      );
      const response: RenderResponse = { type: 'searched', id: request.id, hits };
      postMessage(response);
      return;
    }
  }
});
