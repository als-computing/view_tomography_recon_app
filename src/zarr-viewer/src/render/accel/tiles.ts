/**
 * Draw-indirect instanced tile compaction (Milestone 4.5).
 *
 * A compute prepass marks tiles whose frustum intersects the volume (and, when occupancy is
 * ready, whose UVW interval overlaps a TF-active cell), then compacts tile IDs into a buffer and
 * fills a DrawIndirect argument (`vertexCount=6`, `instanceCount=activeTileCount`). Empty tiles
 * launch zero waves — they're never instanced. The fragment pipeline, HDR target, and post stack
 * stay untouched.
 *
 * When TAAU jitter is later active, dilate the classified set by one tile before compaction
 * ({@link dilateTileFlags}) so a subpixel offset near a boundary still hits a quad.
 *
 * @packageDocumentation
 */

import type { Disposable } from "@zarr-viewer/core";
import { ManagedBuffer } from "../resources/buffer.js";
import { PipelineCache } from "../resources/pipeline.js";
import type { OccupancyGrid } from "./occupancy.js";

/** Screen-space tile size in pixels. */
export const TILE_SIZE = 16;

/** Bytes of one compacted tile instance (`packedXY, tMin, tMax, pad`). */
export const TILE_INST_STRIDE = 16;

/**
 * Dilate a `tilesX × tilesY` 0/1 flag grid by one tile in each direction (4-neighborhood plus
 * diagonals). Used once TAAU jitter can sample a pixel no instanced quad covered.
 */
export function dilateTileFlags(flags: Uint8Array, tilesX: number, tilesY: number): Uint8Array {
  const out = new Uint8Array(flags.length);
  for (let y = 0; y < tilesY; y++) {
    for (let x = 0; x < tilesX; x++) {
      let any = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          const yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= tilesX || yy >= tilesY) continue;
          any |= flags[yy * tilesX + xx]!;
        }
      }
      out[y * tilesX + x] = any ? 1 : 0;
    }
  }
  return out;
}

const CLASSIFY_WGSL = /* wgsl */ `
struct Cell { dmin: f32, dmax: f32, dist: f32, occupied: f32 }
struct TileInst { packedXY: u32, tMin: f32, tMax: f32, pad: f32 }
struct Frame {
  invViewProj: mat4x4<f32>,
  eye: vec4<f32>,
  params: vec4<f32>,
  light: vec4<f32>,
  shade: vec4<f32>,
  boxHalf: vec4<f32>,
}
struct TileParams {
  screen: vec4<f32>,     // xy = width/height in pixels
  tilesOcc: vec4<u32>,   // x = tilesX, y = tilesY, z = occEnable, w = bboxValid
  occGrid: vec4<u32>,    // xyz = occupancy grid
  bbox: vec4<f32>,       // volume AABB screen-space bounding box in pixels (minX, minY, maxX, maxY)
}

@group(0) @binding(0) var<uniform> frame: Frame;
@group(0) @binding(1) var<uniform> tp: TileParams;
@group(0) @binding(2) var<storage, read> occCells: array<Cell>;
@group(0) @binding(3) var<storage, read_write> compacted: array<TileInst>;
@group(0) @binding(4) var<storage, read_write> drawArgs: array<atomic<u32>>;

// Must match volume-raymarch.ts's own copy (both bind the same conceptual test) - see that file's
// comment for why the reciprocal needs an away-from-zero guard: an unguarded 1.0/rd on a near-axis-
// aligned ray component produces NaN whenever the matching numerator is also ~0, which here would
// wrongly cull an entire tile (never drawn at all) instead of just corrupting one ray.
fn intersectAabb(ro: vec3<f32>, rd: vec3<f32>, bmin: vec3<f32>, bmax: vec3<f32>) -> vec2<f32> {
  let EPS = 1e-6;
  let sign_ = select(vec3<f32>(1.0), vec3<f32>(-1.0), rd < vec3<f32>(0.0));
  let safeRd = select(rd, sign_ * EPS, abs(rd) < vec3<f32>(EPS));
  let inv = 1.0 / safeRd;
  let t0 = (bmin - ro) * inv;
  let t1 = (bmax - ro) * inv;
  let tmin = min(t0, t1);
  let tmax = max(t0, t1);
  let tNear = max(max(tmin.x, tmin.y), tmin.z);
  let tFar = min(min(tmax.x, tmax.y), tmax.z);
  return vec2<f32>(tNear, tFar);
}

fn rayForNdc(ndc: vec2<f32>) -> vec3<f32> {
  let nearH = frame.invViewProj * vec4<f32>(ndc, 0.0, 1.0);
  let farH = frame.invViewProj * vec4<f32>(ndc, 1.0, 1.0);
  let nearW = nearH.xyz / nearH.w;
  let farW = farH.xyz / farH.w;
  return normalize(farW - nearW);
}

fn occIndex(c: vec3<i32>) -> u32 {
  let g = vec3<i32>(tp.occGrid.xyz);
  let cc = clamp(c, vec3<i32>(0), g - vec3<i32>(1));
  return u32(cc.x + cc.y * g.x + cc.z * g.x * g.y);
}

@compute @workgroup_size(8, 8)
fn classify(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= tp.tilesOcc.x || id.y >= tp.tilesOcc.y) { return; }
  let tilePx = 16.0;
  let px0 = f32(id.x) * tilePx;
  let py0 = f32(id.y) * tilePx;
  let px1 = px0 + tilePx;
  let py1 = py0 + tilePx;
  // Keep any tile whose pixel rect overlaps the volume AABB's screen-space bounding box. This is robust
  // where the old 5-point ray test was not: a small / thin projection (zoomed out, or a slab seen
  // edge-on) can slip *between* the sampled points and get wrongly culled — tile-shaped holes at the
  // boundary that get worse the smaller the volume projects. bboxValid == 0 (camera inside / near the
  // volume, box can't be reliably bounded on screen) → keep all tiles that frame.
  if (tp.tilesOcc.w > 0u) {
    let bmin = tp.bbox.xy;
    let bmax = tp.bbox.zw;
    if (!(px0 < bmax.x && px1 > bmin.x && py0 < bmax.y && py1 > bmin.y)) { return; }
  }
  let slot = atomicAdd(&drawArgs[1], 1u);
  compacted[slot] = TileInst(id.x | (id.y << 16u), 0.0, 0.0, 0.0);
}
`;

/**
 * Compacts active screen tiles and produces a `drawIndirect` argument buffer.
 */
export class TileCompactor implements Disposable {
  private tilesX = 1;
  private tilesY = 1;
  private compact: ManagedBuffer;
  private drawArgs: ManagedBuffer;
  private tileParams: ManagedBuffer;
  private pipe: GPUComputePipeline | undefined;
  private layout: GPUBindGroupLayout | undefined;
  private readonly cache: PipelineCache;
  private capacity = 0;
  // Cached classify bind group + the input buffers it was built from, so it's rebuilt only when one of
  // them actually changes (resize → new compact buffer, or a new occupancy grid), not every frame.
  private bindGroup: GPUBindGroup | undefined;
  private bgFrame: GPUBuffer | undefined;
  private bgOcc: GPUBuffer | undefined;

  public constructor(private readonly device: GPUDevice) {
    this.cache = new PipelineCache(device);
    this.compact = new ManagedBuffer(
      device,
      GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      TILE_INST_STRIDE,
    );
    this.drawArgs = new ManagedBuffer(
      device,
      GPUBufferUsage.STORAGE | GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST,
      16,
    );
    this.tileParams = new ManagedBuffer(
      device,
      GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      64,
    );
    this.capacity = 1;
  }

  /** Dummy compacted-tile buffer for the baseline bind group. */
  public static dummyTiles(device: GPUDevice): ManagedBuffer {
    return new ManagedBuffer(device, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST, TILE_INST_STRIDE);
  }

  public get drawIndirectBuffer(): GPUBuffer {
    return this.drawArgs.gpu;
  }

  public get compactedBuffer(): GPUBuffer {
    return this.compact.gpu;
  }

  /**
   * Classify + compact for an internal render target of `width × height`. Call after occupancy
   * TF-dependent rebuild (if any) and after the volume frame uniform has been written.
   */
  public record(
    encoder: GPUCommandEncoder,
    frameUniform: GPUBuffer,
    occupancy: OccupancyGrid | undefined,
    dummyCells: GPUBuffer,
    width: number,
    height: number,
    /** Volume AABB screen bbox in pixels; `null` → camera can't bound it (keep every tile). */
    bbox: { minX: number; minY: number; maxX: number; maxY: number } | null,
  ): boolean {
    const tilesX = Math.max(1, Math.ceil(width / TILE_SIZE));
    const tilesY = Math.max(1, Math.ceil(height / TILE_SIZE));
    const need = tilesX * tilesY;
    let rebuilt = false;
    if (need > this.capacity || tilesX !== this.tilesX || tilesY !== this.tilesY) {
      this.compact.dispose();
      this.compact = new ManagedBuffer(
        this.device,
        GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        Math.max(need, 1) * TILE_INST_STRIDE,
      );
      this.capacity = Math.max(need, 1);
      this.tilesX = tilesX;
      this.tilesY = tilesY;
      rebuilt = true;
    }
    this.ensurePipe();
    // DrawIndirect: vertexCount=6, instanceCount=0 (atomicAdd'd), firstVertex=0, firstInstance=0.
    this.drawArgs.write(new Uint32Array([6, 0, 0, 0]));
    const occGrid = occupancy?.grid ?? [1, 1, 1];
    const raw = new ArrayBuffer(64);
    const f32 = new Float32Array(raw);
    const u32 = new Uint32Array(raw);
    f32[0] = width;
    f32[1] = height;
    u32[4] = tilesX;
    u32[5] = tilesY;
    u32[6] = occupancy?.ready ? 1 : 0;
    u32[7] = bbox ? 1 : 0; // bboxValid
    u32[8] = occGrid[0]!;
    u32[9] = occGrid[1]!;
    u32[10] = occGrid[2]!;
    // bbox (minX, minY, maxX, maxY) at float offset 12..15.
    f32[12] = bbox ? bbox.minX : 0;
    f32[13] = bbox ? bbox.minY : 0;
    f32[14] = bbox ? bbox.maxX : 0;
    f32[15] = bbox ? bbox.maxY : 0;
    this.tileParams.write(new Uint8Array(raw));

    const occBuf = occupancy?.cellsGpu ?? dummyCells;
    if (!this.bindGroup || rebuilt || this.bgFrame !== frameUniform || this.bgOcc !== occBuf) {
      this.bindGroup = this.device.createBindGroup({
        layout: this.layout!,
        entries: [
          { binding: 0, resource: { buffer: frameUniform } },
          { binding: 1, resource: { buffer: this.tileParams.gpu } },
          { binding: 2, resource: { buffer: occBuf } },
          { binding: 3, resource: { buffer: this.compact.gpu } },
          { binding: 4, resource: { buffer: this.drawArgs.gpu } },
        ],
      });
      this.bgFrame = frameUniform;
      this.bgOcc = occBuf;
    }
    const pass = encoder.beginComputePass({ label: "tile-classify" });
    pass.setPipeline(this.pipe!);
    pass.setBindGroup(0, this.bindGroup);
    pass.dispatchWorkgroups(Math.ceil(tilesX / 8), Math.ceil(tilesY / 8));
    pass.end();
    return rebuilt;
  }

  public dispose(): void {
    this.compact.dispose();
    this.drawArgs.dispose();
    this.tileParams.dispose();
  }

  private ensurePipe(): void {
    if (this.pipe) return;
    this.layout = this.device.createBindGroupLayout({
      label: "tile-classify",
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
        { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
        { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
      ],
    });
    const mod = this.cache.getModule("tile-classify", CLASSIFY_WGSL);
    this.pipe = this.cache.getComputePipeline({
      label: "tile-classify",
      layout: this.device.createPipelineLayout({ bindGroupLayouts: [this.layout] }),
      compute: { module: mod, entryPoint: "classify" },
    });
  }
}
