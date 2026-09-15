/**
 * A {@link Quantity} is a magnitude paired with a {@link Dimension}, stored internally in SI base
 * units. Arithmetic enforces dimensional correctness at runtime: `add`/`sub` require identical
 * dimensions, while `mul`/`div`/`pow` combine them. Conversions go through {@link Unit}s, so you read
 * and write values in whatever unit you like while computations stay consistent.
 *
 * @packageDocumentation
 */

import { Dimension, DIMENSIONLESS } from "./dimension.js";
import { Unit } from "./unit.js";

/** A dimensioned scalar value (stored in SI base units). */
export class Quantity {
  public constructor(
    /** Value in SI base units. */
    public readonly si: number,
    public readonly dimension: Dimension,
  ) {}

  /** Construct from a magnitude expressed in `unit`. */
  public static of(value: number, unit: Unit): Quantity {
    return new Quantity(unit.toSI(value), unit.dimension);
  }

  /** A dimensionless quantity. */
  public static scalar(value: number): Quantity {
    return new Quantity(value, DIMENSIONLESS);
  }

  /** Read this quantity's magnitude in `unit` (dimensions must match). */
  public to(unit: Unit): number {
    if (!this.dimension.equals(unit.dimension)) {
      throw new Error(
        `Dimension mismatch: quantity is [${this.dimension}] but unit ${unit.symbol} is [${unit.dimension}]`,
      );
    }
    return unit.fromSI(this.si);
  }

  public add(o: Quantity): Quantity {
    this.assertSameDimension(o, "add");
    return new Quantity(this.si + o.si, this.dimension);
  }

  public sub(o: Quantity): Quantity {
    this.assertSameDimension(o, "subtract");
    return new Quantity(this.si - o.si, this.dimension);
  }

  /** Multiply by a scalar or another quantity (dimensions combine). */
  public mul(o: Quantity | number): Quantity {
    return typeof o === "number"
      ? new Quantity(this.si * o, this.dimension)
      : new Quantity(this.si * o.si, this.dimension.mul(o.dimension));
  }

  /** Divide by a scalar or another quantity (dimensions combine). */
  public div(o: Quantity | number): Quantity {
    return typeof o === "number"
      ? new Quantity(this.si / o, this.dimension)
      : new Quantity(this.si / o.si, this.dimension.div(o.dimension));
  }

  /** Raise to an integer power (dimension exponents scale). */
  public pow(n: number): Quantity {
    return new Quantity(this.si ** n, this.dimension.pow(n));
  }

  public neg(): Quantity {
    return new Quantity(-this.si, this.dimension);
  }

  public abs(): Quantity {
    return new Quantity(Math.abs(this.si), this.dimension);
  }

  /** Compare magnitudes (dimensions must match); returns -1/0/1. */
  public compare(o: Quantity): number {
    this.assertSameDimension(o, "compare");
    return this.si < o.si ? -1 : this.si > o.si ? 1 : 0;
  }

  public equals(o: Quantity): boolean {
    return this.dimension.equals(o.dimension) && this.si === o.si;
  }

  public approxEquals(o: Quantity, epsilon = 1e-9): boolean {
    return this.dimension.equals(o.dimension) && Math.abs(this.si - o.si) <= epsilon;
  }

  /** Format using `unit` (falls back to SI value + dimension symbol). */
  public toString(unit?: Unit): string {
    if (unit) return `${this.to(unit)} ${unit.symbol}`;
    const dim = this.dimension.toString();
    return dim ? `${this.si} [${dim}]` : `${this.si}`;
  }

  private assertSameDimension(o: Quantity, op: string): void {
    if (!this.dimension.equals(o.dimension)) {
      throw new Error(`Cannot ${op} quantities of different dimensions: [${this.dimension}] vs [${o.dimension}]`);
    }
  }
}

/** Terse constructor: `Q(9.81, meterPerSecondSquared)`. */
export function Q(value: number, unit: Unit): Quantity {
  return Quantity.of(value, unit);
}
