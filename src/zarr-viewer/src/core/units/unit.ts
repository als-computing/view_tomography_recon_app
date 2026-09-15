/**
 * A {@link Unit} is a named scale on a {@link Dimension}: it converts a numeric magnitude to/from the
 * SI base value via an affine map `si = value * factor + offset`. The `offset` supports non-ratio
 * scales like °C and °F; ratio units (the vast majority) have `offset = 0` and compose freely under
 * multiply/divide/power to build compound units.
 *
 * @packageDocumentation
 */

import { Dimension } from "./dimension.js";
import type { Prefix } from "./prefixes.js";

/** A unit of measure on a physical dimension. */
export class Unit {
  public constructor(
    public readonly dimension: Dimension,
    /** Multiply a magnitude by this to reach the SI base value. */
    public readonly factor: number,
    /** Affine offset (SI base units); nonzero only for scales like °C/°F. */
    public readonly offset = 0,
    public readonly symbol = "",
    public readonly name = "",
  ) {}

  /** Convert a magnitude in this unit to the SI base value. */
  public toSI(value: number): number {
    return value * this.factor + this.offset;
  }

  /** Convert an SI base value to a magnitude in this unit. */
  public fromSI(si: number): number {
    return (si - this.offset) / this.factor;
  }

  /** True if this is a pure ratio unit (composes safely). */
  public get isRatio(): boolean {
    return this.offset === 0;
  }

  /** Product of two ratio units (dimensions and factors combine). */
  public mul(o: Unit): Unit {
    this.assertRatio(o);
    return new Unit(this.dimension.mul(o.dimension), this.factor * o.factor);
  }

  /** Quotient of two ratio units. */
  public div(o: Unit): Unit {
    this.assertRatio(o);
    return new Unit(this.dimension.div(o.dimension), this.factor / o.factor);
  }

  /** Raise a ratio unit to an integer power. */
  public pow(n: number): Unit {
    if (!this.isRatio) throw new Error(`Cannot exponentiate non-ratio unit ${this.symbol}`);
    return new Unit(this.dimension.pow(n), this.factor ** n);
  }

  /** Return a copy carrying a symbol and (optional) name — handy after composing. */
  public labeled(symbol: string, name = ""): Unit {
    return new Unit(this.dimension, this.factor, this.offset, symbol, name);
  }

  public toString(): string {
    return this.symbol || `(${this.dimension.toString()} ×${this.factor})`;
  }

  private assertRatio(o: Unit): void {
    if (!this.isRatio || !o.isRatio) {
      throw new Error("Cannot compose units with a nonzero offset (e.g. °C); convert to a ratio unit first");
    }
  }
}

/** Build a prefixed unit, e.g. `withPrefix(SI_PREFIXES.k, meter)` → kilometer. */
export function withPrefix(prefix: Prefix, unit: Unit): Unit {
  if (!unit.isRatio) throw new Error(`Cannot prefix a non-ratio unit (${unit.symbol})`);
  return new Unit(
    unit.dimension,
    unit.factor * prefix.factor,
    0,
    `${prefix.symbol}${unit.symbol}`,
    `${prefix.name}${unit.name}`,
  );
}

/** Define a base/derived ratio unit from a dimension and SI factor. */
export function defineUnit(
  dimension: Dimension,
  factor: number,
  symbol: string,
  name = "",
): Unit {
  return new Unit(dimension, factor, 0, symbol, name);
}
