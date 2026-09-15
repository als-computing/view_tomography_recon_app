import { describe, expect, it } from "vitest";
import { ScalarGrid3 } from "../field-grid.js";
import { Vec3 } from "../vec3.js";

describe("ScalarGrid3.gradient — anisotropic voxel spacing", () => {
  it("reconstructs the exact analytical gradient of a linear field under anisotropic spacing", () => {
    // Scientific-correctness regression: central differences must divide by the correct per-axis
    // spacing (dx, dy, dz), not a single uniform cell size — an anisotropic grid (1x1x5 here) that
    // silently used a uniform spacing would get the z-gradient wrong by exactly the aspect ratio (5x).
    const dx = 1;
    const dy = 1;
    const dz = 5;
    const resolution: readonly [number, number, number] = [6, 6, 6];
    const grid = new ScalarGrid3({ resolution, cellSize: dx, cellSizeX: dx, cellSizeY: dy, cellSizeZ: dz });

    // f(x,y,z) = x + 2y + 3z, sampled at each vertex's world position.
    for (let k = 0; k < grid.nz; k++) {
      for (let j = 0; j < grid.ny; j++) {
        for (let i = 0; i < grid.nx; i++) {
          const x = i * dx;
          const y = j * dy;
          const z = k * dz;
          grid.set(i, j, k, x + 2 * y + 3 * z);
        }
      }
    }

    const g = new Vec3();
    // Interior vertex — central differences are exact for a linear field regardless of spacing.
    grid.gradient(g, 3, 3, 3);
    expect(g.x).toBeCloseTo(1, 6);
    expect(g.y).toBeCloseTo(2, 6);
    expect(g.z).toBeCloseTo(3, 6);
  });

  it("reconstructs the exact gradient at boundary vertices via one-sided differences", () => {
    const dx = 1;
    const dy = 1;
    const dz = 5;
    const grid = new ScalarGrid3({
      resolution: [4, 4, 4],
      cellSize: dx,
      cellSizeX: dx,
      cellSizeY: dy,
      cellSizeZ: dz,
    });
    for (let k = 0; k < grid.nz; k++) {
      for (let j = 0; j < grid.ny; j++) {
        for (let i = 0; i < grid.nx; i++) {
          grid.set(i, j, k, i * dx + 2 * (j * dy) + 3 * (k * dz));
        }
      }
    }
    const g = new Vec3();
    grid.gradient(g, 0, 0, 0); // corner vertex — every axis one-sided
    expect(g.x).toBeCloseTo(1, 6);
    expect(g.y).toBeCloseTo(2, 6);
    expect(g.z).toBeCloseTo(3, 6);
  });

  it("would misreport the z-gradient by the aspect ratio if spacing were treated as uniform", () => {
    // Sanity check on the test itself: confirms dz's magnitude actually matters for this field,
    // i.e. this test would fail loudly (not vacuously pass) if gradient() ignored per-axis spacing.
    const dz = 5;
    const grid = new ScalarGrid3({ resolution: [4, 4, 4], cellSize: 1, cellSizeZ: dz });
    for (let k = 0; k < grid.nz; k++) {
      for (let j = 0; j < grid.ny; j++) {
        for (let i = 0; i < grid.nx; i++) {
          grid.set(i, j, k, 3 * (k * dz));
        }
      }
    }
    const g = new Vec3();
    grid.gradient(g, 2, 2, 2);
    expect(g.z).toBeCloseTo(3, 6);
    expect(g.z).not.toBeCloseTo(3 * dz, 1); // would be 15 if dz were dropped from the divisor
  });
});
