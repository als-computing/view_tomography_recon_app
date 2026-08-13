/**
 * A typed error taxonomy and a lightweight `Result` type for fallible operations where throwing
 * is undesirable (hot loops, parsers, I/O that routinely fails).
 *
 * @packageDocumentation
 */

/**
 * Stable, machine-readable error codes used across Prism subsystems. Kept as a string union so it
 * is both LLM-friendly (self-describing) and cheap to compare.
 */
export type PrismErrorCode =
  | "invalid_argument"
  | "not_found"
  | "unsupported"
  | "parse_error"
  | "io_error"
  | "gpu_error"
  | "not_implemented"
  | "internal";

/**
 * Base error for all Prism errors. Carries a stable {@link PrismErrorCode} and optional structured
 * `details` for programmatic handling and rich logging.
 */
export class PrismError extends Error {
  public override readonly name: string = "PrismError";
  public readonly code: PrismErrorCode;
  public readonly details: Readonly<Record<string, unknown>> | undefined;

  public constructor(
    code: PrismErrorCode,
    message: string,
    options?: { cause?: unknown; details?: Record<string, unknown> },
  ) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.code = code;
    this.details = options?.details;
  }
}

/** Thrown by skeleton stubs that have not been implemented yet. */
export class NotImplementedError extends PrismError {
  public override readonly name = "NotImplementedError";
  public constructor(symbol: string) {
    super("not_implemented", `not implemented: ${symbol}`);
  }
}

/** Successful result branch. */
export interface Ok<T> {
  readonly ok: true;
  readonly value: T;
}

/** Failure result branch. */
export interface Err<E> {
  readonly ok: false;
  readonly error: E;
}

/**
 * A discriminated union representing either success ({@link Ok}) or failure ({@link Err}).
 * Defaults the error type to {@link PrismError}.
 */
export type Result<T, E = PrismError> = Ok<T> | Err<E>;

/** Construct a successful {@link Result}. */
export function ok<T>(value: T): Ok<T> {
  return { ok: true, value };
}

/** Construct a failed {@link Result}. */
export function err<E>(error: E): Err<E> {
  return { ok: false, error };
}

/** Type guard narrowing a {@link Result} to its {@link Ok} branch. */
export function isOk<T, E>(result: Result<T, E>): result is Ok<T> {
  return result.ok;
}

/** Type guard narrowing a {@link Result} to its {@link Err} branch. */
export function isErr<T, E>(result: Result<T, E>): result is Err<E> {
  return !result.ok;
}

/**
 * Return the success value or throw the error (wrapping non-`Error` values in {@link PrismError}).
 *
 * @example
 * ```ts
 * const value = unwrap(parse(input));
 * ```
 */
export function unwrap<T, E>(result: Result<T, E>): T {
  if (result.ok) return result.value;
  if (result.error instanceof Error) throw result.error;
  throw new PrismError("internal", String(result.error));
}
