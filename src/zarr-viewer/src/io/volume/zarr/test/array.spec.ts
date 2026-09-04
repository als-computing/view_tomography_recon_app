import { describe, it, expect } from "vitest";
import { memoryStore } from "../store.js";
import { openZarrArray } from "../array.js";
import { NotImplementedError } from "@zarr-viewer/core";

/** Build a tiny in-memory zarr v2 array: shape [4,4,4], chunks [2,2,2] (8 chunks total, 2 per axis),
 * uint8, no compression - each chunk filled with a distinct constant value so callers can verify
 * exactly which chunk landed where. */
function buildFixture(): Map<string, Uint8Array> {
  const entries = new Map<string, Uint8Array>();
  const zarray = {
    shape: [4, 4, 4],
    chunks: [2, 2, 2],
    dtype: "|u1",
    compressor: null,
    fill_value: 0,
    order: "C",
    filters: null,
    dimension_separator: ".",
    zarr_format: 2,
  };
  entries.set(".zarray", new TextEncoder().encode(JSON.stringify(zarray)));

  let value = 1;
  for (let c0 = 0; c0 < 2; c0++) {
    for (let c1 = 0; c1 < 2; c1++) {
      for (let c2 = 0; c2 < 2; c2++) {
        const bytes = new Uint8Array(8).fill(value);
        entries.set(`${c0}.${c1}.${c2}`, bytes);
        value++;
      }
    }
  }
  return entries;
}

describe("ZarrArraySource.chunks()", () => {
  it("yields every disk chunk exactly once, regardless of arrival order (bounded-concurrency fetch)", async () => {
    const source = await openZarrArray(memoryStore(buildFixture()));
    const seen: string[] = [];
    const values: number[] = [];
    for await (const chunk of source.chunks(0)) {
      seen.push(chunk.origin.join(","));
      values.push((chunk.data as Uint8Array)[0]!);
    }
    expect(seen).toHaveLength(8);
    // Every chunk origin appears exactly once (order-independent — matches readRegion()'s own
    // documented contract, since concurrent fetches resolve in arrival order, not request order).
    expect(new Set(seen).size).toBe(8);
    // Every distinct fixture value (1..8) was actually read, not dropped or duplicated.
    expect(new Set(values)).toEqual(new Set([1, 2, 3, 4, 5, 6, 7, 8]));
  });

  it("matches readChunk() for each origin (same data via the concurrent path as the direct path)", async () => {
    const source = await openZarrArray(memoryStore(buildFixture()));
    const direct = await source.readChunk(0, 2, 2, 2); // last chunk, xyz voxel origin
    let viaChunks: (typeof direct) | undefined;
    for await (const chunk of source.chunks(0)) {
      if (chunk.origin[0] === 2 && chunk.origin[1] === 2 && chunk.origin[2] === 2) viaChunks = chunk;
    }
    expect(viaChunks).toBeDefined();
    expect((viaChunks!.data as Uint8Array)[0]).toBe((direct.data as Uint8Array)[0]);
  });
});

describe("permuteChunkToXyz's [2,1,0] fast path (standard on-disk z,y,x -> output x,y,z)", () => {
  it("relabels without moving data, matching a real per-voxel transpose (single chunk, coordinate-encoded values)", async () => {
    // Disk shape (z,y,x) = (2,3,4), C-order (x fastest on disk - the standard OME-NGFF z,y,x axis
    // order). Coordinate-encode each voxel's value as x + 10*y + 100*z so a wrong axis order or a
    // wrong "fast path" would produce values that don't match their claimed (x,y,z) position.
    const [dz, dy, dx] = [2, 3, 4];
    const bytes = new Uint8Array(dz * dy * dx);
    for (let iz = 0; iz < dz; iz++) {
      for (let iy = 0; iy < dy; iy++) {
        for (let ix = 0; ix < dx; ix++) {
          bytes[ix + dx * (iy + dy * iz)] = ix + 10 * iy + 100 * iz;
        }
      }
    }
    const entries = new Map<string, Uint8Array>();
    entries.set(
      ".zarray",
      new TextEncoder().encode(
        JSON.stringify({
          shape: [dz, dy, dx],
          chunks: [dz, dy, dx],
          dtype: "|u1",
          compressor: null,
          fill_value: 0,
          order: "C",
          filters: null,
          dimension_separator: ".",
          zarr_format: 2,
        }),
      ),
    );
    entries.set("0.0.0", bytes);

    // axisToXyz = [2,1,0]: output-x <- disk axis 2 (x, on-disk fastest), output-y <- disk axis 1 (y),
    // output-z <- disk axis 0 (z, on-disk slowest) - exactly the fast-path condition.
    const source = await openZarrArray(memoryStore(entries), "", { axisToXyz: [2, 1, 0] });
    expect(source.dimensionsAt(0)).toEqual([dx, dy, dz]);

    const chunk = await source.readChunk(0, 0, 0, 0);
    expect(chunk.shape).toEqual([dx, dy, dz]);
    const data = chunk.data as Uint8Array;
    for (let z = 0; z < dz; z++) {
      for (let y = 0; y < dy; y++) {
        for (let x = 0; x < dx; x++) {
          const outIdx = x + dx * (y + dy * z);
          expect(data[outIdx]).toBe(x + 10 * y + 100 * z);
        }
      }
    }
  });
});

describe("F-order rejection", () => {
  it("openZarrArray throws (not a silent C-order misread) for an array declaring order: 'F'", async () => {
    const entries = new Map<string, Uint8Array>();
    entries.set(
      ".zarray",
      new TextEncoder().encode(
        JSON.stringify({
          shape: [2, 2, 2],
          chunks: [2, 2, 2],
          dtype: "|u1",
          compressor: null,
          fill_value: 0,
          order: "F",
          filters: null,
          dimension_separator: ".",
          zarr_format: 2,
        }),
      ),
    );
    entries.set("0.0.0", new Uint8Array(8));
    await expect(openZarrArray(memoryStore(entries))).rejects.toThrow(NotImplementedError);
  });
});
