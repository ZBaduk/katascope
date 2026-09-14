/**
 * The three channel orderings, as pure functions.
 *
 * Each answers a different question, and they disagree — which is the point of
 * offering all three:
 *
 * * **change** — what moved since the last position with the same side to move.
 *   Cheap, and about this move rather than about the network.
 * * **impact** — `sum|activation| x reader norm`. How loud a channel is here,
 *   scaled by how hard anything downstream is listening. One multiply per
 *   channel on top of data already in hand, so it is free enough to leave on.
 * * **attribution** — `sum|activation x gradient|` for a chosen output. Exact,
 *   and costs a forward and a backward pass in the service to obtain.
 *
 * Per CLAUDE.md these take numbers and return numbers; the component picks
 * which to call and the canvas draws the result.
 */

/** Total absolute activation per channel, the activation half of impact. */
export function channelMagnitudes(
  data: ArrayLike<number>,
  channels: number,
  area: number,
): Float64Array {
  const out = new Float64Array(Math.max(0, channels));
  if (channels <= 0 || area <= 0) return out;
  for (let channel = 0; channel < channels; channel++) {
    const base = channel * area;
    let total = 0;
    for (let i = 0; i < area; i++) {
      const value = data[base + i] ?? 0;
      if (Number.isFinite(value)) total += Math.abs(value);
    }
    out[channel] = total;
  }
  return out;
}

/**
 * `sum|activation| x reader norm` per channel.
 *
 * A loud channel nothing reads is not important, and a quiet one under a heavy
 * reader can still be. Multiplying is the cheapest thing that respects both.
 *
 * With no reader norms the magnitudes are returned unchanged rather than zeroed
 * — a capture has no weights to measure, and falling back to loudness alone is
 * a weaker ordering, not a broken one.
 */
export function channelImpact(
  magnitudes: ArrayLike<number>,
  readerNorms: ArrayLike<number> | undefined,
): Float64Array {
  const out = new Float64Array(magnitudes.length);
  for (let channel = 0; channel < magnitudes.length; channel++) {
    const magnitude = magnitudes[channel] ?? 0;
    const norm = readerNorms === undefined ? 1 : (readerNorms[channel] ?? 0);
    const value = magnitude * norm;
    out[channel] = Number.isFinite(value) ? value : 0;
  }
  return out;
}

/**
 * Channel indices ordered by a score, largest first.
 *
 * Ties break by channel index so the grid does not reshuffle between two
 * equally-scored channels as the user steps back and forth.
 */
export function orderByScore(scores: ArrayLike<number>): readonly number[] {
  const order = Array.from({ length: scores.length }, (_, i) => i);
  order.sort((a, b) => (scores[b] ?? 0) - (scores[a] ?? 0) || a - b);
  return order;
}

/** Where each channel sits in an ordering. `rank[c] === 0` is first. */
export function ranksFromOrder(order: readonly number[]): Int32Array {
  const ranks = new Int32Array(order.length).fill(-1);
  for (const [rank, channel] of order.entries()) {
    if (channel >= 0 && channel < ranks.length) ranks[channel] = rank;
  }
  return ranks;
}

/** Which head leans on a channel, for tinting the last block's tiles. */
export type HeadLean = 'policy' | 'value' | 'shared';

/**
 * Classifies each channel of the last block by which head reads it harder.
 *
 * Compares the two heads' reader norms after scaling each vector to unit mean,
 * because the heads' raw magnitudes are not commensurate — one may simply have
 * larger weights throughout, which would tint every channel the same way and
 * say nothing.
 *
 * `ratio` is how much louder the winning head has to be before a channel counts
 * as leaning rather than shared.
 */
export function headLeans(
  policyNorms: ArrayLike<number>,
  valueNorms: ArrayLike<number>,
  ratio = 1.5,
): readonly HeadLean[] {
  const length = Math.min(policyNorms.length, valueNorms.length);
  const policyScale = meanOf(policyNorms, length);
  const valueScale = meanOf(valueNorms, length);
  const out: HeadLean[] = [];

  for (let channel = 0; channel < length; channel++) {
    const policy = policyScale > 0 ? (policyNorms[channel] ?? 0) / policyScale : 0;
    const value = valueScale > 0 ? (valueNorms[channel] ?? 0) / valueScale : 0;
    if (policy > value * ratio) out.push('policy');
    else if (value > policy * ratio) out.push('value');
    else out.push('shared');
  }
  return out;
}

function meanOf(values: ArrayLike<number>, length: number): number {
  if (length <= 0) return 0;
  let total = 0;
  for (let i = 0; i < length; i++) {
    const value = values[i] ?? 0;
    if (Number.isFinite(value)) total += value;
  }
  return total / length;
}
