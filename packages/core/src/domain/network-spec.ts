/** Shape of the network being inspected. */

import type { BoardSize } from './board.js';
import { squareBoardSize } from './board.js';

/**
 * The structural facts about a KataGo net that katascope needs in order to lay
 * out and address activations. This is deliberately not a full model
 * description -- it is the minimum required to enumerate inspectable tensors.
 */
export interface NetworkSpec {
  /** Model name, e.g. `b6c96-s175M`. */
  readonly name: string;
  /** Number of residual blocks in the trunk. */
  readonly blocks: number;
  /** Trunk width, in channels. */
  readonly channels: number;
  /** Spatial extent the activations were computed at. */
  readonly boardSize: BoardSize;
}

/** The small net used by `FakeActivationStore` so the UI can be built offline. */
export const B6C96: NetworkSpec = {
  name: 'b6c96-fake',
  blocks: 6,
  channels: 96,
  boardSize: squareBoardSize(19),
};

/** Every block index addressable in a spec, `0 .. blocks - 1`. */
export function blockIndices(spec: NetworkSpec): readonly number[] {
  return Array.from({ length: spec.blocks }, (_, i) => i);
}

export function describeNetwork(spec: NetworkSpec): string {
  const { width, height } = spec.boardSize;
  return `${spec.name} (b${spec.blocks}c${spec.channels} @ ${width}x${height})`;
}
