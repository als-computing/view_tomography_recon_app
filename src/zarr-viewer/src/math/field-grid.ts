/**
 * Regular 3D grids of scalars and vectors. Use these when the domain is a **volume** (temperature,
 * attenuation μ, velocity, E/B) rather than a list of particles. Storage is structure-of-arrays
 * (`Float32Array` per component) so finite-difference sweeps and GPU uploads stay cache-friendly.
 *
 * Indexing is vertex-centered: cell `(i,j,k)` sits at
 * `origin + (i·dx, j·dy, k·dz)`. Sampling takes **world** coordinates and trilinear-interpolates.
 *
 * @packageDocumentation
 */

import { Vec3 } from "./vec3.js";

/** Spec for a uniform rectilinear grid. */
export interface Grid3Spec {
  /** Cell counts along x, y, z. */
  resolution: readonly [number, number, number];
  /** Cell size (m). Uniform by default; override per-axis with {@link cellSizeX} etc. */
  cellSize: number;
  /** Optional anisotropic cell sizes (m). */
  cellSizeX?: number;
  cellSizeY?: number;
  cellSizeZ?: number;
  /** World-space position of the `(0,0,0)` vertex. Defaults to the origin. */
  origin?: { x: number; y: number; z: number };
}

function resolveSpacing(spec: Grid3Spec): { dx: number; dy: number; dz: number } {
  return {
    dx: spec.cellSizeX ?? spec.cellSize,
    dy: spec.cellSizeY ?? spec.cellSize,
    dz: spec.cellSizeZ ?? spec.cellSize,
  };
}

/** Shared geometry helpers for scalar/vector grids. */
abstract class Grid3Base {
  public readonly nx: number;
  public readonly ny: number;
  public readonly nz: number;
  public readonly size: number;
  public readonly dx: number;
  public readonly dy: number;
  public readonly dz: number;
  public readonly originX: number;
  public readonly originY: number;
  public readonly originZ: number;

  protected constructor(spec: Grid3Spec) {
    const [nx, ny, nz] = spec.resolution;
    if (nx < 2 || ny < 2 || nz < 2) {
      throw new RangeError("Grid3 resolution must be at least 2×2×2 for finite differences");
    }
    this.nx = nx;
    this.ny = ny;
    this.nz = nz;
    this.size = nx * ny * nz;
    const s = resolveSpacing(spec);
    this.dx = s.dx;
    this.dy = s.dy;
    this.dz = s.dz;
    this.originX = spec.origin?.x ?? 0;
    this.originY = spec.origin?.y ?? 0;
    this.originZ = spec.origin?.z ?? 0;
  }

  /** Flat index `i + nx*(j + ny*k)`. */
  public index(i: number, j: number, k: number): number {
    return i + this.nx * (j + this.ny * k);
  }

  public inBounds(i: number, j: number, k: number): boolean {
    return i >= 0 && i < this.nx && j >= 0 && j < this.ny && k >= 0 && k < this.nz;
  }

  /** World position of vertex `(i,j,k)` into `out`. */
  public vertexPosition(out: Vec3, i: number, j: number, k: number): Vec3 {
    return out.set(
      this.originX + i * this.dx,
      this.originY + j * this.dy,
      this.originZ + k * this.dz,
    );
  }

  /** Convert world coordinates to continuous grid indices (may be out of range). */
  public worldToIndex(x: number, y: number, z: number): [number, number, number] {
    return [
      (x - this.originX) / this.dx,
      (y - this.originY) / this.dy,
      (z - this.originZ) / this.dz,
    ];
  }

  protected clampIndex(i: number, n: number): number {
    if (i < 0) return 0;
    if (i > n - 1) return n - 1;
    return i;
  }
}

/**
 * A scalar field on a regular 3D grid (temperature, density, attenuation μ, pressure, …).
 *
 * @example
 * ```ts
 * const mu = new ScalarGrid3({ resolution: [64, 64, 64], cellSize: 0.001 });
 * mu.set(32, 32, 32, 2.5);
 * const g = new Vec3();
 * mu.gradient(g, 32, 32, 32); // ∇μ at that vertex
 * ```
 */
export class ScalarGrid3 extends Grid3Base {
  /** Contiguous scalar samples, length `nx*ny*nz`. */
  public readonly values: Float32Array;

  public constructor(spec: Grid3Spec, values?: Float32Array) {
    super(spec);
    if (values && values.length !== this.size) {
      throw new RangeError(`ScalarGrid3 values length ${values.length} != ${this.size}`);
    }
    this.values = values ?? new Float32Array(this.size);
  }

  public get(i: number, j: number, k: number): number {
    return this.values[this.index(i, j, k)]!;
  }

  public set(i: number, j: number, k: number, value: number): void {
    this.values[this.index(i, j, k)] = value;
  }

  /** Trilinear sample at world `(x,y,z)`. Clamps to the grid bounds. */
  public sample(x: number, y: number, z: number): number {
    const [gx, gy, gz] = this.worldToIndex(x, y, z);
    const i0 = this.clampIndex(Math.floor(gx), this.nx);
    const j0 = this.clampIndex(Math.floor(gy), this.ny);
    const k0 = this.clampIndex(Math.floor(gz), this.nz);
    const i1 = this.clampIndex(i0 + 1, this.nx);
    const j1 = this.clampIndex(j0 + 1, this.ny);
    const k1 = this.clampIndex(k0 + 1, this.nz);
    const tx = gx - Math.floor(gx);
    const ty = gy - Math.floor(gy);
    const tz = gz - Math.floor(gz);
    const c000 = this.get(i0, j0, k0);
    const c100 = this.get(i1, j0, k0);
    const c010 = this.get(i0, j1, k0);
    const c110 = this.get(i1, j1, k0);
    const c001 = this.get(i0, j0, k1);
    const c101 = this.get(i1, j0, k1);
    const c011 = this.get(i0, j1, k1);
    const c111 = this.get(i1, j1, k1);
    const c00 = c000 * (1 - tx) + c100 * tx;
    const c10 = c010 * (1 - tx) + c110 * tx;
    const c01 = c001 * (1 - tx) + c101 * tx;
    const c11 = c011 * (1 - tx) + c111 * tx;
    const c0 = c00 * (1 - ty) + c10 * ty;
    const c1 = c01 * (1 - ty) + c11 * ty;
    return c0 * (1 - tz) + c1 * tz;
  }

  /**
   * Central-difference gradient \( \nabla \phi \) at vertex `(i,j,k)` into `out`.
   * Uses one-sided differences on boundaries.
   */
  public gradient(out: Vec3, i: number, j: number, k: number): Vec3 {
    const dx = this.dx;
    const dy = this.dy;
    const dz = this.dz;
    const gx =
      i === 0
        ? (this.get(i + 1, j, k) - this.get(i, j, k)) / dx
        : i === this.nx - 1
          ? (this.get(i, j, k) - this.get(i - 1, j, k)) / dx
          : (this.get(i + 1, j, k) - this.get(i - 1, j, k)) / (2 * dx);
    const gy =
      j === 0
        ? (this.get(i, j + 1, k) - this.get(i, j, k)) / dy
        : j === this.ny - 1
          ? (this.get(i, j, k) - this.get(i, j - 1, k)) / dy
          : (this.get(i, j + 1, k) - this.get(i, j - 1, k)) / (2 * dy);
    const gz =
      k === 0
        ? (this.get(i, j, k + 1) - this.get(i, j, k)) / dz
        : k === this.nz - 1
          ? (this.get(i, j, k) - this.get(i, j, k - 1)) / dz
          : (this.get(i, j, k + 1) - this.get(i, j, k - 1)) / (2 * dz);
    return out.set(gx, gy, gz);
  }

  /** Seven-point Laplacian \( \nabla^2 \phi \) at an interior vertex (0 on the boundary). */
  public laplacian(i: number, j: number, k: number): number {
    if (i === 0 || j === 0 || k === 0 || i === this.nx - 1 || j === this.ny - 1 || k === this.nz - 1) {
      return 0;
    }
    const c = this.get(i, j, k);
    const dxx = (this.get(i + 1, j, k) - 2 * c + this.get(i - 1, j, k)) / (this.dx * this.dx);
    const dyy = (this.get(i, j + 1, k) - 2 * c + this.get(i, j - 1, k)) / (this.dy * this.dy);
    const dzz = (this.get(i, j, k + 1) - 2 * c + this.get(i, j, k - 1)) / (this.dz * this.dz);
    return dxx + dyy + dzz;
  }

  /**
   * Approximate the line integral \( \int_\gamma \phi\,\mathrm{d}\ell \) by sampling `segments`
   * equal steps from `a` to `b` (for Beer–Lambert optical depth when φ = μ).
   */
  public lineIntegral(a: Vec3, b: Vec3, segments = 32): number {
    let sum = 0;
    const n = Math.max(1, segments);
    for (let s = 0; s < n; s++) {
      const t0 = s / n;
      const t1 = (s + 1) / n;
      const mx = a.x + (b.x - a.x) * (t0 + t1) * 0.5;
      const my = a.y + (b.y - a.y) * (t0 + t1) * 0.5;
      const mz = a.z + (b.z - a.z) * (t0 + t1) * 0.5;
      const dl = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z) / n;
      sum += this.sample(mx, my, mz) * dl;
    }
    return sum;
  }
}

/**
 * A vector field on a regular 3D grid, stored as three SoA planes (`x`, `y`, `z`). Prefer this over
 * an array of {@link Vec3} when \(N = n_x n_y n_z\) is large — divergence/curl sweeps read one
 * component at a time, and the buffers map straight to GPU storage.
 *
 * @example
 * ```ts
 * const vel = new VectorGrid3({ resolution: [32, 32, 32], cellSize: 0.1 });
 * // solid-body rotation ω = ẑ → v = (−y, x, 0) around origin
 * for (let k = 0; k < 32; k++) for (let j = 0; j < 32; j++) for (let i = 0; i < 32; i++) {
 *   const p = new Vec3();
 *   vel.vertexPosition(p, i, j, k);
 *   vel.set(i, j, k, -p.y, p.x, 0);
 * }
 * vel.curl(new Vec3(), 16, 16, 16); // ≈ (0, 0, 2)
 * ```
 */
export class VectorGrid3 extends Grid3Base {
  /** Contiguous X components. */
  public readonly x: Float32Array;
  /** Contiguous Y components. */
  public readonly y: Float32Array;
  /** Contiguous Z components. */
  public readonly z: Float32Array;

  public constructor(
    spec: Grid3Spec,
    components?: { x?: Float32Array; y?: Float32Array; z?: Float32Array },
  ) {
    super(spec);
    const n = this.size;
    if (components?.x && components.x.length !== n) throw new RangeError("VectorGrid3.x length mismatch");
    if (components?.y && components.y.length !== n) throw new RangeError("VectorGrid3.y length mismatch");
    if (components?.z && components.z.length !== n) throw new RangeError("VectorGrid3.z length mismatch");
    this.x = components?.x ?? new Float32Array(n);
    this.y = components?.y ?? new Float32Array(n);
    this.z = components?.z ?? new Float32Array(n);
  }

  public set(i: number, j: number, k: number, vx: number, vy: number, vz: number): void {
    const idx = this.index(i, j, k);
    this.x[idx] = vx;
    this.y[idx] = vy;
    this.z[idx] = vz;
  }

  /** Read the vector at a vertex into `out`. */
  public get(out: Vec3, i: number, j: number, k: number): Vec3 {
    const idx = this.index(i, j, k);
    return out.set(this.x[idx]!, this.y[idx]!, this.z[idx]!);
  }

  /** Trilinear sample at world `(x,y,z)` into `out`. */
  public sample(out: Vec3, x: number, y: number, z: number): Vec3 {
    const [gx, gy, gz] = this.worldToIndex(x, y, z);
    const i0 = this.clampIndex(Math.floor(gx), this.nx);
    const j0 = this.clampIndex(Math.floor(gy), this.ny);
    const k0 = this.clampIndex(Math.floor(gz), this.nz);
    const i1 = this.clampIndex(i0 + 1, this.nx);
    const j1 = this.clampIndex(j0 + 1, this.ny);
    const k1 = this.clampIndex(k0 + 1, this.nz);
    const tx = gx - Math.floor(gx);
    const ty = gy - Math.floor(gy);
    const tz = gz - Math.floor(gz);

    const lerp = (field: Float32Array): number => {
      const v = (ii: number, jj: number, kk: number) => field[this.index(ii, jj, kk)]!;
      const c00 = v(i0, j0, k0) * (1 - tx) + v(i1, j0, k0) * tx;
      const c10 = v(i0, j1, k0) * (1 - tx) + v(i1, j1, k0) * tx;
      const c01 = v(i0, j0, k1) * (1 - tx) + v(i1, j0, k1) * tx;
      const c11 = v(i0, j1, k1) * (1 - tx) + v(i1, j1, k1) * tx;
      const c0 = c00 * (1 - ty) + c10 * ty;
      const c1 = c01 * (1 - ty) + c11 * ty;
      return c0 * (1 - tz) + c1 * tz;
    };

    return out.set(lerp(this.x), lerp(this.y), lerp(this.z));
  }

  /**
   * Divergence \( \nabla\cdot\mathbf{F} \) at a vertex (central differences; one-sided on boundaries).
   * For incompressible flow, the pressure projection drives this toward zero.
   */
  public divergence(i: number, j: number, k: number): number {
    const dFx =
      i === 0
        ? (this.x[this.index(i + 1, j, k)]! - this.x[this.index(i, j, k)]!) / this.dx
        : i === this.nx - 1
          ? (this.x[this.index(i, j, k)]! - this.x[this.index(i - 1, j, k)]!) / this.dx
          : (this.x[this.index(i + 1, j, k)]! - this.x[this.index(i - 1, j, k)]!) / (2 * this.dx);
    const dFy =
      j === 0
        ? (this.y[this.index(i, j + 1, k)]! - this.y[this.index(i, j, k)]!) / this.dy
        : j === this.ny - 1
          ? (this.y[this.index(i, j, k)]! - this.y[this.index(i, j - 1, k)]!) / this.dy
          : (this.y[this.index(i, j + 1, k)]! - this.y[this.index(i, j - 1, k)]!) / (2 * this.dy);
    const dFz =
      k === 0
        ? (this.z[this.index(i, j, k + 1)]! - this.z[this.index(i, j, k)]!) / this.dz
        : k === this.nz - 1
          ? (this.z[this.index(i, j, k)]! - this.z[this.index(i, j, k - 1)]!) / this.dz
          : (this.z[this.index(i, j, k + 1)]! - this.z[this.index(i, j, k - 1)]!) / (2 * this.dz);
    return dFx + dFy + dFz;
  }

  /**
   * Curl \( \nabla\times\mathbf{F} \) at a vertex into `out`. Central differences interior;
   * one-sided on faces. Useful for magnetostatics checks and vorticity.
   */
  public curl(out: Vec3, i: number, j: number, k: number): Vec3 {
    const dFz_dy = this.#dComp(this.z, i, j, k, 1);
    const dFy_dz = this.#dComp(this.y, i, j, k, 2);
    const dFx_dz = this.#dComp(this.x, i, j, k, 2);
    const dFz_dx = this.#dComp(this.z, i, j, k, 0);
    const dFy_dx = this.#dComp(this.y, i, j, k, 0);
    const dFx_dy = this.#dComp(this.x, i, j, k, 1);
    return out.set(dFz_dy - dFy_dz, dFx_dz - dFz_dx, dFy_dx - dFx_dy);
  }

  /** Partial derivative of one component along axis 0/1/2. */
  #dComp(field: Float32Array, i: number, j: number, k: number, axis: 0 | 1 | 2): number {
    const n = axis === 0 ? this.nx : axis === 1 ? this.ny : this.nz;
    const h = axis === 0 ? this.dx : axis === 1 ? this.dy : this.dz;
    const at = (ii: number, jj: number, kk: number) => field[this.index(ii, jj, kk)]!;
    const c = axis === 0 ? i : axis === 1 ? j : k;
    if (c === 0) {
      const a = at(i, j, k);
      const b =
        axis === 0 ? at(i + 1, j, k) : axis === 1 ? at(i, j + 1, k) : at(i, j, k + 1);
      return (b - a) / h;
    }
    if (c === n - 1) {
      const a =
        axis === 0 ? at(i - 1, j, k) : axis === 1 ? at(i, j - 1, k) : at(i, j, k - 1);
      const b = at(i, j, k);
      return (b - a) / h;
    }
    const lo =
      axis === 0 ? at(i - 1, j, k) : axis === 1 ? at(i, j - 1, k) : at(i, j, k - 1);
    const hi =
      axis === 0 ? at(i + 1, j, k) : axis === 1 ? at(i, j + 1, k) : at(i, j, k + 1);
    return (hi - lo) / (2 * h);
  }

  /**
   * Polyline approximation of the circulation \( \int_\gamma \mathbf{F}\cdot\mathrm{d}\mathbf{l} \)
   * along the segments of `path` (world-space vertices).
   */
  public lineIntegralDot(path: readonly Vec3[]): number {
    if (path.length < 2) return 0;
    let sum = 0;
    const mid = new Vec3();
    const F = new Vec3();
    for (let s = 0; s < path.length - 1; s++) {
      const a = path[s]!;
      const b = path[s + 1]!;
      mid.set((a.x + b.x) * 0.5, (a.y + b.y) * 0.5, (a.z + b.z) * 0.5);
      this.sample(F, mid.x, mid.y, mid.z);
      sum += F.x * (b.x - a.x) + F.y * (b.y - a.y) + F.z * (b.z - a.z);
    }
    return sum;
  }
}
