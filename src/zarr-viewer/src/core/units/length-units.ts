/**
 * Resolve length-unit names from scientific metadata (OME-NGFF, UCUM-ish aliases) to catalog
 * {@link Unit}s. NGFF axes often use words like `"micrometer"` rather than symbols like `"µm"`.
 *
 * @packageDocumentation
 */

import {
  meter,
  kilometer,
  centimeter,
  millimeter,
  micrometer,
  nanometer,
  picometer,
  femtometer,
  angstrom,
  inch,
  foot,
  UNIT_BY_SYMBOL,
} from "./catalog.js";
import type { Unit } from "./unit.js";
import { parseUnit } from "./parse.js";

/** Alias map for OME-NGFF / microscopy / UCUM-style length names (lowercased). */
const LENGTH_ALIASES: Readonly<Record<string, Unit>> = {
  m: meter,
  meter: meter,
  meters: meter,
  metre: meter,
  metres: meter,
  km: kilometer,
  kilometer: kilometer,
  kilometres: kilometer,
  kilometeres: kilometer,
  cm: centimeter,
  centimeter: centimeter,
  centimetre: centimeter,
  millimeters: millimeter,
  millimetres: millimeter,
  mm: millimeter,
  millimeter: millimeter,
  millimetre: millimeter,
  um: micrometer,
  µm: micrometer,
  μm: micrometer, // Greek mu
  micron: micrometer,
  microns: micrometer,
  micrometer: micrometer,
  micrometre: micrometer,
  micrometers: micrometer,
  micrometres: micrometer,
  nm: nanometer,
  nanometer: nanometer,
  nanometre: nanometer,
  nanometers: nanometer,
  nanometres: nanometer,
  pm: picometer,
  picometer: picometer,
  picometre: picometer,
  fm: femtometer,
  femtometer: femtometer,
  femtometre: femtometer,
  angstrom: angstrom,
  angstroms: angstrom,
  ångström: angstrom,
  ångstrom: angstrom,
  "å": angstrom,
  a: angstrom,
  in: inch,
  inch: inch,
  inches: inch,
  ft: foot,
  foot: foot,
  feet: foot,
};

/**
 * Resolve a length unit from a metadata string (symbol, OME name, or parseable expression).
 * Returns `undefined` if the name is empty/unknown.
 *
 * @example
 * ```ts
 * resolveLengthUnit("micrometer") === units.micrometer
 * resolveLengthUnit("µm") === units.micrometer
 * ```
 */
export function resolveLengthUnit(name: string | undefined | null): Unit | undefined {
  if (name == null) return undefined;
  const trimmed = name.trim();
  if (!trimmed) return undefined;

  const lower = trimmed.toLowerCase();
  const alias = LENGTH_ALIASES[lower];
  if (alias) return alias;

  const bySymbol = UNIT_BY_SYMBOL[trimmed] ?? UNIT_BY_SYMBOL[lower];
  if (bySymbol && isPureLength(bySymbol)) return bySymbol;

  try {
    const u = parseUnit(trimmed);
    if (isPureLength(u)) return u;
  } catch {
    /* fall through */
  }
  return undefined;
}

function isPureLength(u: Unit): boolean {
  const d = u.dimension;
  return (
    d.length === 1 &&
    d.mass === 0 &&
    d.time === 0 &&
    d.current === 0 &&
    d.temperature === 0 &&
    d.amount === 0 &&
    d.luminous === 0
  );
}

/**
 * Convert a length magnitude expressed in a named unit to SI meters.
 * Falls back to treating `value` as already meters when the unit is unknown.
 */
export function lengthToMeters(value: number, unitName?: string | null): number {
  const u = resolveLengthUnit(unitName ?? undefined);
  return u ? u.toSI(value) : value;
}
