/**
 * Time utilities: a monotonic clock and a fixed-timestep accumulator for deterministic simulation.
 *
 * @packageDocumentation
 */

/** Returns a monotonic timestamp in milliseconds. */
export function now(): number {
  const perf = (globalThis as { performance?: { now(): number } }).performance;
  return perf ? perf.now() : Date.now();
}

/**
 * A monotonic clock tracking elapsed and delta time.
 *
 * @example
 * ```ts
 * const clock = new Clock();
 * function frame() {
 *   const dt = clock.tick(); // seconds since last tick
 *   update(dt);
 *   requestAnimationFrame(frame);
 * }
 * ```
 */
export class Clock {
  #last: number;
  #elapsed = 0;

  public constructor() {
    this.#last = now();
  }

  /** Advance the clock, returning the delta since the previous tick, in seconds. */
  public tick(): number {
    const t = now();
    const dt = (t - this.#last) / 1000;
    this.#last = t;
    this.#elapsed += dt;
    return dt;
  }

  /** Total elapsed seconds across all ticks. */
  public get elapsed(): number {
    return this.#elapsed;
  }

  /** Reset elapsed time and the internal timestamp. */
  public reset(): void {
    this.#last = now();
    this.#elapsed = 0;
  }
}

/**
 * Fixed-timestep accumulator. Feed it a variable frame delta; it yields a whole number of fixed
 * steps to run, plus an interpolation `alpha` in `[0, 1)` for rendering between physics states.
 *
 * This is the canonical pattern for stable, deterministic physics decoupled from render rate.
 *
 * @example
 * ```ts
 * const stepper = new FixedTimestep(1 / 120); // 120 Hz physics
 * // per frame:
 * const { steps, alpha } = stepper.advance(frameDeltaSeconds);
 * for (let i = 0; i < steps; i++) world.step(stepper.dt);
 * renderInterpolated(alpha);
 * ```
 */
export class FixedTimestep {
  #accumulator = 0;

  /**
   * @param dt - Fixed step size in seconds.
   * @param maxStepsPerAdvance - Clamp to avoid the "spiral of death" after long stalls.
   */
  public constructor(
    public readonly dt: number,
    public readonly maxStepsPerAdvance = 8,
  ) {}

  /**
   * Accumulate `frameDelta` seconds and report how many fixed steps to run.
   * @returns `steps` to execute and the render interpolation `alpha`.
   */
  public advance(frameDelta: number): { steps: number; alpha: number } {
    this.#accumulator += frameDelta;
    let steps = 0;
    while (this.#accumulator >= this.dt && steps < this.maxStepsPerAdvance) {
      this.#accumulator -= this.dt;
      steps++;
    }
    if (steps === this.maxStepsPerAdvance) {
      // Drop backlog beyond the clamp so we don't perpetually chase.
      this.#accumulator %= this.dt;
    }
    return { steps, alpha: this.#accumulator / this.dt };
  }

  /** Clear accumulated time (e.g. after a pause). */
  public reset(): void {
    this.#accumulator = 0;
  }
}
