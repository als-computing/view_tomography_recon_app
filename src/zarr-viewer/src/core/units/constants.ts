/**
 * Fundamental physical and astronomical constants as dimensioned {@link Quantity} values (CODATA 2018
 * where applicable). Because they carry dimensions, they compose safely in formulas — e.g.
 * `PLANCK.div(TWO_PI)` yields ħ with the correct action dimension.
 *
 * @packageDocumentation
 */

import * as D from "./dimension.js";
import { Quantity } from "./quantity.js";

const q = (si: number, dim: D.Dimension): Quantity => new Quantity(si, dim);

// --- Universal --------------------------------------------------------------
/** Speed of light in vacuum, c. */
export const SPEED_OF_LIGHT = q(299792458, D.VELOCITY);
/** Newtonian constant of gravitation, G. */
export const GRAVITATIONAL_CONSTANT = q(6.6743e-11, D.FORCE.mul(D.LENGTH.pow(2)).div(D.MASS.pow(2)));
/** Planck constant, h. */
export const PLANCK = q(6.62607015e-34, D.ACTION);
/** Reduced Planck constant, ħ = h / 2π. */
export const HBAR = q(1.054571817e-34, D.ACTION);

// --- Electromagnetic --------------------------------------------------------
/** Elementary charge, e. */
export const ELEMENTARY_CHARGE = q(1.602176634e-19, D.CHARGE);
/** Vacuum electric permittivity, ε₀. */
export const VACUUM_PERMITTIVITY = q(8.8541878128e-12, D.CAPACITANCE.div(D.LENGTH));
/** Vacuum magnetic permeability, µ₀. */
export const VACUUM_PERMEABILITY = q(1.25663706212e-6, D.INDUCTANCE.div(D.LENGTH));
/** Coulomb constant, kₑ = 1/(4πε₀). */
export const COULOMB_CONSTANT = q(8.9875517873681764e9, D.FORCE.mul(D.LENGTH.pow(2)).div(D.CHARGE.pow(2)));

// --- Thermodynamic ----------------------------------------------------------
/** Boltzmann constant, k_B. */
export const BOLTZMANN = q(1.380649e-23, D.ENTROPY);
/** Avogadro constant, N_A. */
export const AVOGADRO = q(6.02214076e23, D.AMOUNT.pow(-1));
/** Molar gas constant, R = N_A k_B. */
export const GAS_CONSTANT = q(8.314462618, D.ENERGY.div(D.AMOUNT.mul(D.TEMPERATURE)));
/** Stefan-Boltzmann constant, σ. */
export const STEFAN_BOLTZMANN = q(5.670374419e-8, D.POWER.div(D.AREA.mul(D.TEMPERATURE.pow(4))));

// --- Atomic / particle ------------------------------------------------------
/** Electron rest mass, mₑ. */
export const ELECTRON_MASS = q(9.1093837015e-31, D.MASS);
/** Proton rest mass, m_p. */
export const PROTON_MASS = q(1.67262192369e-27, D.MASS);
/** Neutron rest mass, m_n. */
export const NEUTRON_MASS = q(1.67492749804e-27, D.MASS);
/** Unified atomic mass unit, u. */
export const ATOMIC_MASS_UNIT = q(1.6605390666e-27, D.MASS);
/** Fine-structure constant, α (dimensionless). */
export const FINE_STRUCTURE = Quantity.scalar(7.2973525693e-3);
/** Bohr radius, a₀. */
export const BOHR_RADIUS = q(5.29177210903e-11, D.LENGTH);
/** Rydberg constant, R∞. */
export const RYDBERG = q(10973731.568160, D.LENGTH.pow(-1));
/** Faraday constant, F. */
export const FARADAY = q(96485.33212, D.CHARGE.div(D.AMOUNT));

// --- Standard / astronomical ------------------------------------------------
/** Standard gravity, g₀. */
export const STANDARD_GRAVITY = q(9.80665, D.ACCELERATION);
/** Standard atmosphere pressure. */
export const STANDARD_ATMOSPHERE = q(101325, D.PRESSURE);
/** Solar mass, M☉. */
export const SOLAR_MASS = q(1.98892e30, D.MASS);
/** Earth mass, M⊕. */
export const EARTH_MASS = q(5.9722e24, D.MASS);
/** Earth mean radius. */
export const EARTH_RADIUS = q(6.371e6, D.LENGTH);
/** Solar luminosity, L☉. */
export const SOLAR_LUMINOSITY = q(3.828e26, D.POWER);
