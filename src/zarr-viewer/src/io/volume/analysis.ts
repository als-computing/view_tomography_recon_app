/**
 * Volume analysis: threshold metrics, isosurface extraction, and ray pick → connected-component
 * feature selection with physical volume (SI spacing).
 *
 * @packageDocumentation
 */

import { units } from "@zarr-viewer/core";
import type { GeometryData } from "./geometry-types.js";
import type { VolumeSource } from "./volume-source.js";

/** Dense scalar field in x-fastest order with physical spacing. */
export interface DensityField {
  dimensions: readonly [number, number, number];
  /** Voxel spacing in meters (x, y, z). */
  spacingSi: readonly [number, number, number];
  data: Float32Array;
  valueRange: readonly [number, number];
}

export interface LoadDensityFieldOptions {
  level?: number;
  cropMin?: readonly [number, number, number];
  cropMax?: readonly [number, number, number];
}

export interface ThresholdVolumeResult {
  voxelCount: number;
  /** Physical volume (m³). */
  volume: units.Quantity;
  meanDensity: number;
  /** Centroid in world meters (volume centered at origin, same as DVR). */
  centroidSi: readonly [number, number, number];
}

export interface MeasureThresholdOptions {
  /** Threshold in data units (`VolumeSource.valueRange`). */
  threshold: number;
  cropMin?: readonly [number, number, number];
  cropMax?: readonly [number, number, number];
}

export interface ExtractIsosurfaceOptions {
  /** Isovalue / threshold in data units. */
  isoValue: number;
  /** World meters centered at origin (default true). */
  worldMeters?: boolean;
}

/**
 * Assemble a dense float32 field at `level` (respecting crop). Values stay in data units.
 */
export async function loadDensityField(
  source: VolumeSource,
  options: LoadDensityFieldOptions = {},
): Promise<DensityField> {
  const level = options.level ?? 0;
  const [dx, dy, dz] = source.dimensionsAt(level);
  const spacing = source.spacingAt(level);
  const c0 = options.cropMin ?? [0, 0, 0];
  const c1 = options.cropMax ?? [1, 1, 1];
  const x0 = Math.max(0, Math.floor(c0[0]! * dx));
  const y0 = Math.max(0, Math.floor(c0[1]! * dy));
  const z0 = Math.max(0, Math.floor(c0[2]! * dz));
  const x1 = Math.min(dx, Math.ceil(c1[0]! * dx));
  const y1 = Math.min(dy, Math.ceil(c1[1]! * dy));
  const z1 = Math.min(dz, Math.ceil(c1[2]! * dz));
  const sx = Math.max(1, x1 - x0);
  const sy = Math.max(1, y1 - y0);
  const sz = Math.max(1, z1 - z0);
  const data = new Float32Array(sx * sy * sz);

  for await (const chunk of source.chunks(level)) {
    const [ox, oy, oz] = chunk.origin;
    const [cx, cy, cz] = chunk.shape;
    const view = chunk.data as unknown as ArrayLike<number>;
    for (let z = 0; z < cz; z++) {
      const gz = oz + z;
      if (gz < z0 || gz >= z1) continue;
      for (let y = 0; y < cy; y++) {
        const gy = oy + y;
        if (gy < y0 || gy >= y1) continue;
        for (let x = 0; x < cx; x++) {
          const gx = ox + x;
          if (gx < x0 || gx >= x1) continue;
          const src = x + y * cx + z * cx * cy;
          const dst = gx - x0 + (gy - y0) * sx + (gz - z0) * sx * sy;
          data[dst] = Number(view[src]);
        }
      }
    }
  }

  return {
    dimensions: [sx, sy, sz],
    spacingSi: spacing,
    data,
    valueRange: source.valueRange,
  };
}

/** Count voxels ≥ threshold; physical volume `n · sx · sy · sz` (m³). */
export function measureThresholdVolume(
  field: DensityField,
  options: MeasureThresholdOptions,
): ThresholdVolumeResult {
  const thr = options.threshold;
  const [dx, dy, dz] = field.dimensions;
  const [sx, sy, sz] = field.spacingSi;
  const c0 = options.cropMin ?? [0, 0, 0];
  const c1 = options.cropMax ?? [1, 1, 1];
  const x0 = Math.max(0, Math.floor(c0[0]! * dx));
  const y0 = Math.max(0, Math.floor(c0[1]! * dy));
  const z0 = Math.max(0, Math.floor(c0[2]! * dz));
  const x1 = Math.min(dx, Math.ceil(c1[0]! * dx));
  const y1 = Math.min(dy, Math.ceil(c1[1]! * dy));
  const z1 = Math.min(dz, Math.ceil(c1[2]! * dz));

  let count = 0;
  let sum = 0;
  let cx = 0;
  let cy = 0;
  let cz = 0;
  for (let z = z0; z < z1; z++) {
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const v = field.data[x + y * dx + z * dx * dy]!;
        if (v < thr) continue;
        count++;
        sum += v;
        cx += x;
        cy += y;
        cz += z;
      }
    }
  }

  const volumeSi = count * sx * sy * sz;
  const halfX = dx * sx * 0.5;
  const halfY = dy * sy * 0.5;
  const halfZ = dz * sz * 0.5;
  const centroidSi: [number, number, number] =
    count === 0
      ? [0, 0, 0]
      : [
          (cx / count + 0.5) * sx - halfX,
          (cy / count + 0.5) * sy - halfY,
          (cz / count + 0.5) * sz - halfZ,
        ];

  return {
    voxelCount: count,
    volume: new units.Quantity(volumeSi, units.VOLUME),
    meanDensity: count === 0 ? 0 : sum / count,
    centroidSi,
  };
}

function inside(field: DensityField, x: number, y: number, z: number, iso: number): boolean {
  const [dx, dy, dz] = field.dimensions;
  if (x < 0 || y < 0 || z < 0 || x >= dx || y >= dy || z >= dz) return false;
  return field.data[x + y * dx + z * dx * dy]! >= iso;
}

/**
 * Extract an isosurface-like mesh as exposed faces of the thresholded region (blocky but exact
 * for voxel volumes). Positions are centered world meters by default.
 */
export function extractIsosurface(
  field: DensityField,
  options: ExtractIsosurfaceOptions,
): GeometryData {
  const iso = options.isoValue;
  const world = options.worldMeters !== false;
  const [dx, dy, dz] = field.dimensions;
  const [sx, sy, sz] = field.spacingSi;
  const halfX = dx * sx * 0.5;
  const halfY = dy * sy * 0.5;
  const halfZ = dz * sz * 0.5;
  const positions: number[] = [];
  const indices: number[] = [];

  const pushQuad = (
    a: readonly [number, number, number],
    b: readonly [number, number, number],
    c: readonly [number, number, number],
    d: readonly [number, number, number],
  ): void => {
    const base = positions.length / 3;
    for (const p of [a, b, c, d]) positions.push(p[0], p[1], p[2]);
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  };

  const corner = (x: number, y: number, z: number): [number, number, number] => {
    if (!world) return [x, y, z];
    return [x * sx - halfX, y * sy - halfY, z * sz - halfZ];
  };

  // Faces: -X +X -Y +Y -Z +Z
  const neigh: Array<[number, number, number]> = [
    [-1, 0, 0],
    [1, 0, 0],
    [0, -1, 0],
    [0, 1, 0],
    [0, 0, -1],
    [0, 0, 1],
  ];

  for (let z = 0; z < dz; z++) {
    for (let y = 0; y < dy; y++) {
      for (let x = 0; x < dx; x++) {
        if (!inside(field, x, y, z, iso)) continue;
        for (let f = 0; f < 6; f++) {
          const [nx, ny, nz] = neigh[f]!;
          if (inside(field, x + nx, y + ny, z + nz, iso)) continue;
          // Emit face on the outside of voxel [x,y,z]
          if (f === 0) {
            // -X
            pushQuad(
              corner(x, y, z),
              corner(x, y, z + 1),
              corner(x, y + 1, z + 1),
              corner(x, y + 1, z),
            );
          } else if (f === 1) {
            pushQuad(
              corner(x + 1, y, z),
              corner(x + 1, y + 1, z),
              corner(x + 1, y + 1, z + 1),
              corner(x + 1, y, z + 1),
            );
          } else if (f === 2) {
            pushQuad(
              corner(x, y, z),
              corner(x + 1, y, z),
              corner(x + 1, y, z + 1),
              corner(x, y, z + 1),
            );
          } else if (f === 3) {
            pushQuad(
              corner(x, y + 1, z),
              corner(x, y + 1, z + 1),
              corner(x + 1, y + 1, z + 1),
              corner(x + 1, y + 1, z),
            );
          } else if (f === 4) {
            pushQuad(
              corner(x, y, z),
              corner(x, y + 1, z),
              corner(x + 1, y + 1, z),
              corner(x + 1, y, z),
            );
          } else {
            pushQuad(
              corner(x, y, z + 1),
              corner(x + 1, y, z + 1),
              corner(x + 1, y + 1, z + 1),
              corner(x, y + 1, z + 1),
            );
          }
        }
      }
    }
  }

  return {
    positions: new Float32Array(positions),
    indices: new Uint32Array(indices),
  };
}

/** Surface area (m²) of a triangle mesh in world meters. */
export function meshSurfaceAreaSi(mesh: GeometryData): units.Quantity {
  const p = mesh.positions;
  const idx = mesh.indices;
  let area = 0;
  if (idx) {
    for (let i = 0; i + 2 < idx.length; i += 3) {
      const a = idx[i]! * 3;
      const b = idx[i + 1]! * 3;
      const c = idx[i + 2]! * 3;
      const ax = p[b]! - p[a]!;
      const ay = p[b + 1]! - p[a + 1]!;
      const az = p[b + 2]! - p[a + 2]!;
      const bx = p[c]! - p[a]!;
      const by = p[c + 1]! - p[a + 1]!;
      const bz = p[c + 2]! - p[a + 2]!;
      area += 0.5 * Math.hypot(ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx);
    }
  }
  return new units.Quantity(area, units.AREA);
}

export interface VolumePickRay {
  /** Ray origin in the same world/sim space as {@link PickConnectedFeatureOptions.boxHalf}. */
  origin: readonly [number, number, number];
  /** Unit direction. */
  direction: readonly [number, number, number];
}

export interface PickConnectedFeatureOptions {
  level: number;
  ray: VolumePickRay;
  /** AABB half-extents of the volume (centered at origin), same space as the ray. */
  boxHalf: readonly [number, number, number];
  /**
   * First hit along the ray when `density >= hitDensity` (data units).
   * Default: mid of `valueRange` (or 0.5 if range spans negatives awkwardly).
   */
  hitDensity?: number;
  /**
   * Connected voxels must satisfy `density >= seed * relativeLow` when seed > 0, else
   * `density <= seed * relativeLow` when seed < 0. Default `0.55`.
   */
  relativeLow?: number;
  /** Cap flood-fill size (default 2e6). */
  maxRegionVoxels?: number;
  /** Optional UVW crop [0,1] (same as DVR crop). */
  cropMin?: readonly [number, number, number];
  cropMax?: readonly [number, number, number];
}

export interface PickedFeature {
  seedVoxel: readonly [number, number, number];
  seedDensity: number;
  threshold: number;
  voxelCount: number;
  volume: units.Quantity;
  meanDensity: number;
  centroidSi: readonly [number, number, number];
  /** Tight UVW bounds of the component (for crop highlight), padded slightly. */
  cropMin: readonly [number, number, number];
  cropMax: readonly [number, number, number];
}

function aabbRaySlab(
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  minX: number,
  minY: number,
  minZ: number,
  maxX: number,
  maxY: number,
  maxZ: number,
): [number, number] | null {
  let tmin = -Infinity;
  let tmax = Infinity;
  const axes: Array<[number, number, number, number]> = [
    [ox, dx, minX, maxX],
    [oy, dy, minY, maxY],
    [oz, dz, minZ, maxZ],
  ];
  for (const [o, d, mn, mx] of axes) {
    if (Math.abs(d) < 1e-12) {
      if (o < mn || o > mx) return null;
      continue;
    }
    let t1 = (mn - o) / d;
    let t2 = (mx - o) / d;
    if (t1 > t2) {
      const tmp = t1;
      t1 = t2;
      t2 = tmp;
    }
    if (t1 > tmin) tmin = t1;
    if (t2 < tmax) tmax = t2;
    if (tmax < tmin) return null;
  }
  return [tmin, tmax];
}

/** Chunk-cached scalar sampler (x-fastest volume indices). */
class VolumeSampler {
  private readonly cache = new Map<string, Float32Array>();

  public constructor(
    private readonly source: VolumeSource,
    private readonly level: number,
    private readonly dims: readonly [number, number, number],
  ) {}

  public async sample(x: number, y: number, z: number): Promise<number> {
    const [dx, dy, dz] = this.dims;
    if (x < 0 || y < 0 || z < 0 || x >= dx || y >= dy || z >= dz) return Number.NaN;
    const chunk = await this.source.readChunk(this.level, x, y, z);
    const [ox, oy, oz] = chunk.origin;
    const [cx, cy, cz] = chunk.shape;
    const lx = x - ox;
    const ly = y - oy;
    const lz = z - oz;
    if (lx < 0 || ly < 0 || lz < 0 || lx >= cx || ly >= cy || lz >= cz) return Number.NaN;
    const key = `${ox},${oy},${oz}`;
    let dense = this.cache.get(key);
    if (!dense) {
      const view = chunk.data as unknown as ArrayLike<number>;
      dense = new Float32Array(cx * cy * cz);
      for (let i = 0; i < dense.length; i++) dense[i] = Number(view[i]);
      this.cache.set(key, dense);
    }
    return dense[lx + ly * cx + lz * cx * cy]!;
  }
}

/**
 * Cast a ray through a volume level, hit the first dense sample, grow a 6-connected component,
 * and return physical volume (SI) plus a UVW crop around the feature.
 */
export async function pickConnectedFeature(
  source: VolumeSource,
  options: PickConnectedFeatureOptions,
): Promise<PickedFeature | null> {
  const level = options.level;
  const [dx, dy, dz] = source.dimensionsAt(level);
  const [sx, sy, sz] = source.spacingAt(level);
  const [hx, hy, hz] = options.boxHalf;
  const [ox, oy, oz] = options.ray.origin;
  let [rdx, rdy, rdz] = options.ray.direction;
  const rlen = Math.hypot(rdx, rdy, rdz) || 1;
  rdx /= rlen;
  rdy /= rlen;
  rdz /= rlen;

  const hit = aabbRaySlab(ox, oy, oz, rdx, rdy, rdz, -hx, -hy, -hz, hx, hy, hz);
  if (!hit) return null;
  let [t0, t1] = hit;
  if (t1 < 0) return null;
  t0 = Math.max(t0, 0);

  const [vr0, vr1] = source.valueRange;
  const defaultHit =
    options.hitDensity ??
    (vr0 < 0 && vr1 > 0 ? Math.max(vr1 * 0.2, 1e-3) : vr0 + (vr1 - vr0) * 0.55);
  const hitDensity = defaultHit;
  const rel = options.relativeLow ?? 0.55;
  const maxRegion = options.maxRegionVoxels ?? 2_000_000;
  const c0 = options.cropMin ?? [0, 0, 0];
  const c1 = options.cropMax ?? [1, 1, 1];

  const sampler = new VolumeSampler(source, level, [dx, dy, dz]);
  const step = Math.min(hx, hy, hz) * 2 / Math.max(dx, dy, dz, 1);
  const maxSteps = Math.ceil((t1 - t0) / Math.max(step, 1e-6)) + 2;

  let seed: [number, number, number] | null = null;
  let seedDensity = 0;
  for (let i = 0; i < maxSteps; i++) {
    const t = t0 + (i + 0.5) * step;
    if (t > t1) break;
    const wx = ox + rdx * t;
    const wy = oy + rdy * t;
    const wz = oz + rdz * t;
    const u = (wx + hx) / (2 * hx);
    const v = (wy + hy) / (2 * hy);
    const w = (wz + hz) / (2 * hz);
    if (u < c0[0]! || v < c0[1]! || w < c0[2]! || u > c1[0]! || v > c1[1]! || w > c1[2]!) {
      continue;
    }
    const ix = Math.min(dx - 1, Math.max(0, Math.floor(u * dx)));
    const iy = Math.min(dy - 1, Math.max(0, Math.floor(v * dy)));
    const iz = Math.min(dz - 1, Math.max(0, Math.floor(w * dz)));
    const dens = await sampler.sample(ix, iy, iz);
    if (!Number.isFinite(dens)) continue;
    const ok = hitDensity >= 0 ? dens >= hitDensity : dens <= hitDensity;
    if (!ok) continue;
    seed = [ix, iy, iz];
    seedDensity = dens;
    break;
  }
  if (!seed) return null;

  // Keep voxels at least `rel` of the seed magnitude (sign-aware).
  const threshold = seedDensity >= 0 ? seedDensity * rel : seedDensity * (2 - rel);
  const inFeature = (d: number): boolean =>
    seedDensity >= 0 ? d >= threshold : d <= threshold;

  const key = (x: number, y: number, z: number): number => x + dx * (y + dy * z);
  const visited = new Set<number>();
  const queue: number[] = [seed[0], seed[1], seed[2]];
  visited.add(key(seed[0], seed[1], seed[2]));

  let count = 0;
  let sum = 0;
  let cx = 0;
  let cy = 0;
  let cz = 0;
  let minX = seed[0];
  let minY = seed[1];
  let minZ = seed[2];
  let maxX = seed[0];
  let maxY = seed[1];
  let maxZ = seed[2];
  let q = 0;

  const neigh: Array<[number, number, number]> = [
    [-1, 0, 0],
    [1, 0, 0],
    [0, -1, 0],
    [0, 1, 0],
    [0, 0, -1],
    [0, 0, 1],
  ];

  while (q < queue.length && count < maxRegion) {
    const x = queue[q++]!;
    const y = queue[q++]!;
    const z = queue[q++]!;
    const d = await sampler.sample(x, y, z);
    if (!Number.isFinite(d) || !inFeature(d)) continue;
    count++;
    sum += d;
    cx += x;
    cy += y;
    cz += z;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
    for (const [nx, ny, nz] of neigh) {
      const x2 = x + nx;
      const y2 = y + ny;
      const z2 = z + nz;
      if (x2 < 0 || y2 < 0 || z2 < 0 || x2 >= dx || y2 >= dy || z2 >= dz) continue;
      const k = key(x2, y2, z2);
      if (visited.has(k)) continue;
      visited.add(k);
      queue.push(x2, y2, z2);
    }
  }

  if (count === 0) return null;

  const pad = 2;
  const cropMin: [number, number, number] = [
    Math.max(0, (minX - pad) / dx),
    Math.max(0, (minY - pad) / dy),
    Math.max(0, (minZ - pad) / dz),
  ];
  const cropMax: [number, number, number] = [
    Math.min(1, (maxX + 1 + pad) / dx),
    Math.min(1, (maxY + 1 + pad) / dy),
    Math.min(1, (maxZ + 1 + pad) / dz),
  ];

  const halfX = dx * sx * 0.5;
  const halfY = dy * sy * 0.5;
  const halfZ = dz * sz * 0.5;

  return {
    seedVoxel: seed,
    seedDensity,
    threshold,
    voxelCount: count,
    volume: new units.Quantity(count * sx * sy * sz, units.VOLUME),
    meanDensity: sum / count,
    centroidSi: [
      (cx / count + 0.5) * sx - halfX,
      (cy / count + 0.5) * sy - halfY,
      (cz / count + 0.5) * sz - halfZ,
    ],
    cropMin,
    cropMax,
  };
}
