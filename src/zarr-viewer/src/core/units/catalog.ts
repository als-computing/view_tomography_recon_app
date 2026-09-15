/**
 * A comprehensive catalog of named units, grouped by physical quantity: the SI base and derived
 * units, plus a broad set of non-SI, imperial, atomic, and astronomical units used across Prism's
 * domains. Each is a ready-to-use {@link Unit}; {@link UNIT_BY_SYMBOL} indexes them for parsing.
 *
 * @packageDocumentation
 */

import * as D from "./dimension.js";
import { Unit, defineUnit } from "./unit.js";

const PI = Math.PI;

// --- SI base units ----------------------------------------------------------
export const meter = defineUnit(D.LENGTH, 1, "m", "meter");
export const kilogram = defineUnit(D.MASS, 1, "kg", "kilogram");
export const second = defineUnit(D.TIME, 1, "s", "second");
export const ampere = defineUnit(D.CURRENT, 1, "A", "ampere");
export const kelvin = defineUnit(D.TEMPERATURE, 1, "K", "kelvin");
export const mole = defineUnit(D.AMOUNT, 1, "mol", "mole");
export const candela = defineUnit(D.LUMINOUS, 1, "cd", "candela");

// --- SI derived units -------------------------------------------------------
export const radian = defineUnit(D.ANGLE, 1, "rad", "radian");
export const steradian = defineUnit(D.SOLID_ANGLE, 1, "sr", "steradian");
export const hertz = defineUnit(D.FREQUENCY, 1, "Hz", "hertz");
export const newton = defineUnit(D.FORCE, 1, "N", "newton");
export const pascal = defineUnit(D.PRESSURE, 1, "Pa", "pascal");
export const joule = defineUnit(D.ENERGY, 1, "J", "joule");
export const watt = defineUnit(D.POWER, 1, "W", "watt");
export const coulomb = defineUnit(D.CHARGE, 1, "C", "coulomb");
export const volt = defineUnit(D.VOLTAGE, 1, "V", "volt");
export const farad = defineUnit(D.CAPACITANCE, 1, "F", "farad");
export const ohm = defineUnit(D.RESISTANCE, 1, "Ω", "ohm");
export const siemens = defineUnit(D.CONDUCTANCE, 1, "S", "siemens");
export const weber = defineUnit(D.MAGNETIC_FLUX, 1, "Wb", "weber");
export const tesla = defineUnit(D.MAGNETIC_FLUX_DENSITY, 1, "T", "tesla");
export const henry = defineUnit(D.INDUCTANCE, 1, "H", "henry");
export const lumen = defineUnit(D.LUMINOUS_FLUX, 1, "lm", "lumen");
export const lux = defineUnit(D.ILLUMINANCE, 1, "lx", "lux");
export const becquerel = defineUnit(D.FREQUENCY, 1, "Bq", "becquerel");
export const gray = defineUnit(D.ABSORBED_DOSE, 1, "Gy", "gray");
export const sievert = defineUnit(D.ABSORBED_DOSE, 1, "Sv", "sievert");
export const katal = defineUnit(D.CATALYTIC_ACTIVITY, 1, "kat", "katal");

// --- Handy SI compound units ------------------------------------------------
export const squareMeter = defineUnit(D.AREA, 1, "m²", "square meter");
export const cubicMeter = defineUnit(D.VOLUME, 1, "m³", "cubic meter");
export const meterPerSecond = defineUnit(D.VELOCITY, 1, "m/s", "meter per second");
export const meterPerSecondSquared = defineUnit(D.ACCELERATION, 1, "m/s²", "meter per second squared");
export const kilogramPerCubicMeter = defineUnit(D.DENSITY, 1, "kg/m³", "kilogram per cubic meter");
export const newtonMeter = defineUnit(D.TORQUE, 1, "N·m", "newton meter");
export const pascalSecond = defineUnit(D.DYNAMIC_VISCOSITY, 1, "Pa·s", "pascal second");
export const radianPerSecond = defineUnit(D.ANGULAR_VELOCITY, 1, "rad/s", "radian per second");
export const joulePerKelvin = defineUnit(D.ENTROPY, 1, "J/K", "joule per kelvin");
export const voltPerMeter = defineUnit(D.ELECTRIC_FIELD, 1, "V/m", "volt per meter");

// --- Length -----------------------------------------------------------------
export const kilometer = defineUnit(D.LENGTH, 1e3, "km", "kilometer");
export const centimeter = defineUnit(D.LENGTH, 1e-2, "cm", "centimeter");
export const millimeter = defineUnit(D.LENGTH, 1e-3, "mm", "millimeter");
export const micrometer = defineUnit(D.LENGTH, 1e-6, "µm", "micrometer");
export const nanometer = defineUnit(D.LENGTH, 1e-9, "nm", "nanometer");
export const picometer = defineUnit(D.LENGTH, 1e-12, "pm", "picometer");
export const femtometer = defineUnit(D.LENGTH, 1e-15, "fm", "femtometer");
export const angstrom = defineUnit(D.LENGTH, 1e-10, "Å", "angstrom");
export const inch = defineUnit(D.LENGTH, 0.0254, "in", "inch");
export const foot = defineUnit(D.LENGTH, 0.3048, "ft", "foot");
export const yard = defineUnit(D.LENGTH, 0.9144, "yd", "yard");
export const mile = defineUnit(D.LENGTH, 1609.344, "mi", "mile");
export const nauticalMile = defineUnit(D.LENGTH, 1852, "nmi", "nautical mile");
export const astronomicalUnit = defineUnit(D.LENGTH, 1.495978707e11, "au", "astronomical unit");
export const lightYear = defineUnit(D.LENGTH, 9.4607304725808e15, "ly", "light year");
export const parsec = defineUnit(D.LENGTH, 3.0856775814913673e16, "pc", "parsec");
export const kiloparsec = defineUnit(D.LENGTH, 3.0856775814913673e19, "kpc", "kiloparsec");
export const megaparsec = defineUnit(D.LENGTH, 3.0856775814913673e22, "Mpc", "megaparsec");

// --- Mass -------------------------------------------------------------------
export const gram = defineUnit(D.MASS, 1e-3, "g", "gram");
export const milligram = defineUnit(D.MASS, 1e-6, "mg", "milligram");
export const microgram = defineUnit(D.MASS, 1e-9, "µg", "microgram");
export const tonne = defineUnit(D.MASS, 1e3, "t", "tonne");
export const atomicMassUnit = defineUnit(D.MASS, 1.6605390666e-27, "u", "atomic mass unit");
export const pound = defineUnit(D.MASS, 0.45359237, "lb", "pound");
export const ounce = defineUnit(D.MASS, 0.028349523125, "oz", "ounce");
export const stone = defineUnit(D.MASS, 6.35029318, "st", "stone");
export const carat = defineUnit(D.MASS, 2e-4, "ct", "carat");
export const solarMass = defineUnit(D.MASS, 1.98892e30, "M☉", "solar mass");
export const earthMass = defineUnit(D.MASS, 5.9722e24, "M⊕", "earth mass");
export const jupiterMass = defineUnit(D.MASS, 1.89813e27, "M♃", "jupiter mass");

// --- Time -------------------------------------------------------------------
export const millisecond = defineUnit(D.TIME, 1e-3, "ms", "millisecond");
export const microsecond = defineUnit(D.TIME, 1e-6, "µs", "microsecond");
export const nanosecond = defineUnit(D.TIME, 1e-9, "ns", "nanosecond");
export const picosecond = defineUnit(D.TIME, 1e-12, "ps", "picosecond");
export const femtosecond = defineUnit(D.TIME, 1e-15, "fs", "femtosecond");
export const minute = defineUnit(D.TIME, 60, "min", "minute");
export const hour = defineUnit(D.TIME, 3600, "h", "hour");
export const day = defineUnit(D.TIME, 86400, "d", "day");
export const week = defineUnit(D.TIME, 604800, "wk", "week");
export const year = defineUnit(D.TIME, 31557600, "yr", "Julian year");
export const megayear = defineUnit(D.TIME, 3.15576e13, "Myr", "megayear");
export const gigayear = defineUnit(D.TIME, 3.15576e16, "Gyr", "gigayear");

// --- Angle ------------------------------------------------------------------
export const degree = defineUnit(D.ANGLE, PI / 180, "°", "degree");
export const arcminute = defineUnit(D.ANGLE, PI / 10800, "′", "arcminute");
export const arcsecond = defineUnit(D.ANGLE, PI / 648000, "″", "arcsecond");
export const milliarcsecond = defineUnit(D.ANGLE, PI / 648000000, "mas", "milliarcsecond");
export const gradian = defineUnit(D.ANGLE, PI / 200, "grad", "gradian");
export const revolution = defineUnit(D.ANGLE, 2 * PI, "rev", "revolution");

// --- Energy -----------------------------------------------------------------
export const electronvolt = defineUnit(D.ENERGY, 1.602176634e-19, "eV", "electronvolt");
export const kiloelectronvolt = defineUnit(D.ENERGY, 1.602176634e-16, "keV", "kiloelectronvolt");
export const megaelectronvolt = defineUnit(D.ENERGY, 1.602176634e-13, "MeV", "megaelectronvolt");
export const gigaelectronvolt = defineUnit(D.ENERGY, 1.602176634e-10, "GeV", "gigaelectronvolt");
export const erg = defineUnit(D.ENERGY, 1e-7, "erg", "erg");
export const calorie = defineUnit(D.ENERGY, 4.184, "cal", "calorie");
export const kilocalorie = defineUnit(D.ENERGY, 4184, "kcal", "kilocalorie");
export const wattHour = defineUnit(D.ENERGY, 3600, "Wh", "watt hour");
export const kilowattHour = defineUnit(D.ENERGY, 3.6e6, "kWh", "kilowatt hour");
export const britishThermalUnit = defineUnit(D.ENERGY, 1055.05585, "BTU", "British thermal unit");

// --- Power ------------------------------------------------------------------
export const kilowatt = defineUnit(D.POWER, 1e3, "kW", "kilowatt");
export const megawatt = defineUnit(D.POWER, 1e6, "MW", "megawatt");
export const horsepower = defineUnit(D.POWER, 745.6998715822702, "hp", "horsepower");

// --- Pressure ---------------------------------------------------------------
export const bar = defineUnit(D.PRESSURE, 1e5, "bar", "bar");
export const millibar = defineUnit(D.PRESSURE, 1e2, "mbar", "millibar");
export const hectopascal = defineUnit(D.PRESSURE, 1e2, "hPa", "hectopascal");
export const kilopascal = defineUnit(D.PRESSURE, 1e3, "kPa", "kilopascal");
export const atmosphere = defineUnit(D.PRESSURE, 101325, "atm", "atmosphere");
export const torr = defineUnit(D.PRESSURE, 133.32236842105263, "Torr", "torr");
export const mmHg = defineUnit(D.PRESSURE, 133.322387415, "mmHg", "millimeter of mercury");
export const psi = defineUnit(D.PRESSURE, 6894.757293168361, "psi", "pound per square inch");

// --- Force ------------------------------------------------------------------
export const dyne = defineUnit(D.FORCE, 1e-5, "dyn", "dyne");
export const kilonewton = defineUnit(D.FORCE, 1e3, "kN", "kilonewton");
export const poundForce = defineUnit(D.FORCE, 4.4482216152605, "lbf", "pound-force");

// --- Temperature (note: °C/°F carry offsets and don't compose) --------------
export const celsius = new Unit(D.TEMPERATURE, 1, 273.15, "°C", "degree Celsius");
export const fahrenheit = new Unit(D.TEMPERATURE, 5 / 9, 255.3722222222222, "°F", "degree Fahrenheit");
export const rankine = defineUnit(D.TEMPERATURE, 5 / 9, "°R", "degree Rankine");

// --- Area / Volume ----------------------------------------------------------
export const hectare = defineUnit(D.AREA, 1e4, "ha", "hectare");
export const acre = defineUnit(D.AREA, 4046.8564224, "ac", "acre");
export const barn = defineUnit(D.AREA, 1e-28, "b", "barn");
export const liter = defineUnit(D.VOLUME, 1e-3, "L", "liter");
export const milliliter = defineUnit(D.VOLUME, 1e-6, "mL", "milliliter");
export const gallon = defineUnit(D.VOLUME, 3.785411784e-3, "gal", "US gallon");

// --- Velocity / rotation ----------------------------------------------------
export const kilometerPerHour = defineUnit(D.VELOCITY, 1 / 3.6, "km/h", "kilometer per hour");
export const milePerHour = defineUnit(D.VELOCITY, 0.44704, "mph", "mile per hour");
export const knot = defineUnit(D.VELOCITY, 0.5144444444444445, "kn", "knot");
export const rpm = defineUnit(D.ANGULAR_VELOCITY, (2 * PI) / 60, "rpm", "revolutions per minute");

// --- Electromagnetism -------------------------------------------------------
export const gauss = defineUnit(D.MAGNETIC_FLUX_DENSITY, 1e-4, "G", "gauss");
export const oersted = defineUnit(D.CURRENT.div(D.LENGTH), 1000 / (4 * PI), "Oe", "oersted");
export const debye = defineUnit(D.CHARGE.mul(D.LENGTH), 3.33564095198e-30, "D", "debye");

/** Every catalog unit, for iteration and lookup. */
export const ALL_UNITS: readonly Unit[] = [
  meter, kilogram, second, ampere, kelvin, mole, candela,
  radian, steradian, hertz, newton, pascal, joule, watt, coulomb, volt, farad, ohm,
  siemens, weber, tesla, henry, lumen, lux, becquerel, gray, sievert, katal,
  squareMeter, cubicMeter, meterPerSecond, meterPerSecondSquared, kilogramPerCubicMeter,
  newtonMeter, pascalSecond, radianPerSecond, joulePerKelvin, voltPerMeter,
  kilometer, centimeter, millimeter, micrometer, nanometer, picometer, femtometer, angstrom,
  inch, foot, yard, mile, nauticalMile, astronomicalUnit, lightYear, parsec, kiloparsec, megaparsec,
  gram, milligram, microgram, tonne, atomicMassUnit, pound, ounce, stone, carat,
  solarMass, earthMass, jupiterMass,
  millisecond, microsecond, nanosecond, picosecond, femtosecond, minute, hour, day, week, year,
  megayear, gigayear,
  degree, arcminute, arcsecond, milliarcsecond, gradian, revolution,
  electronvolt, kiloelectronvolt, megaelectronvolt, gigaelectronvolt, erg, calorie, kilocalorie,
  wattHour, kilowattHour, britishThermalUnit,
  kilowatt, megawatt, horsepower,
  bar, millibar, hectopascal, kilopascal, atmosphere, torr, mmHg, psi,
  dyne, kilonewton, poundForce,
  celsius, fahrenheit, rankine,
  hectare, acre, barn, liter, milliliter, gallon,
  kilometerPerHour, milePerHour, knot, rpm,
  gauss, oersted, debye,
];

/** Index of units by their symbol (first definition wins on collision). */
export const UNIT_BY_SYMBOL: Readonly<Record<string, Unit>> = (() => {
  const map: Record<string, Unit> = {};
  for (const u of ALL_UNITS) if (!(u.symbol in map)) map[u.symbol] = u;
  // ASCII / UCUM-friendly aliases for micrometer (OME-NGFF often writes "um").
  if (!("um" in map)) map.um = micrometer;
  if (!("u" in map)) map.u = micrometer;
  return map;
})();
