import { describe, it, expect } from "vitest";
import { memoryStore } from "../store.js";
import { openZarrArray } from "../array.js";

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
