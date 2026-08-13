/**
 * SI decimal prefixes (quecto … quetta) plus the IEC binary prefixes. Used to derive scaled units
 * (e.g. `kilo` × meter → kilometer).
 *
 * @packageDocumentation
 */

/** A named multiplicative prefix. */
export interface Prefix {
  name: string;
  symbol: string;
  factor: number;
}

/** The full set of SI decimal prefixes, keyed by symbol. */
export const SI_PREFIXES: Readonly<Record<string, Prefix>> = {
  q: { name: "quecto", symbol: "q", factor: 1e-30 },
  r: { name: "ronto", symbol: "r", factor: 1e-27 },
  y: { name: "yocto", symbol: "y", factor: 1e-24 },
  z: { name: "zepto", symbol: "z", factor: 1e-21 },
  a: { name: "atto", symbol: "a", factor: 1e-18 },
  f: { name: "femto", symbol: "f", factor: 1e-15 },
  p: { name: "pico", symbol: "p", factor: 1e-12 },
  n: { name: "nano", symbol: "n", factor: 1e-9 },
  µ: { name: "micro", symbol: "µ", factor: 1e-6 },
  u: { name: "micro", symbol: "u", factor: 1e-6 },
  m: { name: "milli", symbol: "m", factor: 1e-3 },
  c: { name: "centi", symbol: "c", factor: 1e-2 },
  d: { name: "deci", symbol: "d", factor: 1e-1 },
  da: { name: "deca", symbol: "da", factor: 1e1 },
  h: { name: "hecto", symbol: "h", factor: 1e2 },
  k: { name: "kilo", symbol: "k", factor: 1e3 },
  M: { name: "mega", symbol: "M", factor: 1e6 },
  G: { name: "giga", symbol: "G", factor: 1e9 },
  T: { name: "tera", symbol: "T", factor: 1e12 },
  P: { name: "peta", symbol: "P", factor: 1e15 },
  E: { name: "exa", symbol: "E", factor: 1e18 },
  Z: { name: "zetta", symbol: "Z", factor: 1e21 },
  Y: { name: "yotta", symbol: "Y", factor: 1e24 },
  R: { name: "ronna", symbol: "R", factor: 1e27 },
  Q: { name: "quetta", symbol: "Q", factor: 1e30 },
};

/** IEC binary prefixes (kibi … yobi), keyed by symbol. */
export const BINARY_PREFIXES: Readonly<Record<string, Prefix>> = {
  Ki: { name: "kibi", symbol: "Ki", factor: 2 ** 10 },
  Mi: { name: "mebi", symbol: "Mi", factor: 2 ** 20 },
  Gi: { name: "gibi", symbol: "Gi", factor: 2 ** 30 },
  Ti: { name: "tebi", symbol: "Ti", factor: 2 ** 40 },
  Pi: { name: "pebi", symbol: "Pi", factor: 2 ** 50 },
  Ei: { name: "exbi", symbol: "Ei", factor: 2 ** 60 },
};
