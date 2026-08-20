/**
 * Occupancy grid, TF-active range table, and Chebyshev distance field for empty-space skipping.
 *
 * Min/max density per macrocell is a volume-load-time GPU reduction. "Active" is defined by the
 * transfer function, so the distance field and active flags rebuild on every
 * {@link OccupancyGrid.rebuildForTransferFunction} — the third occurrence of this bug class in the
 * plan (TF-dependent spatial structure that must invalidate with `setTransferFunction`, not just
 * volume load).
 *
 * The GPU distance field is a Chebyshev (L∞) transform by iterative 3³-neighborhood dilation
 * (see {@link MAX_CHEBYSHEV_PASSES}), ping-ponged between two scratch buffers — it matches the CPU
 * reference {@link chebyshevDistanceField} used in unit tests. (An earlier version used separable +1
 * min-sweeps, which compute L1/Manhattan, not L∞ — unsafe for empty-space leaping.)
 *
 * @packageDocumentation
 */

import type { Disposable } from "@zarr-viewer/core";
import { ManagedBuffer } from "../resources/buffer.js";
import { PipelineCache } from "../resources/pipeline.js";
import type { ManagedTexture } from "../resources/texture.js";

/** Voxels along one axis of a macrocell. Shared with vis-bin sizing when convenient. */
export const MACROCELL_VOXELS = 8;

/** LUT alpha above this → the density bin is TF-active. */
export const TF_ACTIVE_EPS = 1e-4;

/** Sentinel distance for an empty grid (no active cells). */
export const CHEBYSHEV_INF = 1e6;

/** Per-cell record uploaded to the shader (`vec4`: min, max, dist, occupied). */
export const CELL_STRIDE_FLOATS = 4;

/**
 * Iterations of the Chebyshev dilation on each TF change = the max empty-space leap in macrocells.
 * Cells farther than this from active material clamp to it, so a large void takes a few leaps rather
 * than one. Bounds the per-TF-change cost (each pass is a full-grid 3³ compute dispatch).
 */
export const MAX_CHEBYSHEV_PASSES = 16;

/**
 * GPU / CPU layout of one occupancy cell. `active` and `dist` are TF-dependent; `dmin`/`dmax` are not.
 */
export interface OccupancyCell {
  dmin: number;
  dmax: number;
  /** Chebyshev distance to the nearest TF-active cell (0 = this cell is active). */
  dist: number;
  /** 1 if any TF LUT bin in `[dmin, dmax]` has opacity &gt; {@link TF_ACTIVE_EPS}. */
  active: number;
}

/** Inclusive `[lo, hi]` LUT-index range covering densities `[dmin, dmax]`. */
export function densityToLutRange(
  dmin: number,
  dmax: number,
  lutSize: number,
): [number, number] {
  const n = Math.max(2, lutSize);
  const lo = Math.min(n - 1, Math.max(0, Math.floor(Math.min(dmin, dmax) * (n - 1))));
  const hi = Math.min(n - 1, Math.max(0, Math.ceil(Math.max(dmin, dmax) * (n - 1))));
  return [lo, hi];
}

/**
 * Prefix-sum of TF-active LUT bins. `prefix[i]` = number of active bins in `[0, i)`. A density
 * range is active iff `prefix[hi+1] - prefix[lo] > 0`.
 */
export function tfActivePrefix(lut: Uint8Array, lutSize: number, eps = TF_ACTIVE_EPS): Uint32Array {
  const n = Math.max(2, lutSize);
  const prefix = new Uint32Array(n + 1);
  for (let i = 0; i < n; i++) {
    const a = (lut[i * 4 + 3] ?? 0) / 255;
    prefix[i + 1] = prefix[i]! + (a > eps ? 1 : 0);
  }
  return prefix;
}

/** True if any LUT bin in the density range is TF-active. */
export function tfRangeActive(
  prefix: Uint32Array,
  dmin: number,
  dmax: number,
  lutSize: number,
): boolean {
  const n = Math.max(2, lutSize);
  const [lo, hi] = densityToLutRange(dmin, dmax, n);
  return prefix[hi + 1]! > prefix[lo]!;
}

/**
 * Chebyshev (L∞) distance to the nearest `true` cell. Two raster-order passes with 26-connected
 * (3D) / 8-connected (2D) neighborhood — the chessboard metric. Empty grid → {@link CHEBYSHEV_INF}.
 *
 * The GPU occupancy pass computes the same metric by iterative 3³ dilation ({@link DILATE_WGSL}); the
 * shader leaps `dist` cells of empty space per step. This CPU function is the correctness reference for
 * "distance to nearest active" and for TF-invalidation tests.
 */
export function chebyshevDistanceField(
  active: Uint8Array | boolean[],
  grid: readonly [number, number, number],
): Float32Array {
  const [nx, ny, nz] = grid;
  const n = nx * ny * nz;
  const d = new Float32Array(n);
  for (let i = 0; i < n; i++) d[i] = active[i] ? 0 : CHEBYSHEV_INF;
  const idx = (x: number, y: number, z: number): number => x + y * nx + z * nx * ny;
  const relax = (x: number, y: number, z: number, ox: number, oy: number, oz: number): void => {
    const xx = x + ox;
    const yy = y + oy;
    const zz = z + oz;
    if (xx < 0 || yy < 0 || zz < 0 || xx >= nx || yy >= ny || zz >= nz) return;
    const i = idx(x, y, z);
    d[i] = Math.min(d[i]!, d[idx(xx, yy, zz)]! + 1);
  };

  for (let z = 0; z < nz; z++) {
    for (let y = 0; y < ny; y++) {
      for (let x = 0; x < nx; x++) {
        for (let oz = -1; oz <= 0; oz++) {
          for (let oy = -1; oy <= 1; oy++) {
            for (let ox = -1; ox <= 1; ox++) {
              if (oz === 0 && oy === 0 && ox === 0) continue;
              const seen = oz < 0 || (oz === 0 && oy < 0) || (oz === 0 && oy === 0 && ox < 0);
              if (seen) relax(x, y, z, ox, oy, oz);
            }
          }
        }
      }
    }
  }
  for (let z = nz - 1; z >= 0; z--) {
    for (let y = ny - 1; y >= 0; y--) {
      for (let x = nx - 1; x >= 0; x--) {
        for (let oz = 0; oz <= 1; oz++) {
          for (let oy = -1; oy <= 1; oy++) {
            for (let ox = -1; ox <= 1; ox++) {
              if (oz === 0 && oy === 0 && ox === 0) continue;
              const seen = oz > 0 || (oz === 0 && oy > 0) || (oz === 0 && oy === 0 && ox > 0);
              if (seen) relax(x, y, z, ox, oy, oz);
            }
          }
        }
      }
    }
  }
  return d;
}

/**
 * Iterative 3³-dilation Chebyshev distance transform — the exact CPU mirror of the GPU {@link DILATE_WGSL}
 * path (seed 0 on active cells / ∞ elsewhere, then `passes` relaxations of `min over 26-neighborhood + 1`,
 * each clamped to `cap`). With `passes ≥ cap ≥ maxDistance` it equals {@link chebyshevDistanceField}
 * clamped to `cap`; fewer passes clamp far cells to `cap` (the empty-space leap cap). Pure; unit-tested
 * against the raster-order reference so the shader's traversal is validated without a GPU.
 *
 * @param cap Distance ceiling (defaults to `passes`) — matches {@link MAX_CHEBYSHEV_PASSES} in the shader.
 */
export function dilateChebyshevField(
  active: Uint8Array | boolean[],
  grid: readonly [number, number, number],
  passes: number,
  cap: number = passes,
): Float32Array {
  const [nx, ny, nz] = grid;
  const n = nx * ny * nz;
  let cur = new Float32Array(n);
  for (let i = 0; i < n; i++) cur[i] = active[i] ? 0 : CHEBYSHEV_INF;
  let next = new Float32Array(n);
  const at = (x: number, y: number, z: number): number => x + y * nx + z * nx * ny;
  for (let p = 0; p < passes; p++) {
    for (let z = 0; z < nz; z++) {
      for (let y = 0; y < ny; y++) {
        for (let x = 0; x < nx; x++) {
          const i = at(x, y, z);
          let best = cur[i]!;
          for (let dz = -1; dz <= 1; dz++) {
            for (let dy = -1; dy <= 1; dy++) {
              for (let dx = -1; dx <= 1; dx++) {
                const xx = x + dx, yy = y + dy, zz = z + dz;
                if (xx < 0 || yy < 0 || zz < 0 || xx >= nx || yy >= ny || zz >= nz) continue;
                best = Math.min(best, cur[at(xx, yy, zz)]! + 1);
              }
            }
          }
          next[i] = Math.min(best, cap);
        }
      }
    }
    const tmp = cur;
    cur = next;
    next = tmp;
  }
  return cur;
}

/**
 * Intra-cell step cap so per-segment opacity stays in `[0.2, 0.3]` (Milestone 3.1 / 4.3 coupling).
 * `cellMaxSigma` is `cellMaxDensity * densityScale * sigmaMul`.
 */
export function majorantStepCap(
  cellMaxSigma: number,
  targetOpacity = 0.25,
): number {
  const t = Math.min(0.3, Math.max(0.2, targetOpacity));
  return -Math.log(1 - t) / Math.max(cellMaxSigma, 1e-4);
}

const REDUCE_WGSL = /* wgsl */ `
struct Cell { dmin: f32, dmax: f32, dist: f32, occupied: f32 }
struct Params { grid: vec3<u32>, cellSize: u32 }

@group(0) @binding(0) var volumeTex: texture_3d<f32>;
@group(0) @binding(1) var<storage, read_write> cells: array<Cell>;
@group(0) @binding(2) var<uniform> params: Params;

@compute @workgroup_size(4, 4, 4)
fn reduce_minmax(@builtin(global_invocation_id) id: vec3<u32>) {
  let g = params.grid;
  if (id.x >= g.x || id.y >= g.y || id.z >= g.z) { return; }
  let origin = vec3<i32>(id * params.cellSize);
  let dims = vec3<i32>(textureDimensions(volumeTex));
  let cs = i32(params.cellSize);
  var dmin = 1.0;
  var dmax = 0.0;
  var anyV = false;
  for (var z = 0; z < cs; z++) {
    for (var y = 0; y < cs; y++) {
      for (var x = 0; x < cs; x++) {
        let c = origin + vec3<i32>(x, y, z);
        if (any(c >= dims)) { continue; }
        let s = textureLoad(volumeTex, c, 0).r;
        dmin = min(dmin, s);
        dmax = max(dmax, s);
        anyV = true;
      }
    }
  }
  if (!anyV) { dmin = 0.0; dmax = 0.0; }
  let idx = id.x + id.y * g.x + id.z * g.x * g.y;
  cells[idx].dmin = dmin;
  cells[idx].dmax = dmax;
}
`;

const ACTIVATE_WGSL = /* wgsl */ `
struct Cell { dmin: f32, dmax: f32, dist: f32, occupied: f32 }
struct Params { grid: vec3<u32>, lutSize: u32 }

@group(0) @binding(0) var<storage, read_write> cells: array<Cell>;
@group(0) @binding(1) var<storage, read> prefix: array<u32>;
@group(0) @binding(2) var<uniform> params: Params;

@compute @workgroup_size(64)
fn mark_active(@builtin(global_invocation_id) gid: vec3<u32>) {
  let n = params.grid.x * params.grid.y * params.grid.z;
  if (gid.x >= n) { return; }
  let lutN = i32(params.lutSize);
  let c = cells[gid.x];
  let lo = clamp(i32(floor(min(c.dmin, c.dmax) * f32(lutN - 1))), 0, lutN - 1);
  let hi = clamp(i32(ceil(max(c.dmin, c.dmax) * f32(lutN - 1))), 0, lutN - 1);
  let tfOn = prefix[hi + 1] > prefix[lo];
  cells[gid.x].occupied = select(0.0, 1.0, tfOn);
  cells[gid.x].dist = select(1e6, 0.0, tfOn);
}
`;

// Chebyshev (L∞) distance transform by iterative 3³-neighborhood dilation. Each pass expands the
// distance front by one cell in the chessboard metric (a 3³ step = a Chebyshev ball of radius 1), so
// after N passes every empty cell within N of an active cell holds its exact Chebyshev distance; cells
// farther out clamp to N (a leap cap, which is fine — big voids just take a few leaps). This replaces
// the earlier separable +1 min-sweeps, which computed L1 (Manhattan): L1 ≥ Chebyshev, so leaping `dist`
// cells in the L∞ metric with an L1 value would jump PAST active cells and punch holes. Ping-ponged
// between two plain f32 scratch buffers so there is no read-write race within a pass.

const SEED_DIST_WGSL = /* wgsl */ `
struct Cell { dmin: f32, dmax: f32, dist: f32, occupied: f32 }
@group(0) @binding(0) var<storage, read> cells: array<Cell>;
@group(0) @binding(1) var<storage, read_write> distOut: array<f32>;

@compute @workgroup_size(64)
fn seed(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= arrayLength(&cells)) { return; }
  distOut[id.x] = select(1e6, 0.0, cells[id.x].occupied > 0.5);
}
`;

const DILATE_WGSL = /* wgsl */ `
struct Params { grid: vec3<u32>, cap: f32 }
@group(0) @binding(0) var<storage, read> srcDist: array<f32>;
@group(0) @binding(1) var<storage, read_write> dstDist: array<f32>;
@group(0) @binding(2) var<uniform> params: Params;

@compute @workgroup_size(64)
fn dilate(@builtin(global_invocation_id) id: vec3<u32>) {
  let g = vec3<i32>(params.grid);
  let n = u32(g.x * g.y * g.z);
  if (id.x >= n) { return; }
  let i = i32(id.x);
  let z = i / (g.x * g.y);
  let y = (i - z * g.x * g.y) / g.x;
  let x = i - z * g.x * g.y - y * g.x;
  var best = srcDist[id.x];
  for (var dz = -1; dz <= 1; dz++) {
    for (var dy = -1; dy <= 1; dy++) {
      for (var dx = -1; dx <= 1; dx++) {
        let xx = x + dx; let yy = y + dy; let zz = z + dz;
        if (xx < 0 || yy < 0 || zz < 0 || xx >= g.x || yy >= g.y || zz >= g.z) { continue; }
        best = min(best, srcDist[u32(xx + yy * g.x + zz * g.x * g.y)] + 1.0);
      }
    }
  }
  dstDist[id.x] = min(best, params.cap);
}
`;

const WRITEBACK_DIST_WGSL = /* wgsl */ `
struct Cell { dmin: f32, dmax: f32, dist: f32, occupied: f32 }
@group(0) @binding(0) var<storage, read_write> cells: array<Cell>;
@group(0) @binding(1) var<storage, read> distIn: array<f32>;

@compute @workgroup_size(64)
fn writeback(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= arrayLength(&cells)) { return; }
  cells[id.x].dist = distIn[id.x];
}
`;

function u32params(values: number[]): Uint32Array {
  const a = new Uint32Array(4);
  for (let i = 0; i < values.length && i < 4; i++) a[i] = values[i]!;
  return a;
}

/**
 * GPU occupancy structure. Call {@link rebuildMinMax} when the volume texture changes, and
 * {@link rebuildForTransferFunction} on every `setTransferFunction` (TF-dependent activity).
 */
export class OccupancyGrid implements Disposable {
  readonly grid: [number, number, number];
  readonly cellCount: number;
  readonly cellBuffer: ManagedBuffer;
  private prefixBuffer: ManagedBuffer | undefined;
  private readonly reduceParams: ManagedBuffer;
  private readonly activateParams: ManagedBuffer;
  private readonly dilateParams: ManagedBuffer;
  // Ping-pong scratch for the Chebyshev dilation (plain f32 per cell); avoids a read-write race.
  private readonly distA: ManagedBuffer;
  private readonly distB: ManagedBuffer;
  private readonly cache: PipelineCache;
  private reducePipe: GPUComputePipeline | undefined;
  private activatePipe: GPUComputePipeline | undefined;
  private seedPipe: GPUComputePipeline | undefined;
  private dilatePipe: GPUComputePipeline | undefined;
  private writebackPipe: GPUComputePipeline | undefined;
  private reduceLayout: GPUBindGroupLayout | undefined;
  private activateLayout: GPUBindGroupLayout | undefined;
  private seedLayout: GPUBindGroupLayout | undefined;
  private dilateLayout: GPUBindGroupLayout | undefined;
  private writebackLayout: GPUBindGroupLayout | undefined;
  private lutSize = 512;
  private built = false;

  public constructor(
    private readonly device: GPUDevice,
    volumeSize: readonly [number, number, number],
    public readonly cellSize = MACROCELL_VOXELS,
  ) {
    this.grid = [
      Math.max(1, Math.ceil(volumeSize[0] / cellSize)),
      Math.max(1, Math.ceil(volumeSize[1] / cellSize)),
      Math.max(1, Math.ceil(volumeSize[2] / cellSize)),
    ];
    this.cellCount = this.grid[0] * this.grid[1] * this.grid[2];
    this.cellBuffer = new ManagedBuffer(
      device,
      GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
      this.cellCount * CELL_STRIDE_FLOATS * 4,
    );
    this.reduceParams = new ManagedBuffer(
      device,
      GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      16,
    );
    this.activateParams = new ManagedBuffer(
      device,
      GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      16,
    );
    this.dilateParams = new ManagedBuffer(
      device,
      GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      16,
    );
    const distBytes = this.cellCount * 4;
    this.distA = new ManagedBuffer(device, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST, distBytes);
    this.distB = new ManagedBuffer(device, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST, distBytes);
    this.cache = new PipelineCache(device);
  }

  public get ready(): boolean {
    return this.built;
  }

  /** Dummy 1-cell buffer for the baseline shader bind group (occupancy compiled out). */
  public static dummy(device: GPUDevice): ManagedBuffer {
    return new ManagedBuffer(device, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST, 16);
  }

  public static dummyPrefix(device: GPUDevice): ManagedBuffer {
    return new ManagedBuffer(device, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST, 8);
  }

  /** Reduce min/max density per macrocell from `volume`. Does not touch TF-dependent fields. */
  public rebuildMinMax(encoder: GPUCommandEncoder, volume: ManagedTexture): void {
    this.ensurePipes();
    this.reduceParams.write(u32params([this.grid[0], this.grid[1], this.grid[2], this.cellSize]));
    const bg = this.device.createBindGroup({
      layout: this.reduceLayout!,
      entries: [
        { binding: 0, resource: volume.createView({ dimension: "3d" }) },
        { binding: 1, resource: { buffer: this.cellBuffer.gpu } },
        { binding: 2, resource: { buffer: this.reduceParams.gpu } },
      ],
    });
    const pass = encoder.beginComputePass({ label: "occupancy-minmax" });
    pass.setPipeline(this.reducePipe!);
    pass.setBindGroup(0, bg);
    pass.dispatchWorkgroups(
      Math.ceil(this.grid[0] / 4),
      Math.ceil(this.grid[1] / 4),
      Math.ceil(this.grid[2] / 4),
    );
    pass.end();
    this.built = true;
  }

  /**
   * Rebuild the TF-active table and Chebyshev field. Must run after min/max exists and on every
   * transfer-function change.
   */
  public rebuildForTransferFunction(
    encoder: GPUCommandEncoder,
    lut: Uint8Array,
    lutSize: number,
  ): void {
    this.ensurePipes();
    this.lutSize = lutSize;
    const prefix = tfActivePrefix(lut, lutSize);
    this.prefixBuffer?.dispose();
    this.prefixBuffer = ManagedBuffer.fromData(
      this.device,
      GPUBufferUsage.STORAGE,
      prefix,
    );
    this.activateParams.write(u32params([this.grid[0], this.grid[1], this.grid[2], lutSize]));
    const actBg = this.device.createBindGroup({
      layout: this.activateLayout!,
      entries: [
        { binding: 0, resource: { buffer: this.cellBuffer.gpu } },
        { binding: 1, resource: { buffer: this.prefixBuffer.gpu } },
        { binding: 2, resource: { buffer: this.activateParams.gpu } },
      ],
    });
    {
      const pass = encoder.beginComputePass({ label: "occupancy-tf-active" });
      pass.setPipeline(this.activatePipe!);
      pass.setBindGroup(0, actBg);
      pass.dispatchWorkgroups(Math.ceil(this.cellCount / 64));
      pass.end();
    }
    // Chebyshev distance field: seed from `occupied`, then dilate (3³ min+1) ping-ponging distA<->distB
    // MAX_CHEBYSHEV_PASSES times, then write the result back into cells[].dist.
    const wgCount = Math.ceil(this.cellCount / 64);
    {
      const seedBg = this.device.createBindGroup({
        layout: this.seedLayout!,
        entries: [
          { binding: 0, resource: { buffer: this.cellBuffer.gpu } },
          { binding: 1, resource: { buffer: this.distA.gpu } },
        ],
      });
      const pass = encoder.beginComputePass({ label: "occupancy-dist-seed" });
      pass.setPipeline(this.seedPipe!);
      pass.setBindGroup(0, seedBg);
      pass.dispatchWorkgroups(wgCount);
      pass.end();
    }
    const dilateRaw = new ArrayBuffer(16);
    new Uint32Array(dilateRaw, 0, 3).set([this.grid[0], this.grid[1], this.grid[2]]);
    new Float32Array(dilateRaw, 12, 1)[0] = MAX_CHEBYSHEV_PASSES;
    this.dilateParams.write(new Uint8Array(dilateRaw));
    let src = this.distA;
    let dst = this.distB;
    for (let p = 0; p < MAX_CHEBYSHEV_PASSES; p++) {
      const bg = this.device.createBindGroup({
        layout: this.dilateLayout!,
        entries: [
          { binding: 0, resource: { buffer: src.gpu } },
          { binding: 1, resource: { buffer: dst.gpu } },
          { binding: 2, resource: { buffer: this.dilateParams.gpu } },
        ],
      });
      const pass = encoder.beginComputePass({ label: `occupancy-dist-dilate-${p}` });
      pass.setPipeline(this.dilatePipe!);
      pass.setBindGroup(0, bg);
      pass.dispatchWorkgroups(wgCount);
      pass.end();
      const tmp = src;
      src = dst;
      dst = tmp;
    }
    {
      // After the loop, `src` holds the final distances.
      const wbBg = this.device.createBindGroup({
        layout: this.writebackLayout!,
        entries: [
          { binding: 0, resource: { buffer: this.cellBuffer.gpu } },
          { binding: 1, resource: { buffer: src.gpu } },
        ],
      });
      const pass = encoder.beginComputePass({ label: "occupancy-dist-writeback" });
      pass.setPipeline(this.writebackPipe!);
      pass.setBindGroup(0, wbBg);
      pass.dispatchWorkgroups(wgCount);
      pass.end();
    }
  }

  /** Storage buffer of `Cell` records for the ray-march bind group. */
  public get cellsGpu(): GPUBuffer {
    return this.cellBuffer.gpu;
  }

  public get prefixGpu(): GPUBuffer | undefined {
    return this.prefixBuffer?.gpu;
  }

  public dispose(): void {
    this.cellBuffer.dispose();
    this.prefixBuffer?.dispose();
    this.reduceParams.dispose();
    this.activateParams.dispose();
    this.dilateParams.dispose();
    this.distA.dispose();
    this.distB.dispose();
  }

  private ensurePipes(): void {
    if (this.reducePipe) return;
    this.reduceLayout = this.device.createBindGroupLayout({
      label: "occ-reduce",
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "float", viewDimension: "3d" } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
      ],
    });
    this.activateLayout = this.device.createBindGroupLayout({
      label: "occ-activate",
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
      ],
    });
    // seed (cells → distOut) and writeback (distIn → cells) share the same two-storage-buffer shape.
    this.seedLayout = this.device.createBindGroupLayout({
      label: "occ-dist-seed",
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
      ],
    });
    this.writebackLayout = this.device.createBindGroupLayout({
      label: "occ-dist-writeback",
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
      ],
    });
    this.dilateLayout = this.device.createBindGroupLayout({
      label: "occ-dist-dilate",
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
      ],
    });
    const reduceMod = this.cache.getModule("occ-reduce", REDUCE_WGSL);
    const actMod = this.cache.getModule("occ-activate", ACTIVATE_WGSL);
    const seedMod = this.cache.getModule("occ-dist-seed", SEED_DIST_WGSL);
    const dilateMod = this.cache.getModule("occ-dist-dilate", DILATE_WGSL);
    const writebackMod = this.cache.getModule("occ-dist-writeback", WRITEBACK_DIST_WGSL);
    this.reducePipe = this.cache.getComputePipeline({
      label: "occ-reduce",
      layout: this.device.createPipelineLayout({ bindGroupLayouts: [this.reduceLayout] }),
      compute: { module: reduceMod, entryPoint: "reduce_minmax" },
    });
    this.activatePipe = this.cache.getComputePipeline({
      label: "occ-activate",
      layout: this.device.createPipelineLayout({ bindGroupLayouts: [this.activateLayout] }),
      compute: { module: actMod, entryPoint: "mark_active" },
    });
    this.seedPipe = this.cache.getComputePipeline({
      label: "occ-dist-seed",
      layout: this.device.createPipelineLayout({ bindGroupLayouts: [this.seedLayout] }),
      compute: { module: seedMod, entryPoint: "seed" },
    });
    this.dilatePipe = this.cache.getComputePipeline({
      label: "occ-dist-dilate",
      layout: this.device.createPipelineLayout({ bindGroupLayouts: [this.dilateLayout] }),
      compute: { module: dilateMod, entryPoint: "dilate" },
    });
    this.writebackPipe = this.cache.getComputePipeline({
      label: "occ-dist-writeback",
      layout: this.device.createPipelineLayout({ bindGroupLayouts: [this.writebackLayout] }),
      compute: { module: writebackMod, entryPoint: "writeback" },
    });
  }
}
