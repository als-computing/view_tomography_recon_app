/**
 * A generic object pool for recycling short-lived objects in hot loops, avoiding GC churn.
 *
 * Prism's math types prefer out-parameter APIs, but when transient objects are unavoidable a pool
 * keeps allocation pressure flat.
 *
 * @packageDocumentation
 */

/** Options controlling {@link Pool} behavior. */
export interface PoolOptions<T> {
  /** Factory creating a fresh instance when the pool is empty. */
  create: () => T;
  /** Optional reset applied when an instance is released back to the pool. */
  reset?: (item: T) => void;
  /** Optional cap on retained free instances; extras are dropped for GC. */
  maxRetained?: number;
  /** Number of instances to pre-allocate. */
  prewarm?: number;
}

/**
 * A simple free-list object pool.
 *
 * @example
 * ```ts
 * const pool = new Pool({ create: () => new Float32Array(16), reset: (m) => m.fill(0) });
 * const m = pool.acquire();
 * // ...use m...
 * pool.release(m);
 * ```
 */
export class Pool<T> {
  readonly #create: () => T;
  readonly #reset: ((item: T) => void) | undefined;
  readonly #maxRetained: number;
  #free: T[] = [];

  public constructor(options: PoolOptions<T>) {
    this.#create = options.create;
    this.#reset = options.reset;
    this.#maxRetained = options.maxRetained ?? Number.POSITIVE_INFINITY;
    const prewarm = options.prewarm ?? 0;
    for (let i = 0; i < prewarm; i++) this.#free.push(this.#create());
  }

  /** Number of instances currently available for reuse. */
  public get size(): number {
    return this.#free.length;
  }

  /** Obtain an instance from the pool, or create one if none are free. */
  public acquire(): T {
    return this.#free.pop() ?? this.#create();
  }

  /** Return an instance to the pool, applying `reset` if configured. */
  public release(item: T): void {
    this.#reset?.(item);
    if (this.#free.length < this.#maxRetained) this.#free.push(item);
  }

  /**
   * Run `fn` with a borrowed instance, guaranteeing release even if `fn` throws.
   *
   * @example
   * ```ts
   * const len = pool.use((v) => computeLength(v));
   * ```
   */
  public use<R>(fn: (item: T) => R): R {
    const item = this.acquire();
    try {
      return fn(item);
    } finally {
      this.release(item);
    }
  }

  /** Drop all retained instances. */
  public clear(): void {
    this.#free.length = 0;
  }
}
