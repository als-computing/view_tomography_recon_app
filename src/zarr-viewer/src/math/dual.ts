/**
 * Forward-mode automatic differentiation via dual numbers. A {@link Dual} carries a value and its
 * derivative `a + b·ε` (with `ε² = 0`); evaluating any composition of the provided operations at a
 * seeded variable yields the exact derivative — no finite-difference error, no hand-derived
 * gradients. Use it for implicit-integrator Jacobians, gradient-based forces, and sensitivity
 * analysis.
 *
 * @packageDocumentation
 */

/** A dual number `re + du·ε` tracking a value (`re`) and its first derivative (`du`). */
export class Dual {
  /** The value (real part). */
  public re: number;
  /** The derivative (dual part). */
  public du: number;

  /** Create a dual number `re + du·ε`. */
  public constructor(re: number, du = 0) {
    this.re = re;
    this.du = du;
  }

  /** A constant (derivative 0). */
  public static constant(x: number): Dual {
    return new Dual(x, 0);
  }

  /** A seeded independent variable (derivative 1), the input to differentiate with respect to. */
  public static variable(x: number): Dual {
    return new Dual(x, 1);
  }

  /** `this + other`. */
  public add(other: Dual | number): Dual {
    const o = coerce(other);
    return new Dual(this.re + o.re, this.du + o.du);
  }

  /** `this − other`. */
  public sub(other: Dual | number): Dual {
    const o = coerce(other);
    return new Dual(this.re - o.re, this.du - o.du);
  }

  /** `this · other` (product rule). */
  public mul(other: Dual | number): Dual {
    const o = coerce(other);
    return new Dual(this.re * o.re, this.du * o.re + this.re * o.du);
  }

  /** `this / other` (quotient rule). */
  public div(other: Dual | number): Dual {
    const o = coerce(other);
    const inv = 1 / o.re;
    return new Dual(this.re * inv, (this.du * o.re - this.re * o.du) * inv * inv);
  }

  /** Negation. */
  public neg(): Dual {
    return new Dual(-this.re, -this.du);
  }
}

function coerce(x: Dual | number): Dual {
  return typeof x === "number" ? new Dual(x, 0) : x;
}

/** `xⁿ` for a real exponent `n` (power rule). */
export function dualPow(x: Dual, n: number): Dual {
  return new Dual(x.re ** n, n * x.re ** (n - 1) * x.du);
}

/** `√x`. */
export function dualSqrt(x: Dual): Dual {
  const r = Math.sqrt(x.re);
  return new Dual(r, x.du / (2 * r));
}

/** `eˣ`. */
export function dualExp(x: Dual): Dual {
  const e = Math.exp(x.re);
  return new Dual(e, e * x.du);
}

/** `ln x`. */
export function dualLog(x: Dual): Dual {
  return new Dual(Math.log(x.re), x.du / x.re);
}

/** `sin x`. */
export function dualSin(x: Dual): Dual {
  return new Dual(Math.sin(x.re), Math.cos(x.re) * x.du);
}

/** `cos x`. */
export function dualCos(x: Dual): Dual {
  return new Dual(Math.cos(x.re), -Math.sin(x.re) * x.du);
}

/** `tan x`. */
export function dualTan(x: Dual): Dual {
  const c = Math.cos(x.re);
  return new Dual(Math.tan(x.re), x.du / (c * c));
}

/**
 * Evaluate the exact derivative `f'(x)` of a single-variable function written in terms of
 * {@link Dual} operations, by seeding the variable and reading back the dual part.
 *
 * @example
 * ```ts
 * // d/dx sin(x²) = 2x·cos(x²)
 * derivative((x) => dualSin(dualPow(x, 2)), 1.3);
 * ```
 */
export function derivative(f: (x: Dual) => Dual, x: number): number {
  return f(Dual.variable(x)).du;
}

/** Evaluate a function and its derivative together at `x`. */
export function valueAndDerivative(f: (x: Dual) => Dual, x: number): { value: number; derivative: number } {
  const r = f(Dual.variable(x));
  return { value: r.re, derivative: r.du };
}
