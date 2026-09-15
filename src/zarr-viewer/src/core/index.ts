/**
 * `@zarr-viewer/core` — cross-cutting utilities shared by every Prism package.
 *
 * @packageDocumentation
 */

export { assert, assertDefined, assertNever, AssertionError } from "./assert.js";
export {
  PrismError,
  NotImplementedError,
  ok,
  err,
  isOk,
  isErr,
  unwrap,
} from "./result.js";
export type { PrismErrorCode, Ok, Err, Result } from "./result.js";
export { createHandleAllocator, uuid } from "./id.js";
export type { Handle } from "./id.js";
export { Emitter } from "./events.js";
export type { Listener, Unsubscribe } from "./events.js";
export { DisposableScope } from "./dispose.js";
export type { Disposable, DisposeFn } from "./dispose.js";
export { createLogger, setLogLevel, setLogSink } from "./log.js";
export type { LogLevel, LogSink, Logger } from "./log.js";
export { now, Clock, FixedTimestep } from "./time.js";
export { Pool } from "./pool.js";
export type { PoolOptions } from "./pool.js";

/**
 * Units of measure: dimensional analysis, quantities, a broad unit catalog, physical constants,
 * multi-scale systems, and parsing. Grouped under a namespace to keep the core surface tidy.
 */
export * as units from "./units/index.js";

/**
 * Chemistry: validated periodic-table constants (Pyykkö covalent radii, Bondi/Alvarez VdW,
 * IUPAC masses, Jmol CPK colors).
 */
export * as chemistry from "./chemistry/index.js";
export {
  PERIODIC_TABLE,
  elementByZ,
  elementBySymbol,
  normalizeElementSymbol,
  expectedBondLength,
  cpkColor,
  covalentRadius,
  vdwRadius,
  atomicMass,
  atomicNumber,
} from "./chemistry/periodic-table.js";
export type { ElementRecord } from "./chemistry/periodic-table.js";
