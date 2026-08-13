/**
 * Scalar root finding: bracketing (bisection), open (Newton), and hybrid (Brent) methods for solving
 * `f(x) = 0`. Brent is the recommended default — it combines the guaranteed convergence of bisection
 * with the speed of inverse-quadratic interpolation and needs no derivative.
 *
 * @packageDocumentation
 */

/** Options shared by the root finders. */
export interface RootOptions {
  /** Convergence tolerance on `|f(x)|` and the bracket width. Default `1e-12`. */
  tolerance?: number;
  /** Maximum iterations. Default `100`. */
  maxIterations?: number;
}

/** Result of a root find. */
export interface RootResult {
  /** Best root estimate. */
  root: number;
  /** Iterations performed. */
  iterations: number;
  /** Whether the tolerance was reached. */
  converged: boolean;
}

/**
 * Bisection: robustly halve a bracket `[a, b]` on which `f` changes sign. Linear convergence but
 * cannot fail to converge for a continuous function with a sign change.
 *
 * @throws {RangeError} if `f(a)` and `f(b)` do not straddle zero.
 */
export function bisection(
  f: (x: number) => number,
  a: number,
  b: number,
  opts: RootOptions = {},
): RootResult {
  const tol = opts.tolerance ?? 1e-12;
  const maxIter = opts.maxIterations ?? 100;
  let lo = a;
  let hi = b;
  let flo = f(lo);
  const fhi = f(hi);
  if (flo === 0) return { root: lo, iterations: 0, converged: true };
  if (fhi === 0) return { root: hi, iterations: 0, converged: true };
  if (flo * fhi > 0) throw new RangeError("bisection: root is not bracketed by [a, b]");

  let mid = 0.5 * (lo + hi);
  let iter = 0;
  for (; iter < maxIter; iter++) {
    mid = 0.5 * (lo + hi);
    const fmid = f(mid);
    if (Math.abs(fmid) <= tol || 0.5 * (hi - lo) <= tol) {
      return { root: mid, iterations: iter + 1, converged: true };
    }
    if (flo * fmid < 0) {
      hi = mid;
    } else {
      lo = mid;
      flo = fmid;
    }
  }
  return { root: mid, iterations: iter, converged: false };
}

/**
 * Newton's method: quadratic convergence from a good initial guess using the derivative `df`. Falls
 * back to reporting non-convergence if a derivative vanishes or the iteration diverges.
 */
export function newton(
  f: (x: number) => number,
  df: (x: number) => number,
  x0: number,
  opts: RootOptions = {},
): RootResult {
  const tol = opts.tolerance ?? 1e-12;
  const maxIter = opts.maxIterations ?? 100;
  let x = x0;
  for (let iter = 0; iter < maxIter; iter++) {
    const fx = f(x);
    if (Math.abs(fx) <= tol) return { root: x, iterations: iter, converged: true };
    const dfx = df(x);
    if (dfx === 0 || !Number.isFinite(dfx)) break;
    const next = x - fx / dfx;
    if (!Number.isFinite(next)) break;
    if (Math.abs(next - x) <= tol) return { root: next, iterations: iter + 1, converged: true };
    x = next;
  }
  return { root: x, iterations: maxIter, converged: false };
}

/**
 * Brent's method: derivative-free hybrid of bisection, secant, and inverse quadratic interpolation.
 * Super-linear convergence with the safety of a maintained bracket — the general-purpose default.
 *
 * @throws {RangeError} if `f(a)` and `f(b)` do not straddle zero.
 */
export function brent(
  f: (x: number) => number,
  a: number,
  b: number,
  opts: RootOptions = {},
): RootResult {
  const tol = opts.tolerance ?? 1e-12;
  const maxIter = opts.maxIterations ?? 100;
  let fa = f(a);
  let fb = f(b);
  if (fa === 0) return { root: a, iterations: 0, converged: true };
  if (fb === 0) return { root: b, iterations: 0, converged: true };
  if (fa * fb > 0) throw new RangeError("brent: root is not bracketed by [a, b]");

  // Ensure |f(b)| <= |f(a)| so b is the best estimate.
  if (Math.abs(fa) < Math.abs(fb)) {
    [a, b] = [b, a];
    [fa, fb] = [fb, fa];
  }

  let c = a;
  let fc = fa;
  let d = b - a;
  let mflag = true;

  for (let iter = 0; iter < maxIter; iter++) {
    if (Math.abs(fb) <= tol || Math.abs(b - a) <= tol) {
      return { root: b, iterations: iter, converged: true };
    }
    let s: number;
    if (fa !== fc && fb !== fc) {
      // Inverse quadratic interpolation.
      s =
        (a * fb * fc) / ((fa - fb) * (fa - fc)) +
        (b * fa * fc) / ((fb - fa) * (fb - fc)) +
        (c * fa * fb) / ((fc - fa) * (fc - fb));
    } else {
      // Secant.
      s = b - fb * ((b - a) / (fb - fa));
    }

    const lo = (3 * a + b) / 4;
    const useBisection =
      !((s > Math.min(lo, b) && s < Math.max(lo, b)) || false) ||
      (mflag && Math.abs(s - b) >= Math.abs(b - c) / 2) ||
      (!mflag && Math.abs(s - b) >= Math.abs(c - d) / 2) ||
      (mflag && Math.abs(b - c) < tol) ||
      (!mflag && Math.abs(c - d) < tol);
    if (useBisection) {
      s = 0.5 * (a + b);
      mflag = true;
    } else {
      mflag = false;
    }

    const fs = f(s);
    d = c;
    c = b;
    fc = fb;
    if (fa * fs < 0) {
      b = s;
      fb = fs;
    } else {
      a = s;
      fa = fs;
    }
    if (Math.abs(fa) < Math.abs(fb)) {
      [a, b] = [b, a];
      [fa, fb] = [fb, fa];
    }
  }
  return { root: b, iterations: maxIter, converged: Math.abs(fb) <= tol };
}
