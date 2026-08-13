/**
 * Development-time invariants.
 *
 * These helpers are intended to catch programmer errors early. In a production build the
 * bundler can strip calls guarded by `import.meta.env?.DEV` or dead-code eliminate them when
 * `PRISM_DEV` is statically `false`; the runtime cost of a bare `assert` is a single truthiness
 * check, so they are safe to leave in hot-but-not-innermost code paths.
 *
 * @packageDocumentation
 */

/**
 * Error thrown when an invariant is violated. Distinct type so callers/tests can assert on it.
 */
export class AssertionError extends Error {
  public override readonly name = "AssertionError";
}

/**
 * Assert that `condition` is truthy, narrowing its type for the compiler.
 *
 * @param condition - The value that must be truthy.
 * @param message - Message (or lazy message factory) describing the violated invariant.
 * @throws {@link AssertionError} when `condition` is falsy.
 *
 * @example
 * ```ts
 * function head<T>(xs: readonly T[]): T {
 *   assert(xs.length > 0, "head() of empty array");
 *   return xs[0]!;
 * }
 * ```
 */
export function assert(condition: unknown, message?: string | (() => string)): asserts condition {
  if (!condition) {
    const msg = typeof message === "function" ? message() : (message ?? "assertion failed");
    throw new AssertionError(msg);
  }
}

/**
 * Assert that a value is neither `null` nor `undefined`, returning it narrowed.
 *
 * @example
 * ```ts
 * const el = assertDefined(document.getElementById("canvas"), "canvas missing");
 * ```
 */
export function assertDefined<T>(value: T, message?: string | (() => string)): NonNullable<T> {
  if (value === null || value === undefined) {
    const msg = typeof message === "function" ? message() : (message ?? "expected a defined value");
    throw new AssertionError(msg);
  }
  return value as NonNullable<T>;
}

/**
 * Marks an unreachable branch. Useful for exhaustive `switch` statements over unions.
 *
 * @example
 * ```ts
 * switch (kind) {
 *   case "a": return 1;
 *   case "b": return 2;
 *   default: return assertNever(kind);
 * }
 * ```
 */
export function assertNever(value: never, message?: string): never {
  throw new AssertionError(message ?? `unexpected value: ${String(value)}`);
}
