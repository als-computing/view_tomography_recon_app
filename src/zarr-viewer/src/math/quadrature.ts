/**
 * Numerical integration (quadrature) of a scalar function over an interval: composite Simpson,
 * adaptive Simpson, and Gauss–Legendre. Gauss–Legendre with `n` points integrates polynomials up to
 * degree `2n − 1` exactly and is the efficient choice for smooth integrands; adaptive Simpson is the
 * robust choice when the integrand has features of unknown scale.
 *
 * @packageDocumentation
 */

/** Composite Simpson's rule over `[a, b]` with `intervals` subintervals (rounded up to even). */
export function simpson(
  f: (x: number) => number,
  a: number,
  b: number,
  intervals = 100,
): number {
  let n = Math.max(2, Math.ceil(intervals));
  if (n % 2 !== 0) n++;
  const h = (b - a) / n;
  let sum = f(a) + f(b);
  for (let i = 1; i < n; i++) {
    sum += (i % 2 === 0 ? 2 : 4) * f(a + i * h);
  }
  return (sum * h) / 3;
}

/**
 * Adaptive Simpson quadrature: recursively subdivides where the integrand is poorly resolved until
 * the estimated error is below `tolerance`. Good general-purpose default when the integrand's scale
 * of variation is unknown.
 */
export function adaptiveSimpson(
  f: (x: number) => number,
  a: number,
  b: number,
  tolerance = 1e-10,
  maxDepth = 50,
): number {
  const simpsonSingle = (lo: number, hi: number, flo: number, fmid: number, fhi: number): number =>
    ((hi - lo) / 6) * (flo + 4 * fmid + fhi);

  const fa = f(a);
  const fb = f(b);
  const m = 0.5 * (a + b);
  const fm = f(m);
  const whole = simpsonSingle(a, b, fa, fm, fb);

  const recurse = (
    lo: number,
    hi: number,
    flo: number,
    fmid: number,
    fhi: number,
    whole: number,
    tol: number,
    depth: number,
  ): number => {
    const mid = 0.5 * (lo + hi);
    const lmid = 0.5 * (lo + mid);
    const rmid = 0.5 * (mid + hi);
    const flmid = f(lmid);
    const frmid = f(rmid);
    const left = simpsonSingle(lo, mid, flo, flmid, fmid);
    const right = simpsonSingle(mid, hi, fmid, frmid, fhi);
    const delta = left + right - whole;
    // Richardson error estimate: |S(left)+S(right) − S(whole)| / 15.
    if (depth <= 0 || Math.abs(delta) <= 15 * tol) return left + right + delta / 15;
    return (
      recurse(lo, mid, flo, flmid, fmid, left, tol / 2, depth - 1) +
      recurse(mid, hi, fmid, frmid, fhi, right, tol / 2, depth - 1)
    );
  };

  return recurse(a, b, fa, fm, fb, whole, tolerance, maxDepth);
}

/** Cache of computed Gauss–Legendre nodes/weights on `[-1, 1]`, keyed by point count. */
const gaussCache = new Map<number, { nodes: Float64Array; weights: Float64Array }>();

/** Compute (and cache) the `n`-point Gauss–Legendre nodes and weights on `[-1, 1]`. */
function gaussNodes(n: number): { nodes: Float64Array; weights: Float64Array } {
  const cached = gaussCache.get(n);
  if (cached) return cached;
  const nodes = new Float64Array(n);
  const weights = new Float64Array(n);
  // Roots of the degree-n Legendre polynomial via Newton's method on the recurrence.
  for (let i = 0; i < n; i++) {
    // Initial guess: Chebyshev-like asymptotic node position.
    let x = Math.cos((Math.PI * (i + 0.75)) / (n + 0.5));
    let dp = 0;
    for (let iter = 0; iter < 100; iter++) {
      // Evaluate P_n(x) and P_n'(x) via the three-term recurrence.
      let p0 = 1;
      let p1 = x;
      for (let k = 2; k <= n; k++) {
        const p2 = ((2 * k - 1) * x * p1 - (k - 1) * p0) / k;
        p0 = p1;
        p1 = p2;
      }
      dp = (n * (x * p1 - p0)) / (x * x - 1);
      const dx = p1 / dp;
      x -= dx;
      if (Math.abs(dx) < 1e-15) break;
    }
    nodes[i] = x;
    weights[i] = 2 / ((1 - x * x) * dp * dp);
  }
  const result = { nodes, weights };
  gaussCache.set(n, result);
  return result;
}

/**
 * `n`-point Gauss–Legendre quadrature of `f` over `[a, b]`. Exact for polynomials of degree
 * ≤ `2n − 1`; the efficient choice for smooth integrands (spectral/optics integrals). Nodes and
 * weights are computed once per `n` and cached.
 */
export function gaussLegendre(
  f: (x: number) => number,
  a: number,
  b: number,
  n = 5,
): number {
  const { nodes, weights } = gaussNodes(n);
  const half = 0.5 * (b - a);
  const mid = 0.5 * (a + b);
  let sum = 0;
  for (let i = 0; i < n; i++) sum += weights[i]! * f(mid + half * nodes[i]!);
  return sum * half;
}
