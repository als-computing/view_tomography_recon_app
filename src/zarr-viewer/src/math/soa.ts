/**
 * Structure-of-Arrays (SoA) storage for large particle/instance sets. Each named field is a
 * contiguous `Float32Array`, which is cache-friendly for bulk updates and maps directly to GPU
 * storage buffers. Prefer this over arrays of {@link Vec3} for large N.
 *
 * @packageDocumentation
 */

import { Mat4 } from "./mat4.js";
import { Quat } from "./quat.js";
import { Vec3 } from "./vec3.js";

/** Field schema: maps a field name to its component count (e.g. `position: 3`). */
export type SoaSchema = Record<string, number>;

/**
 * A structure-of-arrays buffer.
 *
 * @typeParam S - The field schema.
 *
 * @example
 * ```ts
 * const particles = new Soa({ position: 3, velocity: 3, mass: 1 }, 100_000);
 * const i = particles.add();
 * particles.set("position", i, 0, 1.0);
 * const px = particles.get("position", i, 0);
 * ```
 */
export class Soa<S extends SoaSchema> {
  /** Per-field contiguous storage. */
  public readonly fields: { readonly [K in keyof S]: Float32Array };
  /** Number of live elements. */
  public count = 0;

  /** Allocate storage for up to `capacity` elements matching `schema` (field → component count). */
  public constructor(
    public readonly schema: S,
    public readonly capacity: number,
  ) {
    const fields = {} as { [K in keyof S]: Float32Array };
    for (const key of Object.keys(schema) as (keyof S)[]) {
      fields[key] = new Float32Array(capacity * schema[key]!);
    }
    this.fields = fields;
  }

  /** Reserve a new element index, or `-1` if at capacity. */
  public add(): number {
    if (this.count >= this.capacity) return -1;
    return this.count++;
  }

  /** Read component `comp` of `field` at element `index`. */
  public get<K extends keyof S>(field: K, index: number, comp = 0): number {
    return this.fields[field][index * this.schema[field]! + comp]!;
  }

  /** Write component `comp` of `field` at element `index`. */
  public set<K extends keyof S>(field: K, index: number, comp: number, value: number): void {
    this.fields[field][index * this.schema[field]! + comp] = value;
  }

  /**
   * Swap-remove element `index` (moves the last element into its slot). Returns the index that was
   * moved, or `-1` if `index` was the last element.
   */
  public swapRemove(index: number): number {
    const last = this.count - 1;
    if (index !== last) {
      for (const key of Object.keys(this.schema) as (keyof S)[]) {
        const c = this.schema[key]!;
        const arr = this.fields[key];
        for (let k = 0; k < c; k++) arr[index * c + k] = arr[last * c + k]!;
      }
    }
    this.count--;
    return index !== last ? last : -1;
  }

  /** Reset the buffer to empty (does not zero memory). */
  public clear(): void {
    this.count = 0;
  }
}

/** Configuration for a {@link Pool}. */
export interface PoolOptions<T> {
  /** Factory invoked to create a fresh instance when the free list is empty. */
  create: () => T;
  /** Optional reset applied when an instance is released (e.g. zero a vector). */
  reset?: (item: T) => void;
  /** Number of instances to pre-allocate up front. */
  prewarm?: number;
}

/**
 * A free-list object pool for recycling short-lived math objects (`Vec3`, `Mat4`, ...) in hot loops
 * without GC churn. Prism's APIs favor out-parameters, but a pool is handy when transient objects
 * are unavoidable (e.g. recursive scene traversal).
 *
 * This lives in `@zarr-viewer/math` so the package stays dependency-free; `@zarr-viewer/core` exposes an
 * equivalent generic pool for non-math types.
 *
 * @typeParam T - The pooled object type.
 *
 * @example
 * ```ts
 * const pool = vec3Pool(64);
 * const tmp = pool.acquire();
 * // ...use tmp...
 * pool.release(tmp);
 * ```
 */
export class Pool<T> {
  readonly #create: () => T;
  readonly #reset: ((item: T) => void) | undefined;
  #free: T[] = [];

  /** Create a pool from a `create` factory, optional `reset`, and optional `prewarm` count. */
  public constructor(options: PoolOptions<T>) {
    this.#create = options.create;
    this.#reset = options.reset;
    const prewarm = options.prewarm ?? 0;
    for (let i = 0; i < prewarm; i++) this.#free.push(this.#create());
  }

  /** Number of instances currently available for reuse. */
  public get size(): number {
    return this.#free.length;
  }

  /** Borrow an instance, creating one if the free list is empty. */
  public acquire(): T {
    return this.#free.pop() ?? this.#create();
  }

  /** Return an instance to the pool, applying `reset` if configured. */
  public release(item: T): void {
    this.#reset?.(item);
    this.#free.push(item);
  }

  /** Run `fn` with a borrowed instance, guaranteeing release even if `fn` throws. */
  public use<R>(fn: (item: T) => R): R {
    const item = this.acquire();
    try {
      return fn(item);
    } finally {
      this.release(item);
    }
  }

  /** Drop all retained instances (lets them be garbage-collected). */
  public clear(): void {
    this.#free.length = 0;
  }
}

/** A {@link Pool} of {@link Vec3} scratch vectors, reset to `(0, 0, 0)` on release. */
export function vec3Pool(prewarm = 0): Pool<Vec3> {
  return new Pool({ create: () => new Vec3(), reset: (v) => v.set(0, 0, 0), prewarm });
}

/** A {@link Pool} of identity {@link Mat4} scratch matrices, reset to identity on release. */
export function mat4Pool(prewarm = 0): Pool<Mat4> {
  return new Pool({ create: () => new Mat4(), reset: (m) => void m.identity(), prewarm });
}

/** A {@link Pool} of identity {@link Quat} scratch quaternions, reset to identity on release. */
export function quatPool(prewarm = 0): Pool<Quat> {
  return new Pool({ create: () => new Quat(), reset: (q) => void q.setIdentity(), prewarm });
}

/**
 * A fixed-size ring of pre-allocated instances for cheap, short-lived temporaries. Unlike
 * {@link Pool}, there is no explicit release: {@link Scratch.next} cycles through `capacity` slots,
 * so values are valid only until `capacity` further calls. Ideal for expression-local temporaries
 * in a tight loop.
 *
 * @typeParam T - The pooled object type.
 *
 * @example
 * ```ts
 * const scratch = new Scratch(4, () => new Vec3());
 * const t = scratch.next(); // reused every 4th call
 * ```
 */
export class Scratch<T> {
  readonly #slots: T[];
  #cursor = 0;

  /** Pre-allocate `capacity` instances via `create` to cycle through with {@link Scratch.next}. */
  public constructor(capacity: number, create: () => T) {
    this.#slots = new Array<T>(capacity);
    for (let i = 0; i < capacity; i++) this.#slots[i] = create();
  }

  /** The next scratch instance in the ring (overwrites the value from `capacity` calls ago). */
  public next(): T {
    const slot = this.#slots[this.#cursor]!;
    this.#cursor = (this.#cursor + 1) % this.#slots.length;
    return slot;
  }
}
