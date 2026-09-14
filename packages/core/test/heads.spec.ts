/**
 * The TypeScript re-implementation of KataGo's output heads.
 *
 * The important tests here are the fixture ones. Everything else in this file
 * checks that a piece of arithmetic does what its name says; the fixture checks
 * that the *whole recipe* is KataGo's recipe, against numbers produced by
 * `tools/activation-service/tests/support/head_reference.py` -- which
 * `test_head_golden.py` in turn pins to the real model on real positions.
 *
 * That chain matters. A head re-implementation that is subtly wrong -- a
 * missing mask, the pooled branch left out, the wrong activation -- produces a
 * perfectly plausible policy, and no amount of looking at the overlay would
 * reveal it. The fixture is the only thing standing between "the numbers look
 * like a policy" and "the numbers are the policy".
 */

import { describe, expect, it } from 'vitest';
import {
  addChannelBias,
  boardMask,
  conv1x1,
  fullGeometry,
  HeadShapeError,
  headInput,
  kataGPool,
  kataValueGPool,
  linear,
  maskChannels,
  mish,
  ownershipHead,
  policyHead,
  policySoftmax,
  reduceHead,
  squareBoardSize,
  type Conv1x1,
  type HeadGeometry,
  type HeadWeights,
} from '../src/index.js';
import { readTextFixture } from './support/fixtures.js';

interface Fixture {
  readonly version: number;
  readonly activation: 'mish';
  readonly trunkChannels: number;
  readonly posLen: number;
  readonly board: { readonly width: number; readonly height: number };
  readonly trunkFinalScale: number;
  readonly shapes: Record<string, readonly number[]>;
  readonly tensors: Record<string, readonly number[]>;
  readonly trunk: readonly number[];
  readonly expected: {
    readonly headInput: readonly number[];
    readonly policyLogits: readonly number[];
    readonly policyPass: number;
    readonly policyProbs: readonly number[];
    readonly ownership: readonly number[];
  };
  readonly reduction: {
    readonly selected: readonly number[];
    readonly mode: 'only';
    readonly policyLogits: readonly number[];
    readonly policyPass: number;
    readonly ownership: readonly number[];
  };
}

const FIXTURE = JSON.parse(readTextFixture('heads', 'tiny-head.json')) as Fixture;

/**
 * Tolerance for the fixture comparisons.
 *
 * The reference runs in float64 and this runs in float32 buffers, so the gap is
 * float32 rounding accumulated over a few matrix multiplies. Measured at about
 * 2e-6 on this fixture; 1e-4 matches the golden test's tolerance.
 */
const ATOL = 1e-4;

function tensor(name: string): Float32Array {
  const values = FIXTURE.tensors[name];
  if (values === undefined) throw new Error(`fixture has no tensor ${name}`);
  return Float32Array.from(values);
}

function conv(name: string): Conv1x1 {
  const shape = FIXTURE.shapes[name];
  if (shape === undefined) throw new Error(`fixture has no shape for ${name}`);
  return {
    outChannels: shape[0] ?? 0,
    inChannels: shape[1] ?? 0,
    weight: tensor(name),
  };
}

function fixtureWeights(): HeadWeights {
  const linearShape = (name: string) => {
    const shape = FIXTURE.shapes[name];
    return {
      outFeatures: shape?.[0] ?? 0,
      inFeatures: shape?.[1] ?? 0,
      weight: tensor(name),
    };
  };
  return {
    networkName: 'tiny-head',
    version: FIXTURE.version,
    activation: FIXTURE.activation,
    trunkChannels: FIXTURE.trunkChannels,
    posLen: FIXTURE.posLen,
    trunkFinal: { scale: FIXTURE.trunkFinalScale, beta: tensor('trunkfinal.beta') },
    policy: {
      conv1p: conv('policy.conv1p'),
      conv1g: conv('policy.conv1g'),
      biasg: tensor('policy.biasg'),
      linearG: linearShape('policy.linear_g'),
      linearPass: linearShape('policy.linear_pass'),
      bias2: tensor('policy.bias2'),
      conv2p: conv('policy.conv2p'),
    },
    value: {
      conv1: conv('value.conv1'),
      bias1: tensor('value.bias1'),
      convOwnership: conv('value.conv_ownership'),
    },
  };
}

const GEOMETRY: HeadGeometry = {
  planes: squareBoardSize(FIXTURE.posLen),
  board: FIXTURE.board,
};

function expectClose(actual: ArrayLike<number>, expected: readonly number[], atol = ATOL): void {
  expect(actual.length).toBe(expected.length);
  let worst = 0;
  let worstAt = -1;
  for (let i = 0; i < expected.length; i++) {
    const diff = Math.abs((actual[i] ?? 0) - (expected[i] ?? 0));
    if (diff > worst) {
      worst = diff;
      worstAt = i;
    }
  }
  expect(
    worst,
    `worst disagreement ${worst} at index ${worstAt} (${actual[worstAt]} vs ${expected[worstAt]})`,
  ).toBeLessThan(atol);
}

describe('mish', () => {
  it('matches known values', () => {
    // x * tanh(softplus(x)).
    expect(mish(0)).toBeCloseTo(0, 12);
    expect(mish(1)).toBeCloseTo(0.865_098_39, 6);
    expect(mish(-1)).toBeCloseTo(-0.303_401_28, 6);
    expect(mish(5)).toBeCloseTo(4.999_552_08, 6);
  });

  it('has a finite minimum below zero, unlike relu', () => {
    // The trunk is post-ReLU and non-negative; the heads are not, and a mish
    // implementation that clamped at zero would pass most tests and be wrong.
    expect(mish(-0.6)).toBeLessThan(0);
    expect(mish(-20)).toBeGreaterThan(-1e-6);
  });

  it('does not overflow for large inputs', () => {
    // A naive log(1 + exp(x)) returns Infinity around x = 710 and NaN after.
    expect(Number.isFinite(mish(100))).toBe(true);
    expect(mish(1000)).toBeCloseTo(1000, 3);
  });
});

describe('conv1x1', () => {
  it('multiplies channels per board point', () => {
    const input = Float32Array.from([1, 2, 3, 4]); // 2 channels of 2 cells
    const weights: Conv1x1 = { outChannels: 1, inChannels: 2, weight: Float32Array.from([10, 100]) };
    // out[i] = 10 * in0[i] + 100 * in1[i]
    expect([...conv1x1(input, weights, 2)]).toEqual([310, 420]);
  });

  it('rejects an input that is too short for the declared channels', () => {
    const weights: Conv1x1 = { outChannels: 1, inChannels: 3, weight: new Float32Array(3) };
    expect(() => conv1x1(new Float32Array(4), weights, 2)).toThrow(HeadShapeError);
  });

  it('rejects a weight that does not match its declared shape', () => {
    const weights: Conv1x1 = { outChannels: 2, inChannels: 2, weight: new Float32Array(3) };
    expect(() => conv1x1(new Float32Array(4), weights, 2)).toThrow(HeadShapeError);
  });
});

describe('boardMask', () => {
  it('marks the top-left corner of the extent', () => {
    const mask = boardMask({ planes: squareBoardSize(3), board: { width: 2, height: 2 } });
    // Row-major 3x3: on-board cells are (0,0) (1,0) (0,1) (1,1).
    expect([...mask]).toEqual([1, 1, 0, 1, 1, 0, 0, 0, 0]);
  });

  it('is all ones when the game fills the extent', () => {
    const mask = boardMask(fullGeometry(squareBoardSize(4)));
    expect([...mask].every((v) => v === 1)).toBe(true);
  });
});

describe('addChannelBias', () => {
  it('zeroes off-board cells when given a mask', () => {
    const values = Float32Array.from([1, 1, 1, 1]);
    const mask = Uint8Array.from([1, 0, 1, 0]);
    addChannelBias(values, [10], 1, 4, mask);
    expect([...values]).toEqual([11, 0, 11, 0]);
  });

  it('leaves everything in place without a mask', () => {
    const values = Float32Array.from([1, 1]);
    addChannelBias(values, [5], 1, 2);
    expect([...values]).toEqual([6, 6]);
  });
});

describe('kataGPool', () => {
  it('divides the mean by the on-board count, not the buffer length', () => {
    // Four cells, two on-board holding 2 and 4. The mean must be 3, not 1.5.
    const values = Float32Array.from([2, 4, 99, 99]);
    const mask = Uint8Array.from([1, 1, 0, 0]);
    const pooled = kataGPool(values, 1, 4, mask, 2);
    expect(pooled[0]).toBeCloseTo(3, 6);
    expect(pooled[2]).toBeCloseTo(4, 6); // max, ignoring the off-board 99s
  });

  it('scales the second part by the board-size term', () => {
    const values = Float32Array.from([1, 1, 1, 1]);
    const mask = Uint8Array.from([1, 1, 1, 1]);
    const pooled = kataGPool(values, 1, 4, mask, 4);
    // (sqrt(4) - 14) / 10 = -1.2
    expect(pooled[1]).toBeCloseTo(-1.2, 6);
  });

  it('returns zeros for an empty board rather than dividing by zero', () => {
    const pooled = kataGPool(new Float32Array(4), 1, 4, new Uint8Array(4), 0);
    expect([...pooled].every((v) => v === 0)).toBe(true);
  });
});

describe('kataValueGPool', () => {
  it('uses the mean three times over, with no max', () => {
    const values = Float32Array.from([1, 3]);
    const mask = Uint8Array.from([1, 1]);
    const pooled = kataValueGPool(values, 1, 2, mask, 2);
    const root = Math.sqrt(2) - 14;
    expect(pooled[0]).toBeCloseTo(2, 6);
    expect(pooled[1]).toBeCloseTo(2 * (root / 10), 6);
    expect(pooled[2]).toBeCloseTo(2 * ((root * root) / 100 - 0.1), 6);
  });
});

describe('linear', () => {
  it('applies a bias when there is one', () => {
    const out = linear([1, 2], {
      outFeatures: 1,
      inFeatures: 2,
      weight: Float32Array.from([3, 4]),
      bias: Float32Array.from([100]),
    });
    expect(out[0]).toBeCloseTo(111, 6);
  });

  it('rejects a feature vector that is too short', () => {
    expect(() =>
      linear([1], { outFeatures: 1, inFeatures: 2, weight: Float32Array.from([1, 1]) }),
    ).toThrow(HeadShapeError);
  });
});

describe('maskChannels', () => {
  const input = Float32Array.from([1, 1, 2, 2, 3, 3]); // 3 channels of 2 cells

  it('keeps only the selection in "only" mode', () => {
    const out = maskChannels(input, new Set([1]), 'only', 3, 2);
    expect([...out]).toEqual([0, 0, 2, 2, 0, 0]);
  });

  it('drops only the selection in "without" mode', () => {
    const out = maskChannels(input, new Set([1]), 'without', 3, 2);
    expect([...out]).toEqual([1, 1, 0, 0, 3, 3]);
  });

  it('zeroes everything for an empty "only" selection', () => {
    // Reachable in one click, so it must be a defined state, not a crash.
    expect([...maskChannels(input, new Set(), 'only', 3, 2)].every((v) => v === 0)).toBe(true);
  });

  it('changes nothing for an empty "without" selection', () => {
    expect([...maskChannels(input, new Set(), 'without', 3, 2)]).toEqual([...input]);
  });

  it('copies rather than aliasing the caller’s buffer', () => {
    const out = maskChannels(input, new Set([0, 1, 2]), 'only', 3, 2);
    out[0] = 99;
    expect(input[0]).toBe(1);
  });
});

describe('the head against the reference fixture', () => {
  const weights = fixtureWeights();
  const trunk = Float32Array.from(FIXTURE.trunk);

  it('reproduces the head input', () => {
    // The trunk's final norm and activation, which is where a forgotten scale
    // or a wrong activation shows up first.
    expectClose(headInput(trunk, weights, GEOMETRY), FIXTURE.expected.headInput);
  });

  it('reproduces the policy logits', () => {
    const input = headInput(trunk, weights, GEOMETRY);
    expectClose(policyHead(input, weights, GEOMETRY).logits, FIXTURE.expected.policyLogits);
  });

  it('reproduces the pass logit, which comes from the pooled branch alone', () => {
    const input = headInput(trunk, weights, GEOMETRY);
    expect(policyHead(input, weights, GEOMETRY).pass).toBeCloseTo(
      FIXTURE.expected.policyPass,
      4,
    );
  });

  it('reproduces the policy distribution after softmax', () => {
    const input = headInput(trunk, weights, GEOMETRY);
    const out = policyHead(input, weights, GEOMETRY);
    expectClose(policySoftmax(out.logits, out.pass), FIXTURE.expected.policyProbs);
  });

  it('reproduces the ownership map', () => {
    const input = headInput(trunk, weights, GEOMETRY);
    expectClose(ownershipHead(input, weights, GEOMETRY), FIXTURE.expected.ownership);
  });

  it('reproduces a reduction, not just the full head', () => {
    // Pins the masking rule itself: zeroing at the head input, after the norm.
    const selected = new Set(FIXTURE.reduction.selected);
    const result = reduceHead(trunk, weights, GEOMETRY, selected, 'only', 'policy');
    expectClose(result.reduced.values, FIXTURE.reduction.policyLogits);
    expect(result.reduced.pass ?? 0).toBeCloseTo(FIXTURE.reduction.policyPass, 4);

    const ownership = reduceHead(trunk, weights, GEOMETRY, selected, 'only', 'ownership');
    expectClose(ownership.reduced.values, FIXTURE.reduction.ownership);
  });

  it('drives off-board policy logits far below every on-board one', () => {
    const input = headInput(trunk, weights, GEOMETRY);
    const { logits } = policyHead(input, weights, GEOMETRY);
    const mask = boardMask(GEOMETRY);
    for (let i = 0; i < logits.length; i++) {
      if (mask[i] === 0) expect(logits[i]).toBeLessThan(-1000);
    }
  });

  it('reports zero ownership off the board', () => {
    const input = headInput(trunk, weights, GEOMETRY);
    const ownership = ownershipHead(input, weights, GEOMETRY);
    const mask = boardMask(GEOMETRY);
    for (let i = 0; i < ownership.length; i++) {
      if (mask[i] === 0) expect(ownership[i]).toBe(0);
    }
  });
});

describe('reduceHead', () => {
  const weights = fixtureWeights();
  const trunk = Float32Array.from(FIXTURE.trunk);

  it('reports the full output, the reduced one and their difference', () => {
    const result = reduceHead(trunk, weights, GEOMETRY, new Set([0]), 'only', 'policy');
    for (let i = 0; i < result.difference.length; i++) {
      expect(result.difference[i]).toBeCloseTo(
        (result.full.values[i] ?? 0) - (result.reduced.values[i] ?? 0),
        5,
      );
    }
    expect(result.selected).toBe(1);
    expect(result.mode).toBe('only');
    expect(result.head).toBe('policy');
  });

  it('gives the full output back when "without" selects nothing', () => {
    const result = reduceHead(trunk, weights, GEOMETRY, new Set(), 'without', 'policy');
    expectClose(result.reduced.values, [...result.full.values], 1e-6);
    expect(result.difference.every((v) => Math.abs(v) < 1e-6)).toBe(true);
  });

  it('gives the full output back when "only" selects everything', () => {
    const all = new Set(Array.from({ length: FIXTURE.trunkChannels }, (_, i) => i));
    const result = reduceHead(trunk, weights, GEOMETRY, all, 'only', 'ownership');
    expectClose(result.reduced.values, [...result.full.values], 1e-6);
  });

  it('is not linear in the selection, which is why the head is re-run', () => {
    // If the head were linear, "only A" plus "only B" would equal "only A+B".
    // It is not, and a feature that assumed it could just sum per-channel
    // contributions would be quietly wrong -- hence re-running the head.
    const a = reduceHead(trunk, weights, GEOMETRY, new Set([0]), 'only', 'policy');
    const b = reduceHead(trunk, weights, GEOMETRY, new Set([1]), 'only', 'policy');
    const both = reduceHead(trunk, weights, GEOMETRY, new Set([0, 1]), 'only', 'policy');

    let maxGap = 0;
    for (let i = 0; i < both.reduced.values.length; i++) {
      const sum = (a.reduced.values[i] ?? 0) + (b.reduced.values[i] ?? 0);
      maxGap = Math.max(maxGap, Math.abs(sum - (both.reduced.values[i] ?? 0)));
    }
    expect(maxGap).toBeGreaterThan(1e-3);
  });

  it('carries a pass difference for policy and none for ownership', () => {
    const policy = reduceHead(trunk, weights, GEOMETRY, new Set([0]), 'only', 'policy');
    expect(policy.passDifference).toBeDefined();
    const ownership = reduceHead(trunk, weights, GEOMETRY, new Set([0]), 'only', 'ownership');
    expect(ownership.passDifference).toBeUndefined();
    expect(ownership.reduced.pass).toBeUndefined();
  });

  it('produces finite numbers when everything is zeroed', () => {
    const result = reduceHead(trunk, weights, GEOMETRY, new Set(), 'only', 'policy');
    expect([...result.reduced.values].every(Number.isFinite)).toBe(true);
    expect(Number.isFinite(result.reduced.pass ?? 0)).toBe(true);
    const probs = policySoftmax(result.reduced.values, result.reduced.pass ?? 0);
    const total = [...probs].reduce((sum, v) => sum + v, 0);
    expect(total).toBeCloseTo(1, 6);
  });
});
