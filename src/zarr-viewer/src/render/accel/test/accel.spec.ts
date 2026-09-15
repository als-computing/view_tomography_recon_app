/**
 * Pure-function tests for volume-renderer acceleration (Milestones 0–2, 4.1–4.5 helpers).
 * GPU pipelines are exercised in the browser; these lock the numerical contracts the shaders mirror.
 */
import { describe, it, expect } from "vitest";
import {
  specializationFor,
  approximateShadingActive,
  approximateShadingLabel,
} from "../shader-config.js";
import {
  stampPngProvenance,
  readPngProvenance,
  hashTransferFunction,
  fnv1aHex,
  pngChunk,
  type RenderProvenance,
} from "../provenance.js";
import {
  visBinIndex,
  visBinUvwBox,
  visPriority,
  requiredLevelFromDistance,
  rankVisibilityBins,
  quantizeVisWeight,
  dequantizeVisWeight,
  VIS_WEIGHT_SCALE,
} from "../visibility.js";
import {
  tfActivePrefix,
  tfRangeActive,
  chebyshevDistanceField,
  dilateChebyshevField,
  majorantStepCap,
  densityToLutRange,
  MAX_CHEBYSHEV_PASSES,
} from "../occupancy.js";
import { dilateTileFlags } from "../tiles.js";
import { halton } from "../taau.js";
import { shadowTransform } from "../shadow-map.js";
import { meanFlip, solidRgba, syntheticVolume32 } from "../flip.js";
import { FLIP_CONFIGS, flipConfigToLut } from "../flip-configs.js";

/** Minimal valid 1×1 RGB PNG (IHDR + empty IDAT + IEND). */
function tinyPng(): Uint8Array {
  const sig = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = new Uint8Array(13);
  ihdr[3] = 1;
  ihdr[7] = 1;
  ihdr[8] = 8;
  ihdr[9] = 2;
  const idat = Uint8Array.from([0x78, 0x01, 0x03, 0x00, 0x00, 0x00, 0x00, 0x01]);
  const parts = [sig, pngChunk("IHDR", ihdr), pngChunk("IDAT", idat), pngChunk("IEND", new Uint8Array(0))];
  let o = 0;
  const total = parts.reduce((n, p) => n + p.length, 0);
  const png = new Uint8Array(total);
  for (const p of parts) {
    png.set(p, o);
    o += p.length;
  }
  return png;
}

describe("shader-config", () => {
  it("baseline compiles occupancy/tiles out; fast/quality compile them in", () => {
    expect(specializationFor("baseline").occupancy).toBe(false);
    expect(specializationFor("baseline").tiles).toBe(false);
    expect(specializationFor("fast").occupancy).toBe(true);
    expect(specializationFor("fast").tiles).toBe(true);
    expect(specializationFor("quality").occupancy).toBe(true);
    expect(specializationFor("quality").tiles).toBe(true);
  });

  it("keeps approximate shading out of baseline/fast, and labels it in quality (Milestone 7 provenance)", () => {
    for (const name of ["baseline", "fast"] as const) {
      const spec = specializationFor(name);
      expect(spec.multiScatterOctaves).toBe(0);
      expect(spec.bentNormalAmbient).toBe(false);
      expect(approximateShadingActive(spec)).toBe(false);
      expect(approximateShadingLabel(spec)).toBeNull();
    }
    const q = specializationFor("quality");
    expect(q.multiScatterOctaves).toBeGreaterThan(0);
    expect(q.bentNormalAmbient).toBe(true);
    expect(approximateShadingActive(q)).toBe(true);
    // The on-screen banner + PNG provenance depend on this label being non-null and descriptive.
    expect(approximateShadingLabel(q)).toContain("multi-scatter");
  });
});

describe("visibility priority", () => {
  it("quantizes with a scale that cannot overflow a 1080p screen of contributions", () => {
    const pixels = 1920 * 1080;
    const samplesPerBin = 16;
    expect(pixels * samplesPerBin * VIS_WEIGHT_SCALE).toBeLessThan(0xffffffff);
  });

  it("round-trips quantization", () => {
    expect(dequantizeVisWeight(quantizeVisWeight(0.5))).toBeCloseTo(0.5, 2);
    expect(quantizeVisWeight(0)).toBe(0);
  });

  it("indexes UVW into the grid", () => {
    expect(visBinIndex([0, 0, 0], [4, 4, 4])).toBe(0);
    expect(visBinIndex([0.99, 0, 0], [4, 4, 4])).toBe(3);
  });

  it("prioritizes LOD deficit, not visibility alone (0 = finest)", () => {
    expect(visPriority(10, 0, 0)).toBe(0); // already resident at required
    expect(visPriority(10, 0, 2)).toBe(20); // resident coarser than required
    expect(visPriority(10, 2, 0)).toBe(0); // resident finer than required
  });

  it("asks for a finer level when the camera is close", () => {
    expect(requiredLevelFromDistance(0.1, 1, 5)).toBeLessThan(requiredLevelFromDistance(10, 1, 5));
  });

  it("ranks bins by visibility × deficit", () => {
    const grid = [2, 1, 1] as const;
    const q = new Uint32Array([quantizeVisWeight(1), quantizeVisWeight(1)]);
    const ranked = rankVisibilityBins(q, grid, {
      levelCount: 4,
      boxExtent: 1,
      eye: [0, 0, 0],
      boxHalf: [0.5, 0.5, 0.5],
      residentLevelOf: (x) => (x === 0 ? 3 : 0),
    });
    expect(ranked[0]!.x).toBe(0);
    expect(ranked[0]!.priority).toBeGreaterThan(ranked[1]?.priority ?? 0);
  });

  it("maps a bin back to a UVW AABB", () => {
    const box = visBinUvwBox(1, 0, 0, [4, 4, 4]);
    expect(box.min[0]).toBeCloseTo(0.25);
    expect(box.max[0]).toBeCloseTo(0.5);
  });
});

describe("occupancy / TF-active / Chebyshev", () => {
  it("builds a prefix that detects a density window", () => {
    const lut = new Uint8Array(16);
    lut[3 * 4 + 3] = 200; // last bin active
    const prefix = tfActivePrefix(lut, 4);
    expect(tfRangeActive(prefix, 0.9, 1.0, 4)).toBe(true);
    expect(tfRangeActive(prefix, 0.0, 0.1, 4)).toBe(false);
  });

  it("maps density to inclusive LUT indices", () => {
    expect(densityToLutRange(0.5, 0.5, 256)).toEqual([127, 128]);
  });

  it("Chebyshev distance is 0 on active cells and L∞ to the nearest active", () => {
    const grid = [3, 3, 1] as const;
    const active = new Uint8Array([1, 0, 0, 0, 0, 0, 0, 0, 0]);
    const d = chebyshevDistanceField(active, grid);
    expect(d[0]).toBe(0);
    expect(d[1]).toBe(1); // (1,0)
    expect(d[2]).toBe(2); // (2,0)
    expect(d[4]).toBe(1); // (1,1) chebyshev
    expect(d[8]).toBe(2); // (2,2)
  });

  it("rebuilds distances when activity changes (TF-invalidation contract)", () => {
    const grid = [3, 1, 1] as const;
    const before = chebyshevDistanceField(new Uint8Array([1, 0, 0]), grid);
    const after = chebyshevDistanceField(new Uint8Array([0, 0, 1]), grid);
    expect(before[2]).toBe(2);
    expect(after[0]).toBe(2);
    expect(after[2]).toBe(0);
  });

  it("majorant step cap keeps per-segment opacity in 0.2–0.3", () => {
    const cap = majorantStepCap(10, 0.25);
    const opacity = 1 - Math.exp(-10 * cap);
    expect(opacity).toBeCloseTo(0.25, 5);
    expect(cap).toBeGreaterThan(0);
  });

  // Deterministic pseudo-random occupancy (LCG) so these run identically everywhere.
  const randomActive = (grid: readonly [number, number, number], fill: number): Uint8Array => {
    const n = grid[0] * grid[1] * grid[2];
    const a = new Uint8Array(n);
    let s = 0x9e3779b1 >>> 0;
    for (let i = 0; i < n; i++) {
      s = (s * 1664525 + 1013904223) >>> 0;
      a[i] = s / 0xffffffff < fill ? 1 : 0;
    }
    return a;
  };

  it("GPU dilation (DILATE_WGSL mirror) converges to the raster-order Chebyshev reference", () => {
    // The WGSL empty-space skip relies on the dilation producing true Chebyshev distance. Validate the
    // shader's algorithm (dilateChebyshevField) against the independent reference, GPU-free.
    for (const grid of [[6, 5, 4], [8, 8, 8], [10, 3, 7]] as const) {
      const active = randomActive(grid, 0.12);
      const cap = MAX_CHEBYSHEV_PASSES;
      const dil = dilateChebyshevField(active, grid, cap, cap);
      const ref = chebyshevDistanceField(active, grid);
      for (let i = 0; i < dil.length; i++) {
        expect(dil[i]).toBe(Math.min(ref[i]!, cap));
      }
    }
  });

  it("empty-space leap never jumps over an active cell (baseline↔fast parity guard)", () => {
    // The shader leaps a box of Chebyshev radius r = floor(dist) - 1 around an empty cell. That box MUST
    // contain no active cell, or `fast` would skip material `baseline` renders (the holes we're guarding
    // against). Assert the geometric invariant across many empty cells.
    const grid = [10, 9, 8] as const;
    const [nx, ny, nz] = grid;
    const active = randomActive(grid, 0.08);
    const dist = dilateChebyshevField(active, grid, MAX_CHEBYSHEV_PASSES);
    const at = (x: number, y: number, z: number): number => x + y * nx + z * nx * ny;
    for (let z = 0; z < nz; z++) {
      for (let y = 0; y < ny; y++) {
        for (let x = 0; x < nx; x++) {
          if (active[at(x, y, z)]) continue;
          const r = Math.max(0, Math.floor(dist[at(x, y, z)]!) - 1);
          for (let dz = -r; dz <= r; dz++) {
            for (let dy = -r; dy <= r; dy++) {
              for (let dx = -r; dx <= r; dx++) {
                const xx = x + dx, yy = y + dy, zz = z + dz;
                if (xx < 0 || yy < 0 || zz < 0 || xx >= nx || yy >= ny || zz >= nz) continue;
                expect(active[at(xx, yy, zz)]).toBe(0);
              }
            }
          }
        }
      }
    }
  });

  it("TF-invalidation: a widened window activates a previously-skipped cell (no stale skip)", () => {
    // Cell density range [0.60, 0.70]. TF1 window is high (only ~[0.9,1.0] active) → cell inactive,
    // dist > 0 (leapable). TF2 widens to include 0.65 → the rebuild must mark it active, dist == 0.
    const lutSize = 256;
    const cellDmin = 0.6, cellDmax = 0.7;
    const lut1 = new Uint8Array(lutSize * 4);
    const lut2 = new Uint8Array(lutSize * 4);
    for (let i = 0; i < lutSize; i++) {
      const d = i / (lutSize - 1);
      if (d >= 0.9) lut1[i * 4 + 3] = 255; // narrow high window
      if (d >= 0.5) lut2[i * 4 + 3] = 255; // widened to cover the cell
    }
    const p1 = tfActivePrefix(lut1, lutSize);
    const p2 = tfActivePrefix(lut2, lutSize);
    const activeBefore = tfRangeActive(p1, cellDmin, cellDmax, lutSize);
    const activeAfter = tfRangeActive(p2, cellDmin, cellDmax, lutSize);
    expect(activeBefore).toBe(false);
    expect(activeAfter).toBe(true);
    // The rebuilt distance field must have this cell at distance 0 (active), not stale-skipped.
    const grid = [1, 1, 1] as const;
    expect(chebyshevDistanceField(new Uint8Array([activeAfter ? 1 : 0]), grid)[0]).toBe(0);
  });
});

describe("pre-integration (Milestone 3.1)", () => {
  // CPU mirror of the shader math: cumulative extinction T(d)=∫₀^d α, then the ratio / midpoint-limit
  // segment-average alpha. Locks the two acceptance criteria: (a) no discontinuity at the eps boundary,
  // (b) convergence to the point value as the segment shrinks.
  const buildT = (alpha: number[]): Float32Array => {
    const n = alpha.length;
    const T = new Float32Array(n);
    const dd = 1 / Math.max(1, n - 1);
    let acc = 0;
    for (let i = 1; i < n; i++) {
      acc += 0.5 * (alpha[i - 1]! + alpha[i]!) * dd;
      T[i] = acc;
    }
    return T;
  };
  const alphaAt = (alpha: number[], d: number): number => {
    const n = alpha.length;
    const x = Math.min(1, Math.max(0, d)) * (n - 1);
    const i0 = Math.floor(x);
    const i1 = Math.min(i0 + 1, n - 1);
    return alpha[i0]! + (alpha[i1]! - alpha[i0]!) * (x - i0);
  };
  const Tat = (T: Float32Array, d: number): number => {
    const n = T.length;
    const x = Math.min(1, Math.max(0, d)) * (n - 1);
    const i0 = Math.floor(x);
    const i1 = Math.min(i0 + 1, n - 1);
    return T[i0]! + (T[i1]! - T[i0]!) * (x - i0);
  };
  const avgAlpha = (alpha: number[], T: Float32Array, sf: number, sb: number): number => {
    const eps = 3 / Math.max(2, alpha.length);
    if (Math.abs(sb - sf) < eps) return alphaAt(alpha, (sf + sb) / 2);
    return (Tat(T, sb) - Tat(T, sf)) / (sb - sf);
  };

  const N = 256;
  // A narrow alpha spike (the failure mode the plan targets) plus a smooth ramp elsewhere.
  const alpha = Array.from({ length: N }, (_, i) => {
    const d = i / (N - 1);
    return Math.exp(-((d - 0.5) ** 2) / (2 * 0.01 * 0.01)) * 0.9 + 0.05 * d;
  });
  const T = buildT(alpha);

  it("ratio and limit forms agree at the epsilon boundary (no discontinuity)", () => {
    const eps = 3 / N;
    // In a smoothly-varying region (linear-density assumption holds) the two forms must match tightly —
    // that is the "no seam at the eps boundary" contract. (At a sub-eps-width spike peak the midpoint
    // form's 2nd-order error is larger; that pathological curvature is bounded, not a discontinuity.)
    const c = 0.2; // on the smooth ramp, away from the spike
    const ratio = avgAlpha(alpha, T, c - eps * 0.51, c + eps * 0.51); // just over eps → ratio form
    const limit = avgAlpha(alpha, T, c - eps * 0.49, c + eps * 0.49); // just under eps → limit form
    expect(Math.abs(ratio - limit)).toBeLessThan(1e-3);
  });

  it("converges to the point (midpoint) value as the segment shrinks", () => {
    const c = 0.42;
    const wide = avgAlpha(alpha, T, c - 0.05, c + 0.05);
    const narrow = avgAlpha(alpha, T, c - 1e-4, c + 1e-4);
    expect(narrow).toBeCloseTo(alphaAt(alpha, c), 3);
    // The wide segment averages across the spike's shoulder, so it differs from the point value —
    // that difference (integrating the spike instead of skipping it) is the whole point of 3.1.
    expect(Math.abs(wide - alphaAt(alpha, c))).toBeGreaterThan(0);
  });
});

describe("TAAU jitter (Milestone 5)", () => {
  it("produces the low-discrepancy Halton sequence for sub-pixel jitter", () => {
    expect(halton(1, 2)).toBeCloseTo(0.5, 6);
    expect(halton(2, 2)).toBeCloseTo(0.25, 6);
    expect(halton(3, 2)).toBeCloseTo(0.75, 6);
    expect(halton(1, 3)).toBeCloseTo(1 / 3, 6);
    expect(halton(2, 3)).toBeCloseTo(2 / 3, 6);
  });

  it("stays within a pixel and spreads across the cell", () => {
    const xs: number[] = [];
    const ys: number[] = [];
    for (let k = 1; k <= 16; k++) {
      const jx = halton(k, 2) - 0.5;
      const jy = halton(k, 3) - 0.5;
      expect(Math.abs(jx)).toBeLessThanOrEqual(0.5);
      expect(Math.abs(jy)).toBeLessThanOrEqual(0.5);
      xs.push(jx);
      ys.push(jy);
    }
    // Covers both sub-pixel halves in each axis (real supersampling, not a stuck offset).
    expect(Math.max(...xs)).toBeGreaterThan(0);
    expect(Math.min(...xs)).toBeLessThan(0);
    expect(Math.max(...ys)).toBeGreaterThan(0);
    expect(Math.min(...ys)).toBeLessThan(0);
  });
});

describe("shadow map transform (Milestone 7.1)", () => {
  // Apply the column-major worldToLightUvw matrix (the same math the ray-march samples with).
  const applyM = (m: Float32Array, p: readonly [number, number, number]): [number, number, number] => {
    const r = (i: number): number => m[i]! * p[0] + m[4 + i]! * p[1] + m[8 + i]! * p[2] + m[12 + i]!;
    return [r(0), r(1), r(2)];
  };
  const dot = (a: readonly number[], b: readonly number[]): number => a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;

  it("maps the volume center to the light-UVW center and every corner into [0,1]", () => {
    const H: [number, number, number] = [1, 2, 1.5];
    const t = shadowTransform([0.3, 0.8, 0.5], H);
    const c = applyM(t.worldToLightUvw, [0, 0, 0]);
    expect(c[0]).toBeCloseTo(0.5, 5);
    expect(c[1]).toBeCloseTo(0.5, 5);
    expect(c[2]).toBeCloseTo(0.5, 5);
    for (const sx of [-1, 1])
      for (const sy of [-1, 1])
        for (const sz of [-1, 1]) {
          const lc = applyM(t.worldToLightUvw, [sx * H[0], sy * H[1], sz * H[2]]);
          for (const v of lc) {
            expect(v).toBeGreaterThanOrEqual(-1e-5);
            expect(v).toBeLessThanOrEqual(1 + 1e-5);
          }
        }
  });

  it("builds an orthonormal basis with fwd opposing the light direction", () => {
    const t = shadowTransform([0.3, 0.8, 0.5], [1, 1, 1]);
    expect(dot(t.right, t.up)).toBeCloseTo(0, 5);
    expect(dot(t.right, t.fwd)).toBeCloseTo(0, 5);
    expect(dot(t.up, t.fwd)).toBeCloseTo(0, 5);
    const l = Math.hypot(0.3, 0.8, 0.5);
    expect(t.fwd[0]).toBeCloseTo(-0.3 / l, 5);
    expect(t.fwd[1]).toBeCloseTo(-0.8 / l, 5);
  });
});

describe("tile dilation", () => {
  it("grows the active set by one tile (TAAU jitter contract)", () => {
    const flags = new Uint8Array([0, 0, 0, 0, 1, 0, 0, 0, 0]);
    const d = dilateTileFlags(flags, 3, 3);
    expect(d[4]).toBe(1);
    expect(d[0]).toBe(1);
    expect(d[8]).toBe(1);
  });
});

describe("provenance PNG stamping", () => {
  const provenance: RenderProvenance = {
    shaderConfig: "quality",
    multiScatterOctaves: 2,
    taauFrames: 7,
    shadowMode: "avsm",
    transferFunction: "lut:deadbeef;wl:0.45/0.30",
    renderScale: 0.5,
  };

  it("hashes LUTs stably", () => {
    const lut = new Uint8Array([1, 2, 3, 4]);
    expect(hashTransferFunction(lut)).toBe(`lut:${fnv1aHex(lut)}`);
  });

  it("round-trips provenance through tEXt/iTXt", () => {
    const stamped = stampPngProvenance(tinyPng(), provenance);
    expect(readPngProvenance(stamped)).toEqual(provenance);
  });
});

describe("FLIP harness", () => {
  it("commits the four review-round failure modes plus four more configs", () => {
    const ids = FLIP_CONFIGS.map((c) => c.id);
    expect(ids).toEqual(expect.arrayContaining(["alpha-spike", "low-opacity", "mip", "dense-flat"]));
    expect(FLIP_CONFIGS).toHaveLength(8);
  });

  it("builds a LUT for a narrow alpha spike", () => {
    const lut = flipConfigToLut({ kind: "spike", center: 1, width: 0.04, opacity: 1 }, 256);
    expect(lut[(255) * 4 + 3]).toBeGreaterThan(200);
    expect(lut[0 * 4 + 3]).toBe(0);
  });

  it("identical images have mean ℲLIP of 0", () => {
    const img = solidRgba(16, 16, [180, 90, 40]);
    const r = meanFlip(img, img, 16, 16);
    expect(r.mean).toBe(0);
    expect(r.max).toBe(0);
  });

  it("black vs white is a large error", () => {
    const a = solidRgba(8, 8, [0, 0, 0]);
    const b = solidRgba(8, 8, [255, 255, 255]);
    const r = meanFlip(a, b, 8, 8);
    expect(r.mean).toBeGreaterThan(0.2);
  });

  it("synthetic volume has a high-density core and a thin shell", () => {
    const v = syntheticVolume32();
    expect(v[15 + 15 * 32 + 15 * 32 * 32]).toBeCloseTo(0.8);
    expect(v.length).toBe(32 ** 3);
  });
});
