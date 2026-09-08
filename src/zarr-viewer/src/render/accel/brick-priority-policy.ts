/**
 * Item 9 stage 9b: picks which of the visibility feedback's already-ranked bins (see
 * `visibility.ts`'s `rankVisibilityBins`, which already ranks the *whole* view, not just the
 * top choice) should back the atlas's secondary (non-primary) brick slots. `ResidencyController`'s
 * primary ROI region keeps its own existing, heavily anti-thrash-tuned selection logic unchanged
 * (frustum/crop box + shrink-toward-hint) — this module only generalizes the "only `ranked[0]` is ever
 * used" limitation into "also request the next N-1 highest-priority bins", a small, bounded, pure,
 * fully unit-testable extension of logic that already existed.
 *
 * @packageDocumentation
 */

/** The subset of `VisibilityBin` this policy needs — a structural type so this module has no
 * dependency on `visibility.ts` beyond the shape it actually reads. */
export interface RankedBin {
  x: number;
  y: number;
  z: number;
  priority: number;
}

/** Options for {@link BrickPriorityPolicy.selectSecondary}. */
export interface SelectSecondaryBinsOptions {
  /** Max number of secondary bins to pick (e.g. atlas capacity minus 1 for the primary slot). */
  maxCount: number;
  /** The bin already being served by the primary slot, if any — excluded from secondary picks so the
   * same region isn't redundantly streamed into two slots. */
  primary?: { x: number; y: number; z: number };
}

/** Given `ranked` bins (highest priority first, as `rankVisibilityBins` already returns), decides
 * which should back the atlas's secondary brick slots. */
export interface BrickPriorityPolicy {
  selectSecondary(ranked: readonly RankedBin[], opts: SelectSecondaryBinsOptions): RankedBin[];
}

/**
 * Straightforward generalization of today's single-region behavior: take the next-highest-priority
 * bins after the primary, in rank order, up to `maxCount`, skipping non-positive-priority bins (a
 * zero/negative priority means that bin doesn't need refining — see `visPriority`'s doc comment) and
 * the primary's own bin.
 */
export class DefaultBrickPriorityPolicy implements BrickPriorityPolicy {
  public selectSecondary(
    ranked: readonly RankedBin[],
    opts: SelectSecondaryBinsOptions,
  ): RankedBin[] {
    const out: RankedBin[] = [];
    for (const bin of ranked) {
      if (out.length >= opts.maxCount) break;
      if (bin.priority <= 0) continue;
      if (opts.primary && bin.x === opts.primary.x && bin.y === opts.primary.y && bin.z === opts.primary.z) {
        continue;
      }
      out.push(bin);
    }
    return out;
  }
}
