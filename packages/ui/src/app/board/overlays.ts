/**
 * Turning analysis numbers into things that can be drawn.
 *
 * Pure, per CLAUDE.md: policy selection and ownership colour mapping are
 * decisions worth asserting, and nobody can verify a heatmap by looking at it.
 * `board-canvas` paints what these return.
 */

import type { BoardSize, Vertex } from '@katascope/core';

/** One candidate from the raw policy vector. */
export interface PolicyMove {
  /** `undefined` means pass, which has no place on the board. */
  readonly vertex: Vertex | undefined;
  readonly probability: number;
  /** 0 is the most likely move. */
  readonly rank: number;
}

/**
 * The `n` most likely moves from a raw KataGo policy vector.
 *
 * The vector is `width * height + 1` long, row-major from the top-left, pass
 * last, with **-1 at illegal points**. Illegal entries are dropped rather than
 * treated as zero, and so are legal ones with no meaningful probability: a
 * heatmap dot at 1e-9 is noise the user has to learn to ignore.
 *
 * Ties break by position so the output is stable across calls -- a marker that
 * jumps between equally-likely points while the user steps back and forth reads
 * as a bug.
 */
export function topPolicyMoves(
  policy: readonly number[],
  size: BoardSize,
  n: number,
  options: { readonly minProbability?: number } = {},
): readonly PolicyMove[] {
  const minProbability = options.minProbability ?? 1e-4;
  if (n <= 0) return [];

  const area = size.width * size.height;
  const candidates: { vertex: Vertex | undefined; probability: number; index: number }[] = [];

  for (let index = 0; index < policy.length && index <= area; index++) {
    const probability = policy[index] ?? -1;
    if (probability < 0 || probability < minProbability) continue;
    candidates.push({
      vertex: index === area ? undefined : { x: index % size.width, y: Math.floor(index / size.width) },
      probability,
      index,
    });
  }

  candidates.sort((a, b) => b.probability - a.probability || a.index - b.index);
  return candidates.slice(0, n).map((candidate, rank) => ({
    vertex: candidate.vertex,
    probability: candidate.probability,
    rank,
  }));
}

/** An ownership value's fill, as a canvas-ready colour. */
export interface OwnershipFill {
  /** `rgba(...)`, ready for `ctx.fillStyle`. */
  readonly color: string;
  /** 0..1, so a caller can skip drawing near-neutral points entirely. */
  readonly strength: number;
}

/**
 * Maps an ownership value to a fill.
 *
 * Ownership runs -1..1 from the perspective of the side to move. It is drawn
 * diverging about zero: the side to move's territory in one colour, the
 * opponent's in the other, and a neutral point invisible rather than grey --
 * painting neutrality would obscure the board for no information.
 *
 * `strength` is the magnitude, so the caller can threshold. Values outside
 * -1..1 are clamped rather than rejected: a slightly out-of-range float from a
 * net is not worth failing a render over.
 */
export function ownershipFill(value: number, options: { readonly maxAlpha?: number } = {}): OwnershipFill {
  const maxAlpha = options.maxAlpha ?? 0.55;
  const clamped = Number.isFinite(value) ? Math.max(-1, Math.min(1, value)) : 0;
  const strength = Math.abs(clamped);
  const alpha = strength * maxAlpha;

  // Blue for the side to move, orange against. Chosen to stay distinguishable
  // from black and white stones, which a black/white ownership map would not.
  const [r, g, b] = clamped >= 0 ? [90, 160, 255] : [255, 150, 70];
  return { color: `rgba(${r}, ${g}, ${b}, ${alpha.toFixed(3)})`, strength };
}

/**
 * Formats a probability as a percentage for a move label.
 *
 * Two significant figures below 10%, none above: "0.42%" and "37%" are both
 * readable inside a stone-sized circle, "0.4166%" is not.
 */
export function formatPolicyPercent(probability: number): string {
  const percent = probability * 100;
  if (!Number.isFinite(percent) || percent < 0) return '';
  if (percent >= 10) return `${Math.round(percent)}%`;
  if (percent >= 1) return `${percent.toFixed(1)}%`;
  return `${percent.toFixed(2)}%`;
}
