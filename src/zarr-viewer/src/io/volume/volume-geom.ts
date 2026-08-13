/**
 * Physical volume geometry helpers: voxel spacing and world bounds from a {@link VolumeSource}.
 * Spacing is SI meters; display conversions go through `@zarr-viewer/core` units.
 *
 * @packageDocumentation
 */

import { units } from "@zarr-viewer/core";
import { Aabb, Vec3 } from "@zarr-viewer/math";
import type { VolumeSource } from "./volume-source.js";

/** Voxel spacing at `level` as length {@link units.Quantity}s (x, y, z). */
export function voxelSpacingQuantities(
  source: VolumeSource,
  level = 0,
): readonly [units.Quantity, units.Quantity, units.Quantity] {
  const [sx, sy, sz] = source.spacingAt(level);
  return [
    new units.Quantity(sx, units.LENGTH),
    new units.Quantity(sy, units.LENGTH),
    new units.Quantity(sz, units.LENGTH),
  ];
}

/** Physical extent (dims × spacing) at `level` as length quantities (x, y, z). */
export function physicalSizeQuantities(
  source: VolumeSource,
  level = 0,
): readonly [units.Quantity, units.Quantity, units.Quantity] {
  const [dx, dy, dz] = source.dimensionsAt(level);
  const [sx, sy, sz] = source.spacingAt(level);
  return [
    new units.Quantity(dx * sx, units.LENGTH),
    new units.Quantity(dy * sy, units.LENGTH),
    new units.Quantity(dz * sz, units.LENGTH),
  ];
}

/**
 * Axis-aligned world bounds for a volume centered at the origin, using SI spacing.
 * Size = `dimensions * spacing` (meters). Useful for orbit framing and ray AABB.
 */
export function volumeWorldBounds(
  dimensions: readonly [number, number, number],
  spacingSi: readonly [number, number, number],
  out = new Aabb(),
): Aabb {
  const hx = dimensions[0] * spacingSi[0] * 0.5;
  const hy = dimensions[1] * spacingSi[1] * 0.5;
  const hz = dimensions[2] * spacingSi[2] * 0.5;
  out.min.set(-hx, -hy, -hz);
  out.max.set(hx, hy, hz);
  return out;
}

/** World bounds for a {@link VolumeSource} level (SI meters, centered). */
export function volumeSourceBounds(source: VolumeSource, level = 0, out = new Aabb()): Aabb {
  return volumeWorldBounds(source.dimensionsAt(level), source.spacingAt(level), out);
}

/** Longest physical edge in meters (for camera distance). */
export function volumeMaxExtentMeters(source: VolumeSource, level = 0): number {
  const [ex, ey, ez] = physicalSizeQuantities(source, level);
  return Math.max(ex.si, ey.si, ez.si);
}

/** Write physical size in sim units of `system` into `out`. */
export function physicalSizeSim(
  out: Vec3,
  source: VolumeSource,
  system: units.UnitSystem,
  level = 0,
): Vec3 {
  const [ex, ey, ez] = physicalSizeQuantities(source, level);
  out.set(units.toSim(ex, system), units.toSim(ey, system), units.toSim(ez, system));
  return out;
}

/** Options for {@link listUploadableLevels}. */
export interface UploadableLevelOptions {
  /** Reject levels finer than this index (default `0`). */
  minLevel?: number;
  /** Maximum texture dimension (default unlimited). */
  maxTextureDimension?: number;
  /** Approximate voxel budget; levels with more voxels are rejected. Default unlimited. */
  maxVoxels?: number;
}

/**
 * List multiscale levels safe to upload as a single 3D texture (fits device limits / voxel budget).
 */
export function listUploadableLevels(
  source: VolumeSource,
  options: UploadableLevelOptions = {},
): number[] {
  const minLevel = options.minLevel ?? 0;
  const maxDim = options.maxTextureDimension ?? Number.POSITIVE_INFINITY;
  const maxVoxels = options.maxVoxels ?? Number.POSITIVE_INFINITY;
  const out: number[] = [];
  for (let level = Math.max(0, minLevel); level < source.levelCount; level++) {
    const [dx, dy, dz] = source.dimensionsAt(level);
    if (dx > maxDim || dy > maxDim || dz > maxDim) continue;
    if (dx * dy * dz > maxVoxels) continue;
    out.push(level);
  }
  return out;
}
