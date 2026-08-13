/**
 * A minimal leveled logger with named scopes. Cheap by default (level checks short-circuit), and
 * routable so hosts can capture output. No dependency on `console` beyond the default sink.
 *
 * @packageDocumentation
 */

/** Severity levels in increasing order; `silent` disables all output. */
export type LogLevel = "debug" | "info" | "warn" | "error" | "silent";

const ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100,
};

/** A destination for log records. */
export type LogSink = (level: Exclude<LogLevel, "silent">, scope: string, args: unknown[]) => void;

const defaultSink: LogSink = (level, scope, args) => {
  const prefix = `[prism:${scope}]`;
   
  (console[level] ?? console.log)(prefix, ...args);
};

let globalLevel: LogLevel = "info";
let globalSink: LogSink = defaultSink;

/** Set the global minimum log level. */
export function setLogLevel(level: LogLevel): void {
  globalLevel = level;
}

/** Replace the global log sink (e.g. to forward to a UI console or telemetry). */
export function setLogSink(sink: LogSink): void {
  globalSink = sink;
}

/** A scoped logger. Create with {@link createLogger}. */
export interface Logger {
  readonly scope: string;
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
  child(subScope: string): Logger;
}

/**
 * Create a named logger.
 *
 * @example
 * ```ts
 * const log = createLogger("render");
 * log.info("device acquired");
 * const passLog = log.child("volume-pass");
 * ```
 */
export function createLogger(scope: string): Logger {
  const emit = (level: Exclude<LogLevel, "silent">, args: unknown[]): void => {
    if (ORDER[level] >= ORDER[globalLevel]) globalSink(level, scope, args);
  };
  return {
    scope,
    debug: (...args) => emit("debug", args),
    info: (...args) => emit("info", args),
    warn: (...args) => emit("warn", args),
    error: (...args) => emit("error", args),
    child: (subScope) => createLogger(`${scope}:${subScope}`),
  };
}
