/**
 * Unit *systems* for multi-scale simulation. Prism computes in SI, but at extreme scales (atoms,
 * galaxies) raw SI magnitudes lose float precision. A {@link UnitSystem} defines characteristic
 * length/mass/time; {@link toSim}/{@link fromSim} rescale any {@link Quantity} into (or out of) that
 * system using dimensional exponents, and {@link FloatingOrigin} rebases positions near the observer.
 *
 * @packageDocumentation
 */

import type { Dimension } from "./dimension.js";
import { Quantity } from "./quantity.js";

/** Characteristic SI scales that define a simulation's working units. */
export interface UnitSystem {
  name: string;
  /** Characteristic length L (meters per sim length unit). */
  length: number;
  /** Characteristic mass M (kilograms per sim mass unit). */
  mass: number;
  /** Characteristic time T (seconds per sim time unit). */
  time: number;
}

/**
 * Presets spanning ~40 orders of magnitude:
 * - `si` — meters / kilograms / seconds.
 * - `atomic` — ångström / atomic mass unit / femtosecond (molecular dynamics, crystallography).
 * - `microscopy` — micrometer / picogram / millisecond (tomography, light-sheet, NGFF volumes).
 * - `astronomical` — AU / solar mass / Julian year (stellar systems).
 * - `galactic` — kiloparsec / 10⁹ M☉ / megayear (galactic disks & mergers).
 * - `cosmological` — megaparsec / 10¹⁰ M☉ / gigayear (large-scale structure).
 */
export const UNIT_PRESETS: Readonly<
  Record<"si" | "atomic" | "microscopy" | "astronomical" | "galactic" | "cosmological", UnitSystem>
> = {
  si: { name: "SI", length: 1, mass: 1, time: 1 },
  atomic: { name: "atomic", length: 1e-10, mass: 1.6605390666e-27, time: 1e-15 },
  /** ~µm / pg / ms — keeps micron-scale volumes in comfortable float range. */
  microscopy: { name: "microscopy", length: 1e-6, mass: 1e-15, time: 1e-3 },
  astronomical: { name: "astronomical", length: 1.495978707e11, mass: 1.98892e30, time: 31557600 },
  galactic: {
    name: "galactic",
    length: 3.0856775814913673e19,
    mass: 1.98892e39,
    time: 3.15576e13,
  },
  cosmological: { name: "cosmological", length: 3.0856775814913673e22, mass: 1.98892e40, time: 3.15576e16 },
};

/**
 * The SI value of one sim unit for a given dimension: `L^l · M^m · T^t` (other base dimensions are
 * assumed already in SI). Multiply a sim value by this to recover SI; divide SI by it to get sim.
 */
export function scaleFactor(dimension: Dimension, system: UnitSystem): number {
  return (
    system.length ** dimension.length *
    system.mass ** dimension.mass *
    system.time ** dimension.time
  );
}

/** Convert a physical quantity to its dimensionless magnitude in `system`'s units. */
export function toSim(quantity: Quantity, system: UnitSystem): number {
  return quantity.si / scaleFactor(quantity.dimension, system);
}

/** Convert a sim magnitude of the given dimension back to a physical {@link Quantity}. */
export function fromSim(value: number, dimension: Dimension, system: UnitSystem): Quantity {
  return new Quantity(value * scaleFactor(dimension, system), dimension);
}

/**
 * A floating origin keeps rendered/simulated coordinates small by expressing positions relative to a
 * movable origin (typically snapped to the observer). Origin is kept in double precision; local
 * coordinates returned are safe to downcast to `Float32Array` for the GPU.
 *
 * @example
 * ```ts
 * const fo = new FloatingOrigin(10_000); // rebase when the camera drifts 10 km
 * fo.update(cam.x, cam.y, cam.z);
 * fo.toLocal(local, obj.x, obj.y, obj.z); // small numbers around the camera
 * ```
 */
export class FloatingOrigin {
  /** Current origin in world (double precision). */
  public readonly origin = new Float64Array(3);

  public constructor(public threshold = 1e4) {}

  /** Set the origin explicitly. */
  public setOrigin(x: number, y: number, z: number): void {
    this.origin[0] = x;
    this.origin[1] = y;
    this.origin[2] = z;
  }

  /** World → local (subtract origin), written into `out`. */
  public toLocal(out: [number, number, number], x: number, y: number, z: number): [number, number, number] {
    out[0] = x - (this.origin[0] as number);
    out[1] = y - (this.origin[1] as number);
    out[2] = z - (this.origin[2] as number);
    return out;
  }

  /** Local → world (add origin), written into `out`. */
  public toWorld(out: [number, number, number], x: number, y: number, z: number): [number, number, number] {
    out[0] = x + (this.origin[0] as number);
    out[1] = y + (this.origin[1] as number);
    out[2] = z + (this.origin[2] as number);
    return out;
  }

  /**
   * If the observer has drifted past `threshold` from the current origin, snap the origin to it.
   * Returns `true` if a rebase occurred (the caller should shift resident local coordinates by the
   * negative of the reported delta).
   */
  public update(x: number, y: number, z: number): boolean {
    const dx = x - (this.origin[0] as number);
    const dy = y - (this.origin[1] as number);
    const dz = z - (this.origin[2] as number);
    if (dx * dx + dy * dy + dz * dz > this.threshold * this.threshold) {
      this.setOrigin(x, y, z);
      return true;
    }
    return false;
  }
}
