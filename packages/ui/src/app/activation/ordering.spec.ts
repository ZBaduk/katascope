/** The impact and attribution orderings. */

import { describe, expect, it } from 'vitest';
import {
  channelImpact,
  channelMagnitudes,
  headLeans,
  orderByScore,
  ranksFromOrder,
} from './ordering';

const AREA = 4;

/** Channel-major planes for a 2x2 board. */
function frame(...channels: readonly (readonly number[])[]): Float32Array {
  return new Float32Array(channels.flat());
}

describe('channelMagnitudes', () => {
  it('sums absolute activation per channel', () => {
    const data = frame([1, -2, 3, -4], [0, 0, 0, 1]);
    expect([...channelMagnitudes(data, 2, AREA)]).toEqual([10, 1]);
  });

  it('ignores non-finite values rather than poisoning a channel', () => {
    const data = frame([1, Number.NaN, 2, Infinity]);
    expect(channelMagnitudes(data, 1, AREA)[0]).toBe(3);
  });

  it('returns an empty result for a degenerate frame', () => {
    expect(channelMagnitudes(new Float32Array(0), 0, AREA)).toHaveLength(0);
    expect(channelMagnitudes(frame([1, 1, 1, 1]), 1, 0)[0]).toBe(0);
  });
});

describe('channelImpact', () => {
  it('scales loudness by how hard the consumer reads the channel', () => {
    // A quiet channel under a heavy reader can outrank a loud one nothing looks at.
    const impact = channelImpact([10, 1], [0.1, 5]);
    expect([...impact]).toEqual([1, 5]);
    expect(orderByScore(impact)).toEqual([1, 0]);
  });

  it('falls back to loudness alone with no reader norms', () => {
    // A capture has no weights to measure; a weaker ordering beats none.
    expect([...channelImpact([3, 1, 2], undefined)]).toEqual([3, 1, 2]);
  });

  it('treats a missing norm as zero rather than as one', () => {
    // A channel whose reader we could not measure is not "averagely important".
    expect([...channelImpact([5, 5], [2])]).toEqual([10, 0]);
  });

  it('never emits a non-finite score', () => {
    for (const value of channelImpact([Infinity, 1], [1, Number.NaN])) {
      expect(Number.isFinite(value)).toBe(true);
    }
  });
});

describe('orderByScore', () => {
  it('orders largest first', () => {
    expect(orderByScore([1, 9, 5])).toEqual([1, 2, 0]);
  });

  it('breaks ties by channel index, so the grid does not reshuffle', () => {
    expect(orderByScore([4, 4, 4])).toEqual([0, 1, 2]);
  });

  it('handles an empty score list', () => {
    expect(orderByScore([])).toEqual([]);
  });
});

describe('ranksFromOrder', () => {
  it('inverts an ordering', () => {
    expect([...ranksFromOrder([2, 0, 1])]).toEqual([1, 2, 0]);
  });

  it('round-trips with orderByScore', () => {
    const scores = [3, 9, 1, 7];
    const ranks = ranksFromOrder(orderByScore(scores));
    // The largest score must rank first.
    expect(ranks[1]).toBe(0);
    expect(ranks[2]).toBe(3);
  });
});

describe('headLeans', () => {
  it('classifies a channel by which head reads it harder', () => {
    const leans = headLeans([10, 1, 5], [1, 10, 5]);
    expect(leans).toEqual(['policy', 'value', 'shared']);
  });

  it('normalises each head before comparing', () => {
    // One head having larger weights throughout must not tint every channel:
    // doubling the value vector changes nothing about which head leans where.
    const plain = headLeans([4, 1], [1, 4]);
    const scaled = headLeans([4, 1], [100, 400]);
    expect(scaled).toEqual(plain);
  });

  it('calls a channel shared when neither head clearly wins', () => {
    expect(headLeans([1, 1], [1.2, 1])).toEqual(['shared', 'shared']);
  });

  it('honours an explicit ratio', () => {
    expect(headLeans([2, 1], [1, 1], 1.1)).toEqual(['policy', 'value']);
    expect(headLeans([2, 1], [1, 1], 10)).toEqual(['shared', 'shared']);
  });

  it('handles a head that reads nothing at all', () => {
    expect(headLeans([1, 1], [0, 0])).toEqual(['policy', 'policy']);
    expect(headLeans([0, 0], [0, 0])).toEqual(['shared', 'shared']);
  });

  it('stops at the shorter vector rather than inventing channels', () => {
    expect(headLeans([1, 1, 1], [1])).toHaveLength(1);
  });
});
