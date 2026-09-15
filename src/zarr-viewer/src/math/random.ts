/**
 * A seeded pseudo-random number generator (mulberry32) plus common distributions. Deterministic and
 * reproducible — essential for repeatable simulations and tests.
 *
 * @packageDocumentation
 */

import { Vec3 } from "./vec3.js";

/**
 * A fast, seedable PRNG with uniform, integer, Gaussian, and geometric samplers.
 *
 * @example
 * ```ts
 * const rng = new Random(1234);
 * rng.float();          // [0, 1)
 * rng.range(-1, 1);     // uniform in [-1, 1)
 * rng.gaussian(0, 1);   // standard normal
 * rng.onUnitSphere(v);  // uniform point on the unit sphere
 * ```
 */
export class Random {
  #state: number;
  #spareGaussian: number | undefined;

  public constructor(seed = 0x9e3779b9) {
    this.#state = seed >>> 0;
  }

  /** Reseed the generator. */
  public seed(seed: number): this {
    this.#state = seed >>> 0;
    this.#spareGaussian = undefined;
    return this;
  }

  /** Next uniform float in `[0, 1)` (mulberry32). */
  public float(): number {
    this.#state = (this.#state + 0x6d2b79f5) | 0;
    let t = this.#state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Uniform float in `[min, max)`. */
  public range(min: number, max: number): number {
    return min + (max - min) * this.float();
  }

  /** Uniform integer in `[min, max]` inclusive. */
  public int(min: number, max: number): number {
    return Math.floor(this.range(min, max + 1));
  }

  /** `true` with probability `p`. */
  public bool(p = 0.5): boolean {
    return this.float() < p;
  }

  /** Normally-distributed sample (Box-Muller, with caching of the spare). */
  public gaussian(mean = 0, stdDev = 1): number {
    if (this.#spareGaussian !== undefined) {
      const s = this.#spareGaussian;
      this.#spareGaussian = undefined;
      return mean + stdDev * s;
    }
    let u = 0;
    let v = 0;
    let s = 0;
    do {
      u = this.float() * 2 - 1;
      v = this.float() * 2 - 1;
      s = u * u + v * v;
    } while (s === 0 || s >= 1);
    const mul = Math.sqrt((-2 * Math.log(s)) / s);
    this.#spareGaussian = v * mul;
    return mean + stdDev * (u * mul);
  }

  /** Write a uniformly-distributed point on the unit sphere into `out`. */
  public onUnitSphere(out: Vec3 = new Vec3()): Vec3 {
    const z = this.range(-1, 1);
    const theta = this.range(0, Math.PI * 2);
    const r = Math.sqrt(1 - z * z);
    return out.set(r * Math.cos(theta), r * Math.sin(theta), z);
  }

  /** Write a uniformly-distributed point inside the unit sphere into `out`. */
  public insideUnitSphere(out: Vec3 = new Vec3()): Vec3 {
    const r = Math.cbrt(this.float());
    this.onUnitSphere(out);
    return out.multiplyScalar(r);
  }
}
