/**
 * Validated periodic-table constants for molecular visualization and simulation.
 *
 * Sources (cited per field):
 * - **Covalent radii** — P. Pyykkö & M. Atsumi, *Chem. Eur. J.* **15**, 186 (2009) single-bond;
 *   double/triple from Pyykkö & Atsumi (2009) / Pyykkö et al. (2005), values in pm → Å.
 * - **van der Waals radii** — A. Bondi, *J. Phys. Chem.* **68**, 441 (1964); gaps filled from
 *   S. Alvarez, *Dalton Trans.* **42**, 8617 (2013) where noted.
 * - **Standard atomic weights** — IUPAC CIAAW conventional values (rounded).
 * - **CPK / Jmol colors** — Jmol element colors ( RasMol/Jmol convention ), sRGB → `[0,1]`.
 *
 * Lengths are in **ångströms (Å)**; masses in **unified atomic mass units (u)**.
 *
 * @packageDocumentation
 */

/** Per-element physicochemical / display constants. */
export interface ElementRecord {
  /** Atomic number Z. */
  readonly z: number;
  /** Element symbol (e.g. `"Cl"`). */
  readonly symbol: string;
  /** English name. */
  readonly name: string;
  /** Standard atomic weight (u). */
  readonly atomicMass: number;
  /** Single-bond covalent radius (Å), Pyykkö 2009. */
  readonly covalentRadius: number;
  /** Double-bond covalent radius (Å), when tabulated. */
  readonly covalentRadiusDouble?: number;
  /** Triple-bond covalent radius (Å), when tabulated. */
  readonly covalentRadiusTriple?: number;
  /** van der Waals radius (Å). */
  readonly vdwRadius: number;
  /** CPK / Jmol display color, linear-ish sRGB in `[0, 1]`. */
  readonly cpkColor: readonly [number, number, number];
}

/** RGB helper: 0–255 channels → `[0,1]`. */
function rgb(r: number, g: number, b: number): readonly [number, number, number] {
  return [r / 255, g / 255, b / 255];
}

/**
 * Compact row builder. `r1`/`r2`/`r3`/`vdw` are in **picometres** (as published) and converted to Å.
 */
function el(
  z: number,
  symbol: string,
  name: string,
  atomicMass: number,
  r1Pm: number,
  vdwPm: number,
  color: readonly [number, number, number],
  r2Pm?: number,
  r3Pm?: number,
): ElementRecord {
  return {
    z,
    symbol,
    name,
    atomicMass,
    covalentRadius: r1Pm / 100,
    covalentRadiusDouble: r2Pm !== undefined ? r2Pm / 100 : undefined,
    covalentRadiusTriple: r3Pm !== undefined ? r3Pm / 100 : undefined,
    vdwRadius: vdwPm / 100,
    cpkColor: color,
  };
}

/**
 * Periodic table Z = 1…118.
 *
 * Covalent single-bond radii: Pyykkö & Atsumi (2009). Double/triple where published for that
 * element. VdW: Bondi (1964) for common organics; Alvarez (2013) / Pyykkö estimates for the rest.
 */
export const PERIODIC_TABLE: readonly ElementRecord[] = [
  el(1, "H", "Hydrogen", 1.008, 32, 120, rgb(255, 255, 255), undefined, undefined),
  el(2, "He", "Helium", 4.0026, 46, 140, rgb(217, 255, 255)),
  el(3, "Li", "Lithium", 6.94, 133, 182, rgb(204, 128, 255)),
  el(4, "Be", "Beryllium", 9.0122, 102, 153, rgb(194, 255, 0)),
  el(5, "B", "Boron", 10.81, 85, 192, rgb(255, 181, 181), 78, 73),
  el(6, "C", "Carbon", 12.011, 75, 170, rgb(144, 144, 144), 67, 60),
  el(7, "N", "Nitrogen", 14.007, 71, 155, rgb(48, 80, 248), 60, 54),
  el(8, "O", "Oxygen", 15.999, 63, 152, rgb(255, 13, 13), 57, 53),
  el(9, "F", "Fluorine", 18.998, 64, 147, rgb(144, 224, 80), 59, 53),
  el(10, "Ne", "Neon", 20.18, 67, 154, rgb(179, 227, 245)),
  el(11, "Na", "Sodium", 22.99, 155, 227, rgb(171, 92, 242)),
  el(12, "Mg", "Magnesium", 24.305, 139, 173, rgb(138, 255, 0)),
  el(13, "Al", "Aluminium", 26.982, 126, 184, rgb(191, 166, 166), 113, 111),
  el(14, "Si", "Silicon", 28.085, 111, 210, rgb(240, 200, 160), 107, 102),
  el(15, "P", "Phosphorus", 30.974, 107, 180, rgb(255, 128, 0), 102, 94),
  el(16, "S", "Sulfur", 32.06, 105, 180, rgb(255, 255, 48), 94, 95),
  el(17, "Cl", "Chlorine", 35.45, 102, 175, rgb(31, 240, 31), 95, 93),
  el(18, "Ar", "Argon", 39.948, 96, 188, rgb(128, 209, 227)),
  el(19, "K", "Potassium", 39.098, 196, 275, rgb(143, 64, 212)),
  el(20, "Ca", "Calcium", 40.078, 171, 231, rgb(61, 255, 0)),
  el(21, "Sc", "Scandium", 44.956, 148, 215, rgb(230, 230, 230)),
  el(22, "Ti", "Titanium", 47.867, 136, 211, rgb(191, 194, 199)),
  el(23, "V", "Vanadium", 50.942, 134, 207, rgb(166, 166, 171)),
  el(24, "Cr", "Chromium", 51.996, 122, 206, rgb(138, 153, 199)),
  el(25, "Mn", "Manganese", 54.938, 119, 205, rgb(156, 122, 199)),
  el(26, "Fe", "Iron", 55.845, 116, 204, rgb(224, 102, 51)),
  el(27, "Co", "Cobalt", 58.933, 111, 200, rgb(240, 144, 160)),
  el(28, "Ni", "Nickel", 58.693, 110, 197, rgb(80, 208, 80)),
  el(29, "Cu", "Copper", 63.546, 112, 196, rgb(200, 128, 51)),
  el(30, "Zn", "Zinc", 65.38, 118, 201, rgb(125, 128, 176)),
  el(31, "Ga", "Gallium", 69.723, 124, 187, rgb(194, 143, 143), 117, 121),
  el(32, "Ge", "Germanium", 72.63, 121, 211, rgb(102, 143, 143), 111, 114),
  el(33, "As", "Arsenic", 74.922, 121, 185, rgb(189, 128, 227), 114, 106),
  el(34, "Se", "Selenium", 78.971, 116, 190, rgb(255, 161, 0), 107, 107),
  el(35, "Br", "Bromine", 79.904, 114, 185, rgb(166, 41, 41), 109, 110),
  el(36, "Kr", "Krypton", 83.798, 117, 202, rgb(92, 184, 209)),
  el(37, "Rb", "Rubidium", 85.468, 210, 303, rgb(112, 46, 176)),
  el(38, "Sr", "Strontium", 87.62, 185, 249, rgb(0, 255, 0)),
  el(39, "Y", "Yttrium", 88.906, 163, 232, rgb(148, 255, 255)),
  el(40, "Zr", "Zirconium", 91.224, 154, 223, rgb(148, 224, 224)),
  el(41, "Nb", "Niobium", 92.906, 147, 218, rgb(115, 194, 201)),
  el(42, "Mo", "Molybdenum", 95.95, 138, 217, rgb(84, 181, 181)),
  el(43, "Tc", "Technetium", 97.907, 128, 216, rgb(59, 158, 158)),
  el(44, "Ru", "Ruthenium", 101.07, 125, 213, rgb(36, 143, 143)),
  el(45, "Rh", "Rhodium", 102.91, 125, 210, rgb(10, 125, 140)),
  el(46, "Pd", "Palladium", 106.42, 120, 210, rgb(0, 105, 133)),
  el(47, "Ag", "Silver", 107.87, 128, 211, rgb(192, 192, 192)),
  el(48, "Cd", "Cadmium", 112.41, 136, 218, rgb(255, 217, 143)),
  el(49, "In", "Indium", 114.82, 142, 193, rgb(166, 117, 115), 136, 146),
  el(50, "Sn", "Tin", 118.71, 140, 217, rgb(102, 128, 128), 130, 132),
  el(51, "Sb", "Antimony", 121.76, 140, 206, rgb(158, 99, 181), 133, 127),
  el(52, "Te", "Tellurium", 127.6, 136, 206, rgb(212, 122, 0), 128, 121),
  el(53, "I", "Iodine", 126.9, 133, 198, rgb(148, 0, 148), 129, 125),
  el(54, "Xe", "Xenon", 131.29, 131, 216, rgb(66, 158, 176)),
  el(55, "Cs", "Caesium", 132.91, 232, 343, rgb(87, 23, 143)),
  el(56, "Ba", "Barium", 137.33, 196, 268, rgb(0, 201, 0)),
  el(57, "La", "Lanthanum", 138.91, 180, 243, rgb(112, 212, 255)),
  el(58, "Ce", "Cerium", 140.12, 163, 242, rgb(255, 255, 199)),
  el(59, "Pr", "Praseodymium", 140.91, 176, 240, rgb(217, 255, 199)),
  el(60, "Nd", "Neodymium", 144.24, 174, 239, rgb(199, 255, 199)),
  el(61, "Pm", "Promethium", 144.91, 173, 238, rgb(163, 255, 199)),
  el(62, "Sm", "Samarium", 150.36, 172, 236, rgb(143, 255, 199)),
  el(63, "Eu", "Europium", 151.96, 168, 235, rgb(97, 255, 199)),
  el(64, "Gd", "Gadolinium", 157.25, 169, 234, rgb(69, 255, 199)),
  el(65, "Tb", "Terbium", 158.93, 168, 233, rgb(48, 255, 199)),
  el(66, "Dy", "Dysprosium", 162.5, 167, 231, rgb(31, 255, 199)),
  el(67, "Ho", "Holmium", 164.93, 166, 230, rgb(0, 255, 156)),
  el(68, "Er", "Erbium", 167.26, 165, 229, rgb(0, 230, 117)),
  el(69, "Tm", "Thulium", 168.93, 164, 227, rgb(0, 212, 82)),
  el(70, "Yb", "Ytterbium", 173.05, 170, 226, rgb(0, 191, 56)),
  el(71, "Lu", "Lutetium", 174.97, 162, 224, rgb(0, 171, 36)),
  el(72, "Hf", "Hafnium", 178.49, 152, 223, rgb(77, 194, 255)),
  el(73, "Ta", "Tantalum", 180.95, 146, 222, rgb(77, 166, 255)),
  el(74, "W", "Tungsten", 183.84, 137, 218, rgb(33, 148, 214)),
  el(75, "Re", "Rhenium", 186.21, 131, 216, rgb(38, 125, 171)),
  el(76, "Os", "Osmium", 190.23, 129, 216, rgb(38, 102, 150)),
  el(77, "Ir", "Iridium", 192.22, 122, 213, rgb(23, 84, 135)),
  el(78, "Pt", "Platinum", 195.08, 123, 213, rgb(208, 208, 224)),
  el(79, "Au", "Gold", 196.97, 124, 214, rgb(255, 209, 35)),
  el(80, "Hg", "Mercury", 200.59, 133, 223, rgb(184, 184, 208)),
  el(81, "Tl", "Thallium", 204.38, 144, 196, rgb(166, 84, 77), 142, 150),
  el(82, "Pb", "Lead", 207.2, 144, 202, rgb(87, 89, 97), 135, 137),
  el(83, "Bi", "Bismuth", 208.98, 151, 207, rgb(158, 79, 181), 141, 135),
  el(84, "Po", "Polonium", 208.98, 145, 197, rgb(171, 92, 0), 135, 137),
  el(85, "At", "Astatine", 209.99, 147, 202, rgb(117, 79, 69), 138, 138),
  el(86, "Rn", "Radon", 222.02, 142, 220, rgb(66, 130, 150)),
  el(87, "Fr", "Francium", 223.02, 223, 348, rgb(66, 0, 102)),
  el(88, "Ra", "Radium", 226.03, 201, 283, rgb(0, 125, 0)),
  el(89, "Ac", "Actinium", 227.03, 186, 260, rgb(112, 171, 250)),
  el(90, "Th", "Thorium", 232.04, 175, 245, rgb(0, 186, 255)),
  el(91, "Pa", "Protactinium", 231.04, 169, 243, rgb(0, 161, 255)),
  el(92, "U", "Uranium", 238.03, 170, 241, rgb(0, 143, 255)),
  el(93, "Np", "Neptunium", 237.05, 171, 239, rgb(0, 128, 255)),
  el(94, "Pu", "Plutonium", 244.06, 172, 243, rgb(0, 107, 255)),
  el(95, "Am", "Americium", 243.06, 166, 244, rgb(84, 92, 242)),
  el(96, "Cm", "Curium", 247.07, 166, 245, rgb(120, 92, 227)),
  el(97, "Bk", "Berkelium", 247.07, 168, 244, rgb(138, 79, 227)),
  el(98, "Cf", "Californium", 251.08, 168, 245, rgb(161, 54, 212)),
  el(99, "Es", "Einsteinium", 252.08, 165, 245, rgb(179, 31, 212)),
  el(100, "Fm", "Fermium", 257.1, 167, 245, rgb(179, 31, 186)),
  el(101, "Md", "Mendelevium", 258.1, 173, 246, rgb(179, 13, 166)),
  el(102, "No", "Nobelium", 259.1, 176, 246, rgb(189, 13, 135)),
  el(103, "Lr", "Lawrencium", 266.12, 161, 246, rgb(199, 0, 102)),
  el(104, "Rf", "Rutherfordium", 267.12, 157, 245, rgb(204, 0, 89)),
  el(105, "Db", "Dubnium", 268.13, 149, 246, rgb(209, 0, 79)),
  el(106, "Sg", "Seaborgium", 269.13, 143, 246, rgb(217, 0, 69)),
  el(107, "Bh", "Bohrium", 270.13, 141, 246, rgb(224, 0, 56)),
  el(108, "Hs", "Hassium", 269.13, 134, 246, rgb(230, 0, 46)),
  el(109, "Mt", "Meitnerium", 278.16, 129, 246, rgb(235, 0, 38)),
  el(110, "Ds", "Darmstadtium", 281.17, 128, 246, rgb(242, 0, 38)),
  el(111, "Rg", "Roentgenium", 282.17, 121, 246, rgb(242, 0, 46)),
  el(112, "Cn", "Copernicium", 285.18, 122, 246, rgb(242, 0, 55)),
  el(113, "Nh", "Nihonium", 286.18, 136, 246, rgb(242, 0, 64)),
  el(114, "Fl", "Flerovium", 289.19, 143, 246, rgb(242, 0, 74)),
  el(115, "Mc", "Moscovium", 289.19, 162, 246, rgb(242, 0, 84)),
  el(116, "Lv", "Livermorium", 293.2, 175, 246, rgb(242, 0, 94)),
  el(117, "Ts", "Tennessine", 294.21, 165, 246, rgb(242, 0, 104)),
  el(118, "Og", "Oganesson", 294.21, 157, 246, rgb(242, 0, 115)),
];

const BY_Z = new Map<number, ElementRecord>();
const BY_SYMBOL = new Map<string, ElementRecord>();
for (const e of PERIODIC_TABLE) {
  BY_Z.set(e.z, e);
  BY_SYMBOL.set(e.symbol, e);
}

/** Look up an element by atomic number. */
export function elementByZ(z: number): ElementRecord | undefined {
  return BY_Z.get(z | 0);
}

/**
 * Look up an element by symbol (`"C"`, `"cl"`, `"FE"` → Fe). Returns `undefined` if unknown.
 */
export function elementBySymbol(symbol: string): ElementRecord | undefined {
  const t = symbol.trim();
  if (!t) return undefined;
  const key =
    t.length === 1 ? t.toUpperCase() : t[0]!.toUpperCase() + t.slice(1).toLowerCase();
  return BY_SYMBOL.get(key);
}

/** Normalize an element symbol to the table’s canonical form, or `undefined`. */
export function normalizeElementSymbol(symbol: string): string | undefined {
  return elementBySymbol(symbol)?.symbol;
}

/**
 * Ideal covalent bond length (Å) from additive Pyykkö radii, adjusted for bond order.
 *
 * - order ≥ 3 → triple radii (fallback: single × 0.78)
 * - order ≥ 2 → double radii (fallback: single × 0.87)
 * - order ≥ 1.5 → aromatic blend between single and double
 * - else → single
 */
export function expectedBondLength(symbolA: string, symbolB: string, order = 1): number | undefined {
  const a = elementBySymbol(symbolA);
  const b = elementBySymbol(symbolB);
  if (!a || !b) return undefined;

  if (order >= 2.75) {
    const ra = a.covalentRadiusTriple ?? a.covalentRadius * 0.78;
    const rb = b.covalentRadiusTriple ?? b.covalentRadius * 0.78;
    return ra + rb;
  }
  if (order >= 1.75) {
    const ra = a.covalentRadiusDouble ?? a.covalentRadius * 0.87;
    const rb = b.covalentRadiusDouble ?? b.covalentRadius * 0.87;
    return ra + rb;
  }
  if (order >= 1.25) {
    // Aromatic: blend single↔double (order 1.5 → midpoint).
    const ra1 = a.covalentRadius;
    const rb1 = b.covalentRadius;
    const ra2 = a.covalentRadiusDouble ?? a.covalentRadius * 0.87;
    const rb2 = b.covalentRadiusDouble ?? b.covalentRadius * 0.87;
    const u = Math.min(1, Math.max(0, (order - 1) / 0.5));
    return ra1 + rb1 + (ra2 + rb2 - ra1 - rb1) * u;
  }
  return a.covalentRadius + b.covalentRadius;
}

/** CPK color for an element, or a muted magenta fallback for unknown symbols. */
export function cpkColor(symbol: string): readonly [number, number, number] {
  return elementBySymbol(symbol)?.cpkColor ?? ([0.85, 0.55, 0.95] as const);
}

/** Single-bond covalent radius (Å), or a generic 0.75 Å fallback. */
export function covalentRadius(symbol: string): number {
  return elementBySymbol(symbol)?.covalentRadius ?? 0.75;
}

/** van der Waals radius (Å), or 2.0 Å fallback. */
export function vdwRadius(symbol: string): number {
  return elementBySymbol(symbol)?.vdwRadius ?? 2.0;
}

/** Atomic mass (u), or 12 u fallback. */
export function atomicMass(symbol: string): number {
  return elementBySymbol(symbol)?.atomicMass ?? 12;
}

/** Atomic number Z, or 6 (carbon) fallback for unknown symbols. */
export function atomicNumber(symbol: string): number {
  return elementBySymbol(symbol)?.z ?? 6;
}
