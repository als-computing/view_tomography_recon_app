/**
 * Physical dimensions via the seven SI base quantities. A {@link Dimension} is the vector of integer
 * (or rational) exponents `[L, M, T, I, Θ, N, J]`, enabling compile-safe *dimensional analysis*:
 * multiplying quantities adds exponents, dividing subtracts, and adding/subtracting requires equal
 * dimensions. Angle and solid angle are dimensionless in SI but are tracked as named units.
 *
 * @packageDocumentation
 */

/**
 * An immutable vector of exponents over the seven SI base dimensions.
 *
 * @example
 * ```ts
 * const velocity = LENGTH.div(TIME);          // L T^-1
 * const force = MASS.mul(velocity).div(TIME); // M L T^-2  (== FORCE)
 * force.equals(FORCE); // true
 * ```
 */
export class Dimension {
  public constructor(
    /** Length exponent (L). */
    public readonly length = 0,
    /** Mass exponent (M). */
    public readonly mass = 0,
    /** Time exponent (T). */
    public readonly time = 0,
    /** Electric current exponent (I). */
    public readonly current = 0,
    /** Thermodynamic temperature exponent (Θ). */
    public readonly temperature = 0,
    /** Amount of substance exponent (N). */
    public readonly amount = 0,
    /** Luminous intensity exponent (J). */
    public readonly luminous = 0,
  ) {}

  /** Product of two dimensions (exponents add). */
  public mul(o: Dimension): Dimension {
    return new Dimension(
      this.length + o.length,
      this.mass + o.mass,
      this.time + o.time,
      this.current + o.current,
      this.temperature + o.temperature,
      this.amount + o.amount,
      this.luminous + o.luminous,
    );
  }

  /** Quotient of two dimensions (exponents subtract). */
  public div(o: Dimension): Dimension {
    return new Dimension(
      this.length - o.length,
      this.mass - o.mass,
      this.time - o.time,
      this.current - o.current,
      this.temperature - o.temperature,
      this.amount - o.amount,
      this.luminous - o.luminous,
    );
  }

  /** Raise a dimension to an integer/rational power (exponents scale). */
  public pow(n: number): Dimension {
    return new Dimension(
      this.length * n,
      this.mass * n,
      this.time * n,
      this.current * n,
      this.temperature * n,
      this.amount * n,
      this.luminous * n,
    );
  }

  /** Structural equality of all exponents. */
  public equals(o: Dimension): boolean {
    return (
      this.length === o.length &&
      this.mass === o.mass &&
      this.time === o.time &&
      this.current === o.current &&
      this.temperature === o.temperature &&
      this.amount === o.amount &&
      this.luminous === o.luminous
    );
  }

  /** True if all exponents are zero (a pure number / ratio). */
  public get isDimensionless(): boolean {
    return this.equals(DIMENSIONLESS);
  }

  /** A compact symbolic form like `"M L T^-2"` (empty for dimensionless). */
  public toString(): string {
    const parts: string[] = [];
    const push = (sym: string, e: number): void => {
      if (e === 0) return;
      parts.push(e === 1 ? sym : `${sym}^${e}`);
    };
    push("L", this.length);
    push("M", this.mass);
    push("T", this.time);
    push("I", this.current);
    push("Θ", this.temperature);
    push("N", this.amount);
    push("J", this.luminous);
    return parts.join(" ");
  }
}

// --- Base dimensions --------------------------------------------------------

/** A pure number (all exponents zero). */
export const DIMENSIONLESS = new Dimension();
export const LENGTH = new Dimension(1);
export const MASS = new Dimension(0, 1);
export const TIME = new Dimension(0, 0, 1);
export const CURRENT = new Dimension(0, 0, 0, 1);
export const TEMPERATURE = new Dimension(0, 0, 0, 0, 1);
export const AMOUNT = new Dimension(0, 0, 0, 0, 0, 1);
export const LUMINOUS = new Dimension(0, 0, 0, 0, 0, 0, 1);

// --- Common derived dimensions ---------------------------------------------

export const ANGLE = DIMENSIONLESS; // radian
export const SOLID_ANGLE = DIMENSIONLESS; // steradian
export const AREA = LENGTH.pow(2);
export const VOLUME = LENGTH.pow(3);
export const FREQUENCY = TIME.pow(-1);
export const VELOCITY = LENGTH.div(TIME);
export const ACCELERATION = VELOCITY.div(TIME);
export const JERK = ACCELERATION.div(TIME);
export const MOMENTUM = MASS.mul(VELOCITY);
export const FORCE = MASS.mul(ACCELERATION);
export const PRESSURE = FORCE.div(AREA);
export const ENERGY = FORCE.mul(LENGTH);
export const POWER = ENERGY.div(TIME);
export const ACTION = ENERGY.mul(TIME);
export const DENSITY = MASS.div(VOLUME);
export const CHARGE = CURRENT.mul(TIME);
export const VOLTAGE = POWER.div(CURRENT);
export const CAPACITANCE = CHARGE.div(VOLTAGE);
export const RESISTANCE = VOLTAGE.div(CURRENT);
export const CONDUCTANCE = CURRENT.div(VOLTAGE);
export const MAGNETIC_FLUX = VOLTAGE.mul(TIME);
export const MAGNETIC_FLUX_DENSITY = MAGNETIC_FLUX.div(AREA); // tesla
export const INDUCTANCE = MAGNETIC_FLUX.div(CURRENT);
export const ELECTRIC_FIELD = VOLTAGE.div(LENGTH);
export const MAGNETIC_DIPOLE_MOMENT = CURRENT.mul(AREA);
export const LUMINOUS_FLUX = LUMINOUS.mul(SOLID_ANGLE);
export const ILLUMINANCE = LUMINOUS_FLUX.div(AREA);
export const CATALYTIC_ACTIVITY = AMOUNT.div(TIME);
export const ANGULAR_VELOCITY = ANGLE.div(TIME);
export const ANGULAR_MOMENTUM = MOMENTUM.mul(LENGTH);
export const TORQUE = FORCE.mul(LENGTH);
export const DYNAMIC_VISCOSITY = PRESSURE.mul(TIME);
export const SPECIFIC_HEAT = ENERGY.div(MASS.mul(TEMPERATURE));
export const ENTROPY = ENERGY.div(TEMPERATURE);
export const MOLAR_MASS = MASS.div(AMOUNT);
export const NUMBER_DENSITY = VOLUME.pow(-1);
export const ABSORBED_DOSE = ENERGY.div(MASS); // gray/sievert
