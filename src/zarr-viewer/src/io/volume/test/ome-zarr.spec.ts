import { describe, it, expect } from "vitest";
import { memoryStore, type Store } from "../zarr/store.js";
import { openOmeZarr } from "../ome-zarr.js";

/** 2-level OME-NGFF fixture: scale0 (2x2x2, no translation) and scale1 (1x1x1, a nonzero translation
 * matching the standard "half a coarse voxel" shift real box-filtered pyramids declare). */
function buildFixture(): Map<string, Uint8Array> {
  const entries = new Map<string, Uint8Array>();
  entries.set(
    ".zattrs",
    new TextEncoder().encode(
      JSON.stringify({
        multiscales: [
          {
            "@type": "ngff:Image",
            version: "0.4",
            name: "fixture",
            axes: [
              { name: "z", type: "space", unit: "micrometer" },
              { name: "y", type: "space", unit: "micrometer" },
              { name: "x", type: "space", unit: "micrometer" },
            ],
            datasets: [
              {
                path: "scale0/image",
                coordinateTransformations: [{ type: "scale", scale: [1, 1, 1] }],
              },
              {
                path: "scale1/image",
                coordinateTransformations: [
                  { type: "scale", scale: [2, 2, 2] },
                  { type: "translation", translation: [0.5, 0.25, 0.75] },
                ],
              },
            ],
          },
        ],
      }),
    ),
  );
  const zarray = (shape: number[]) =>
    new TextEncoder().encode(
      JSON.stringify({
        shape,
        chunks: shape,
        dtype: "|u1",
        compressor: null,
        fill_value: 0,
        order: "C",
        filters: null,
        dimension_separator: ".",
        zarr_format: 2,
      }),
    );
  entries.set("scale0/image/.zarray", zarray([2, 2, 2]));
  entries.set("scale0/image/0.0.0", new Uint8Array(8));
  entries.set("scale1/image/.zarray", zarray([1, 1, 1]));
  entries.set("scale1/image/0.0.0", new Uint8Array(1));
  return entries;
}

/** Wraps a Store, counting `get()` calls per key so a fetch-deduplication regression fails loudly. */
function countingStore(inner: Store): { store: Store; counts: Map<string, number> } {
  const counts = new Map<string, number>();
  const store: Store = {
    get: (key, opts) => {
      counts.set(key, (counts.get(key) ?? 0) + 1);
      return inner.get(key, opts);
    },
    has: (key) => inner.has(key),
  };
  return { store, counts };
}

describe("openOmeZarr", () => {
  it("fetches each level's .zarray exactly once (was fetched twice: once in openOmeZarr, again inside openZarrArray)", async () => {
    const { store, counts } = countingStore(memoryStore(buildFixture()));
    await openOmeZarr(store, { skipRangeEstimate: true });
    expect(counts.get("scale0/image/.zarray")).toBe(1);
    expect(counts.get("scale1/image/.zarray")).toBe(1);
  });

  it("parses per-level NGFF translation instead of discarding it", async () => {
    const source = await openOmeZarr(memoryStore(buildFixture()), { skipRangeEstimate: true });
    const withTranslation = source as unknown as {
      translationAt(level: number): readonly [number, number, number];
    };
    // scale0 declares no translation -> zero.
    expect(withTranslation.translationAt(0)).toEqual([0, 0, 0]);
    // scale1's [0.5, 0.25, 0.75] is in disk axis order (z,y,x); axisToXyz for z,y,x axes is [2,1,0], so
    // output (x,y,z) = (disk[2], disk[1], disk[0]) = (0.75, 0.25, 0.5) micrometers -> SI meters.
    const [x, y, z] = withTranslation.translationAt(1);
    expect(x).toBeCloseTo(0.75e-6);
    expect(y).toBeCloseTo(0.25e-6);
    expect(z).toBeCloseTo(0.5e-6);
  });
});
