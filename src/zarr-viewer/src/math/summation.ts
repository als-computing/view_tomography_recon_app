/**
 * Numerically-robust summation and the error-free transformations it builds on. Naive left-to-right
 * accumulation loses precision when summing many terms or terms of disparate magnitude (grid line
 * integrals, N-body force accumulation, large-coordinate astro/cosmology sums); compensated (Kahan /
 * Neumaier) and pairwise summation recover most of those lost bits.
 *
 * @packageDocumentation
 */

/**
 * Error-free sum: returns `[hi, lo]` where `hi = fl(a + b)` and `lo` is the exact rounding error, so
 * `a + b = hi + lo` exactly (Knuth's TwoSum). The building block of compensated algorithms.
 */
export function twoSum(a: number, b: number): [number, number] {
  const s = a + b;
  const bb = s - a;
  const err = a - (s - bb) + (b - bb);
  return [s, err];
}

const SPLITTER = 134217729; // 2^27 + 1, for Dekker's splitting on a 53-bit mantissa

/** Split a double into two non-overlapping halves (Dekker), so `a = hi + lo` exactly. */
function split(a: number): [number, number] {
  const c = SPLITTER * a;
  const hi = c - (c - a);
  return [hi, a - hi];
}

/**
 * Error-free product: returns `[hi, lo]` where `hi = fl(a·b)` and `a·b = hi + lo` exactly (Dekker's
 * TwoProduct, since JS lacks a fused multiply-add). Building block for robust determinants and
 * compensated dot products.
 */
export function twoProduct(a: number, b: number): [number, number] {
  const p = a * b;
  const [ah, al] = split(a);
  const [bh, bl] = split(b);
  const err = al * bl - (p - ah * bh - al * bh - ah * bl);
  return [p, err];
}

/** Kahan compensated summation of an array (single running correction term). */
export function kahanSum(values: ArrayLike<number>): number {
  let sum = 0;
  let c = 0;
  for (let i = 0; i < values.length; i++) {
    const y = values[i]! - c;
    const t = sum + y;
    c = t - sum - y;
    sum = t;
  }
  return sum;
}

/** Neumaier (improved Kahan) summation — more accurate when the next term is larger than the sum. */
export function neumaierSum(values: ArrayLike<number>): number {
  let sum = 0;
  let c = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i]!;
    const t = sum + v;
    c += Math.abs(sum) >= Math.abs(v) ? sum - t + v : v - t + sum;
    sum = t;
  }
  return sum + c;
}

/** Pairwise (cascade) summation — O(n) with O(log n) error growth, cache-friendly. */
export function pairwiseSum(values: ArrayLike<number>, lo = 0, hi = values.length): number {
  const n = hi - lo;
  if (n <= 8) {
    let s = 0;
    for (let i = lo; i < hi; i++) s += values[i]!;
    return s;
  }
  const mid = lo + (n >> 1);
  return pairwiseSum(values, lo, mid) + pairwiseSum(values, mid, hi);
}

/** Compensated dot product (twoProduct + twoSum), accurate to near working precision. */
export function compensatedDot(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const n = Math.min(a.length, b.length);
  let sum = 0;
  let comp = 0; // accumulated correction from both products and sums
  for (let i = 0; i < n; i++) {
    const [p, pe] = twoProduct(a[i]!, b[i]!);
    const [s, se] = twoSum(sum, p);
    sum = s;
    comp += pe + se;
  }
  return sum + comp;
}

/**
 * A streaming Neumaier compensated accumulator. Use it where terms arrive incrementally (force loops,
 * integrators) and a running high-accuracy total is needed.
 *
 * @example
 * ```ts
 * const acc = new CompensatedSum();
 * for (const f of forces) acc.add(f);
 * const total = acc.value();
 * ```
 */
export class CompensatedSum {
  #sum = 0;
  #c = 0;

  /** Add a term. */
  public add(v: number): this {
    const t = this.#sum + v;
    this.#c += Math.abs(this.#sum) >= Math.abs(v) ? this.#sum - t + v : v - t + this.#sum;
    this.#sum = t;
    return this;
  }

  /** The current compensated total. */
  public value(): number {
    return this.#sum + this.#c;
  }

  /** Reset to zero. */
  public reset(): this {
    this.#sum = 0;
    this.#c = 0;
    return this;
  }
}
