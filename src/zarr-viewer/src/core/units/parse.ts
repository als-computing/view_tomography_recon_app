/**
 * Parse unit expressions and dimensioned literals from strings, so units can come from config, data
 * files, or LLM output. Grammar: terms joined by `*` (or `·`) and `/`, each term a (optionally
 * prefixed) symbol with an optional integer power `^n`, e.g. `"kg*m/s^2"`, `"g/cm^3"`, `"µm"`.
 *
 * @remarks
 * Not yet supported (planned): parentheses/grouping and Unicode superscripts (`m²`). Add a proper
 * recursive-descent parser when those are needed.
 *
 * @packageDocumentation
 */

import { SI_PREFIXES, BINARY_PREFIXES } from "./prefixes.js";
import type { Prefix } from "./prefixes.js";
import { Unit, withPrefix } from "./unit.js";
import { DIMENSIONLESS } from "./dimension.js";
import { UNIT_BY_SYMBOL } from "./catalog.js";
import { Quantity } from "./quantity.js";

const ALL_PREFIXES: Readonly<Record<string, Prefix>> = { ...SI_PREFIXES, ...BINARY_PREFIXES };
const PREFIX_KEYS = Object.keys(ALL_PREFIXES).sort((a, b) => b.length - a.length);

/** Resolve a single (possibly prefixed) unit symbol, or throw if unknown. */
export function resolveSymbol(symbol: string): Unit {
  const direct = UNIT_BY_SYMBOL[symbol];
  if (direct) return direct;
  for (const key of PREFIX_KEYS) {
    if (symbol.length > key.length && symbol.startsWith(key)) {
      const base = UNIT_BY_SYMBOL[symbol.slice(key.length)];
      if (base && base.isRatio) return withPrefix(ALL_PREFIXES[key] as Prefix, base);
    }
  }
  throw new Error(`Unknown unit symbol: "${symbol}"`);
}

interface Term {
  symbol: string;
  exp: number;
  divide: boolean;
}

function tokenize(expr: string): Term[] {
  const terms: Term[] = [];
  const normalized = expr.replace(/·/g, "*").trim();
  let divide = false;
  let buffer = "";
  const flush = (): void => {
    const token = buffer.trim();
    buffer = "";
    if (!token) return;
    const caret = token.indexOf("^");
    const symbol = caret >= 0 ? token.slice(0, caret) : token;
    const exp = caret >= 0 ? Number.parseInt(token.slice(caret + 1), 10) : 1;
    if (!Number.isFinite(exp)) throw new Error(`Invalid exponent in "${token}"`);
    terms.push({ symbol: symbol.trim(), exp, divide });
  };
  for (const ch of normalized) {
    if (ch === "*" || ch === "/") {
      flush();
      divide = ch === "/";
    } else {
      buffer += ch;
    }
  }
  flush();
  return terms;
}

/**
 * Parse a unit expression into a composed {@link Unit}.
 *
 * @example
 * ```ts
 * parseUnit("kg*m/s^2").dimension.equals(FORCE); // true
 * parseUnit("g/cm^3");                            // density
 * ```
 */
export function parseUnit(expr: string): Unit {
  const terms = tokenize(expr);
  if (terms.length === 0) throw new Error(`Empty unit expression: "${expr}"`);
  // A lone symbol may be a non-ratio unit (e.g. "°C"); return it directly.
  if (terms.length === 1) {
    const only = terms[0] as Term;
    if (only.exp === 1 && !only.divide) return resolveSymbol(only.symbol);
  }
  let acc = new Unit(DIMENSIONLESS, 1);
  for (const t of terms) {
    const u = resolveSymbol(t.symbol).pow(t.exp);
    acc = t.divide ? acc.div(u) : acc.mul(u);
  }
  return acc;
}

/**
 * Parse a dimensioned literal like `"9.81 m/s^2"` or `"1.5 GeV"` into a {@link Quantity}.
 */
export function parseQuantity(text: string): Quantity {
  const match = /^\s*([+-]?\d*\.?\d+(?:[eE][+-]?\d+)?)\s*(.*)$/.exec(text);
  if (!match) throw new Error(`Cannot parse quantity: "${text}"`);
  const value = Number.parseFloat(match[1] as string);
  const unitExpr = (match[2] as string).trim();
  if (!unitExpr) return Quantity.scalar(value);
  return Quantity.of(value, parseUnit(unitExpr));
}
