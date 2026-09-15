/**
 * Dense linear algebra: dynamically-sized real matrices with LU and Cholesky factorizations, linear
 * solves, determinant / inverse, a matrix-free conjugate-gradient solver, a symmetric Jacobi
 * eigensolver, and polar decomposition.
 *
 * This is the shared numerics substrate the rest of the engine builds on: implicit / backward-Euler
 * integrators, constraint and LCP solvers, FEM stiffness assembly, inertia-tensor diagonalization,
 * grid pressure-projection Poisson solves, and PCA / Kabsch rigid alignment. The fixed-size
 * {@link Mat3} / {@link Mat4} remain the fast path for graphics transforms; this module covers the
 * general N-dimensional case.
 *
 * Matrices are **row-major**, `Float64Array`-backed; vectors are plain `Float64Array`. Solvers
 * validate dimensions and use relative, magnitude-aware singularity tolerances rather than a fixed
 * epsilon, so they behave sensibly for physically-conditioned systems.
 *
 * @packageDocumentation
 */

/** Thrown when a factorization or solve encounters a (numerically) singular matrix. */
export class SingularMatrixError extends Error {
  public constructor(message = "matrix is singular to working precision") {
    super(message);
    this.name = "SingularMatrixError";
  }
}

/** A dense, dynamically-sized, row-major real matrix backed by a `Float64Array`. */
export class Matrix {
  /** Number of rows. */
  public readonly rows: number;
  /** Number of columns. */
  public readonly cols: number;
  /** Row-major elements, length `rows * cols`. */
  public readonly data: Float64Array;

  /**
   * Create a `rows × cols` matrix, zero-filled unless `data` is supplied (which is adopted, not
   * copied, and must have length `rows * cols`).
   */
  public constructor(rows: number, cols: number, data?: Float64Array) {
    if (rows <= 0 || cols <= 0) throw new RangeError("Matrix dimensions must be positive");
    if (data && data.length !== rows * cols) {
      throw new RangeError(`data length ${data.length} != ${rows * cols}`);
    }
    this.rows = rows;
    this.cols = cols;
    this.data = data ?? new Float64Array(rows * cols);
  }

  /** The `n × n` identity matrix. */
  public static identity(n: number): Matrix {
    const m = new Matrix(n, n);
    for (let i = 0; i < n; i++) m.data[i * n + i] = 1;
    return m;
  }

  /** Build a matrix from an array of row arrays (all rows must share a length). */
  public static fromRows(rows: readonly (readonly number[])[]): Matrix {
    const r = rows.length;
    const c = rows[0]?.length ?? 0;
    const m = new Matrix(r, c);
    for (let i = 0; i < r; i++) {
      const row = rows[i]!;
      if (row.length !== c) throw new RangeError("ragged rows");
      for (let j = 0; j < c; j++) m.data[i * c + j] = row[j]!;
    }
    return m;
  }

  /** Element at `(i, j)` (row, column). */
  public get(i: number, j: number): number {
    return this.data[i * this.cols + j]!;
  }

  /** Set element at `(i, j)`. */
  public set(i: number, j: number, value: number): this {
    this.data[i * this.cols + j] = value;
    return this;
  }

  /** Allocate an independent copy. */
  public clone(): Matrix {
    return new Matrix(this.rows, this.cols, this.data.slice());
  }

  /** Allocate the transpose. */
  public transpose(): Matrix {
    const { rows, cols, data } = this;
    const t = new Matrix(cols, rows);
    for (let i = 0; i < rows; i++) {
      for (let j = 0; j < cols; j++) t.data[j * rows + i] = data[i * cols + j]!;
    }
    return t;
  }

  /** Allocate the matrix product `this · other`. */
  public mul(other: Matrix): Matrix {
    if (this.cols !== other.rows) {
      throw new RangeError(`incompatible shapes ${this.rows}x${this.cols} · ${other.rows}x${other.cols}`);
    }
    const n = this.rows;
    const m = other.cols;
    const k = this.cols;
    const out = new Matrix(n, m);
    const a = this.data;
    const b = other.data;
    const o = out.data;
    for (let i = 0; i < n; i++) {
      for (let p = 0; p < k; p++) {
        const aip = a[i * k + p]!;
        if (aip === 0) continue;
        for (let j = 0; j < m; j++) o[i * m + j]! += aip * b[p * m + j]!;
      }
    }
    return out;
  }

  /** Matrix–vector product `this · x`, written into `out` (allocated if omitted). */
  public mulVec(x: ArrayLike<number>, out?: Float64Array): Float64Array {
    if (x.length !== this.cols) throw new RangeError("vector length != cols");
    const { rows, cols, data } = this;
    const y = out ?? new Float64Array(rows);
    for (let i = 0; i < rows; i++) {
      let s = 0;
      for (let j = 0; j < cols; j++) s += data[i * cols + j]! * x[j]!;
      y[i] = s;
    }
    return y;
  }

  /** Frobenius norm `√Σ aᵢⱼ²`. */
  public frobeniusNorm(): number {
    const d = this.data;
    let s = 0;
    for (let i = 0; i < d.length; i++) s += d[i]! * d[i]!;
    return Math.sqrt(s);
  }

  /** Largest absolute element (matrix ∞-norm of the flattened entries). */
  public maxAbs(): number {
    const d = this.data;
    let m = 0;
    for (let i = 0; i < d.length; i++) {
      const v = Math.abs(d[i]!);
      if (v > m) m = v;
    }
    return m;
  }

  /** True if every element is within `tol` of `other`'s. */
  public equals(other: Matrix, tol = 1e-9): boolean {
    if (this.rows !== other.rows || this.cols !== other.cols) return false;
    const a = this.data;
    const b = other.data;
    for (let i = 0; i < a.length; i++) if (Math.abs(a[i]! - b[i]!) > tol) return false;
    return true;
  }
}

/** An LU factorization with partial pivoting: `P·A = L·U`, stored compactly in one matrix. */
export interface LuFactorization {
  /** Combined L (unit lower, implicit diagonal) and U (upper) factors, row-major. */
  readonly lu: Matrix;
  /** Row permutation: row `i` of `P·A` is row `piv[i]` of `A`. */
  readonly piv: Int32Array;
  /** Determinant sign from the pivot permutation (+1 or −1). */
  readonly sign: number;
}

/**
 * LU factorization with partial (row) pivoting.
 *
 * @throws {SingularMatrixError} if a pivot vanishes relative to the matrix magnitude.
 */
export function luDecompose(A: Matrix): LuFactorization {
  if (A.rows !== A.cols) throw new RangeError("LU requires a square matrix");
  const n = A.rows;
  const lu = A.clone();
  const d = lu.data;
  const piv = new Int32Array(n);
  for (let i = 0; i < n; i++) piv[i] = i;
  let sign = 1;
  const eps = 1e-14 * (A.maxAbs() || 1);

  for (let k = 0; k < n; k++) {
    // Partial pivot: pick the largest-magnitude entry in column k at or below the diagonal.
    let p = k;
    let max = Math.abs(d[k * n + k]!);
    for (let i = k + 1; i < n; i++) {
      const v = Math.abs(d[i * n + k]!);
      if (v > max) {
        max = v;
        p = i;
      }
    }
    if (max <= eps) throw new SingularMatrixError();
    if (p !== k) {
      for (let j = 0; j < n; j++) {
        const tmp = d[p * n + j]!;
        d[p * n + j] = d[k * n + j]!;
        d[k * n + j] = tmp;
      }
      const tp = piv[p]!;
      piv[p] = piv[k]!;
      piv[k] = tp;
      sign = -sign;
    }
    const pivot = d[k * n + k]!;
    for (let i = k + 1; i < n; i++) {
      const f = d[i * n + k]! / pivot;
      d[i * n + k] = f;
      for (let j = k + 1; j < n; j++) d[i * n + j]! -= f * d[k * n + j]!;
    }
  }
  return { lu, piv, sign };
}

/** Solve `A·x = b` from a precomputed LU factorization. */
export function luSolve(f: LuFactorization, b: ArrayLike<number>, out?: Float64Array): Float64Array {
  const n = f.lu.rows;
  if (b.length !== n) throw new RangeError("rhs length != matrix order");
  const d = f.lu.data;
  const x = out ?? new Float64Array(n);
  // Apply the row permutation to b.
  for (let i = 0; i < n; i++) x[i] = b[f.piv[i]!]!;
  // Forward substitution (unit lower L).
  for (let i = 0; i < n; i++) {
    let s = x[i]!;
    for (let j = 0; j < i; j++) s -= d[i * n + j]! * x[j]!;
    x[i] = s;
  }
  // Back substitution (upper U).
  for (let i = n - 1; i >= 0; i--) {
    let s = x[i]!;
    for (let j = i + 1; j < n; j++) s -= d[i * n + j]! * x[j]!;
    x[i] = s / d[i * n + i]!;
  }
  return x;
}

/** Solve the square system `A·x = b` via LU with partial pivoting. */
export function solve(A: Matrix, b: ArrayLike<number>, out?: Float64Array): Float64Array {
  return luSolve(luDecompose(A), b, out);
}

/** Determinant of a square matrix (via LU); returns 0 if singular. */
export function determinant(A: Matrix): number {
  if (A.rows !== A.cols) throw new RangeError("determinant requires a square matrix");
  let f: LuFactorization;
  try {
    f = luDecompose(A);
  } catch {
    return 0;
  }
  const n = A.rows;
  const d = f.lu.data;
  let det = f.sign;
  for (let i = 0; i < n; i++) det *= d[i * n + i]!;
  return det;
}

/** Inverse of a square matrix (via one LU and `n` back-solves). */
export function inverse(A: Matrix): Matrix {
  const n = A.rows;
  if (n !== A.cols) throw new RangeError("inverse requires a square matrix");
  const f = luDecompose(A);
  const inv = new Matrix(n, n);
  const col = new Float64Array(n);
  const x = new Float64Array(n);
  for (let j = 0; j < n; j++) {
    col.fill(0);
    col[j] = 1;
    luSolve(f, col, x);
    for (let i = 0; i < n; i++) inv.data[i * n + j] = x[i]!;
  }
  return inv;
}

/**
 * Cholesky factorization `A = L·Lᵀ` of a symmetric positive-definite matrix, returning the lower
 * factor `L`, or `null` if `A` is not SPD (a non-positive pivot is encountered). Roughly twice as
 * fast as LU and the right tool for SPD systems (normal equations, mass/stiffness matrices, the
 * pressure Poisson operator).
 */
export function choleskyDecompose(A: Matrix): Matrix | null {
  if (A.rows !== A.cols) throw new RangeError("Cholesky requires a square matrix");
  const n = A.rows;
  const a = A.data;
  const L = new Matrix(n, n);
  const l = L.data;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let s = a[i * n + j]!;
      for (let k = 0; k < j; k++) s -= l[i * n + k]! * l[j * n + k]!;
      if (i === j) {
        if (s <= 0) return null; // not positive-definite
        l[i * n + j] = Math.sqrt(s);
      } else {
        l[i * n + j] = s / l[j * n + j]!;
      }
    }
  }
  return L;
}

/** Solve `A·x = b` from a Cholesky factor `L` (where `A = L·Lᵀ`). */
export function choleskySolve(L: Matrix, b: ArrayLike<number>, out?: Float64Array): Float64Array {
  const n = L.rows;
  if (b.length !== n) throw new RangeError("rhs length != matrix order");
  const l = L.data;
  const x = out ?? new Float64Array(n);
  // Forward solve L·y = b.
  for (let i = 0; i < n; i++) {
    let s = b[i]!;
    for (let j = 0; j < i; j++) s -= l[i * n + j]! * x[j]!;
    x[i] = s / l[i * n + i]!;
  }
  // Back solve Lᵀ·x = y.
  for (let i = n - 1; i >= 0; i--) {
    let s = x[i]!;
    for (let j = i + 1; j < n; j++) s -= l[j * n + i]! * x[j]!;
    x[i] = s / l[i * n + i]!;
  }
  return x;
}

/** A linear operator `y ← A·x` for matrix-free iterative solvers. `out` may alias nothing in `x`. */
export type LinearOperator = (x: Float64Array, out: Float64Array) => void;

/** Options for {@link conjugateGradient}. */
export interface ConjugateGradientOptions {
  /** Maximum iterations. Default `n` (guaranteed convergence in exact arithmetic). */
  maxIterations?: number;
  /** Relative residual tolerance `‖r‖ / ‖b‖`. Default `1e-10`. */
  tolerance?: number;
  /** Initial guess (length `n`). Default all-zero. */
  x0?: ArrayLike<number>;
}

/** Result of an iterative solve. */
export interface IterativeSolveResult {
  /** The solution vector. */
  x: Float64Array;
  /** Iterations performed. */
  iterations: number;
  /** Final relative residual `‖b − A·x‖ / ‖b‖`. */
  residual: number;
  /** Whether the tolerance was reached. */
  converged: boolean;
}

/**
 * Matrix-free conjugate gradient for symmetric positive-definite systems `A·x = b`. Takes the
 * operator `A` as a callback so it works equally on dense matrices, sparse matrices, or a stencil
 * (e.g. the grid Laplacian in a fluid pressure solve) without ever assembling `A`.
 *
 * @param apply - Applies `A`: given `x`, writes `A·x` into the provided output buffer.
 * @param b - Right-hand side (length `n`).
 */
export function conjugateGradient(
  apply: LinearOperator,
  b: ArrayLike<number>,
  opts: ConjugateGradientOptions = {},
): IterativeSolveResult {
  const n = b.length;
  const tol = opts.tolerance ?? 1e-10;
  const maxIter = opts.maxIterations ?? n;

  const x = new Float64Array(n);
  if (opts.x0) x.set(opts.x0 as ArrayLike<number> as Float64Array);
  const r = new Float64Array(n);
  const p = new Float64Array(n);
  const Ap = new Float64Array(n);

  // r = b − A·x
  apply(x, Ap);
  let bNorm = 0;
  for (let i = 0; i < n; i++) {
    r[i] = b[i]! - Ap[i]!;
    p[i] = r[i]!;
    bNorm += b[i]! * b[i]!;
  }
  bNorm = Math.sqrt(bNorm) || 1;

  let rDotR = 0;
  for (let i = 0; i < n; i++) rDotR += r[i]! * r[i]!;

  let iterations = 0;
  let residual = Math.sqrt(rDotR) / bNorm;
  if (residual <= tol) return { x, iterations, residual, converged: true };

  for (let iter = 0; iter < maxIter; iter++) {
    apply(p, Ap);
    let pAp = 0;
    for (let i = 0; i < n; i++) pAp += p[i]! * Ap[i]!;
    if (pAp <= 0) break; // operator not SPD (or numerical breakdown)
    const alpha = rDotR / pAp;
    for (let i = 0; i < n; i++) {
      x[i]! += alpha * p[i]!;
      r[i]! -= alpha * Ap[i]!;
    }
    let rDotRNew = 0;
    for (let i = 0; i < n; i++) rDotRNew += r[i]! * r[i]!;
    iterations = iter + 1;
    residual = Math.sqrt(rDotRNew) / bNorm;
    if (residual <= tol) return { x, iterations, residual, converged: true };
    const beta = rDotRNew / rDotR;
    for (let i = 0; i < n; i++) p[i] = r[i]! + beta * p[i]!;
    rDotR = rDotRNew;
  }
  return { x, iterations, residual, converged: residual <= tol };
}

/** Convenience wrapper: {@link conjugateGradient} against an assembled dense SPD {@link Matrix}. */
export function conjugateGradientMatrix(
  A: Matrix,
  b: ArrayLike<number>,
  opts?: ConjugateGradientOptions,
): IterativeSolveResult {
  if (A.rows !== A.cols) throw new RangeError("CG requires a square matrix");
  if (A.rows !== b.length) throw new RangeError("rhs length != matrix order");
  return conjugateGradient((x, out) => A.mulVec(x, out), b, opts);
}

/** Eigendecomposition of a real symmetric matrix: `A = V·diag(values)·Vᵀ`. */
export interface SymmetricEigen {
  /** Eigenvalues, sorted in descending order. */
  values: Float64Array;
  /** Eigenvectors as the columns of `V` (orthonormal), aligned with `values`. */
  vectors: Matrix;
}

/**
 * Eigenvalues and eigenvectors of a real symmetric matrix via the cyclic Jacobi rotation method.
 * Robust and accurate for the small-to-moderate symmetric systems physics needs — inertia tensors,
 * stress/strain tensors, covariance (PCA) — where it beats a general QR eigensolver in simplicity.
 * The input is not modified.
 */
export function eigenSymmetric(A: Matrix, maxSweeps = 100): SymmetricEigen {
  if (A.rows !== A.cols) throw new RangeError("eigenSymmetric requires a square matrix");
  const n = A.rows;
  const a = A.clone().data; // working copy, mutated in place
  const V = Matrix.identity(n);
  const v = V.data;

  const offDiagNorm = (): number => {
    let s = 0;
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) s += a[i * n + j]! * a[i * n + j]!;
    return Math.sqrt(2 * s);
  };

  const scale = A.maxAbs() || 1;
  const tol = 1e-15 * scale;
  for (let sweep = 0; sweep < maxSweeps; sweep++) {
    if (offDiagNorm() <= tol) break;
    for (let p = 0; p < n; p++) {
      for (let q = p + 1; q < n; q++) {
        const apq = a[p * n + q]!;
        if (Math.abs(apq) <= tol) continue;
        const app = a[p * n + p]!;
        const aqq = a[q * n + q]!;
        // Jacobi rotation angle that zeroes a[p][q].
        const theta = (aqq - app) / (2 * apq);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const s = t * c;
        // Apply the rotation to rows/cols p,q of A (symmetric update).
        for (let i = 0; i < n; i++) {
          const aip = a[i * n + p]!;
          const aiq = a[i * n + q]!;
          a[i * n + p] = c * aip - s * aiq;
          a[i * n + q] = s * aip + c * aiq;
        }
        for (let i = 0; i < n; i++) {
          const api = a[p * n + i]!;
          const aqi = a[q * n + i]!;
          a[p * n + i] = c * api - s * aqi;
          a[q * n + i] = s * api + c * aqi;
        }
        // Accumulate the eigenvector rotation into V.
        for (let i = 0; i < n; i++) {
          const vip = v[i * n + p]!;
          const viq = v[i * n + q]!;
          v[i * n + p] = c * vip - s * viq;
          v[i * n + q] = s * vip + c * viq;
        }
      }
    }
  }

  // Extract diagonal as eigenvalues, then sort descending (carrying eigenvectors).
  const idx = Array.from({ length: n }, (_, i) => i);
  const diag = new Float64Array(n);
  for (let i = 0; i < n; i++) diag[i] = a[i * n + i]!;
  idx.sort((x, y) => diag[y]! - diag[x]!);
  const values = new Float64Array(n);
  const vectors = new Matrix(n, n);
  for (let col = 0; col < n; col++) {
    const src = idx[col]!;
    values[col] = diag[src]!;
    for (let i = 0; i < n; i++) vectors.data[i * n + col] = v[i * n + src]!;
  }
  return { values, vectors };
}

/** Polar decomposition `A = R·S`: `R` orthogonal (a rotation/reflection), `S` symmetric PSD. */
export interface PolarDecomposition {
  /** Orthogonal factor (the closest orthogonal matrix to `A`). */
  R: Matrix;
  /** Symmetric positive-semidefinite stretch factor, `S = Rᵀ·A`. */
  S: Matrix;
}

/**
 * Polar decomposition `A = R·S` of a square nonsingular matrix via Higham's Newton iteration
 * `Rₖ₊₁ = ½(Rₖ + Rₖ⁻ᵀ)`, which converges quadratically to the orthogonal polar factor. The rotation
 * factor `R` is the closest orthogonal matrix to `A` — exactly what co-rotational elasticity, shape
 * matching, and rigid (Kabsch) alignment need to extract rotation from a deformation.
 *
 * @throws {SingularMatrixError} if `A` is singular (the iteration requires `Rₖ⁻¹`).
 */
export function polarDecompose(A: Matrix, maxIterations = 30, tolerance = 1e-12): PolarDecomposition {
  if (A.rows !== A.cols) throw new RangeError("polar decomposition requires a square matrix");
  let R = A.clone();
  for (let iter = 0; iter < maxIterations; iter++) {
    const Rinv = inverse(R);
    const RinvT = Rinv.transpose();
    const next = new Matrix(R.rows, R.cols);
    const nd = next.data;
    const rd = R.data;
    const td = RinvT.data;
    let diff = 0;
    for (let i = 0; i < nd.length; i++) {
      const val = 0.5 * (rd[i]! + td[i]!);
      diff += (val - rd[i]!) * (val - rd[i]!);
      nd[i] = val;
    }
    R = next;
    if (Math.sqrt(diff) <= tolerance * (R.frobeniusNorm() || 1)) break;
  }
  const S = R.transpose().mul(A);
  return { R, S };
}
