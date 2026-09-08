import { describe, it, expect } from "vitest";
import { memoryStore } from "../store.js";
import { openZarrArray } from "../array.js";
import { NotImplementedError } from "@zarr-viewer/core";
import type { VolumeDType } from "../../volume-source.js";

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

/** Wraps a Store, counting `get()` calls per key — mirrors `ome-zarr.spec.ts`'s own `countingStore`. */
function countingStore(inner: ReturnType<typeof memoryStore>): {
  store: ReturnType<typeof memoryStore>;
  counts: Map<string, number>;
} {
  const counts = new Map<string, number>();
  const store = {
    get: (key: string, opts?: unknown) => {
      counts.set(key, (counts.get(key) ?? 0) + 1);
      return inner.get(key, opts as never);
    },
    has: (key: string) => inner.has(key),
  };
  return { store, counts };
}

describe("ZarrArraySource chunk-fetch deduplication (shared DecodedChunkCache)", () => {
  it("two concurrent requests for the same chunk share one underlying store fetch", async () => {
    const { store, counts } = countingStore(memoryStore(buildFixture()));
    const source = await openZarrArray(store);
    const [a, b] = await Promise.all([source.readChunk(0, 0, 0, 0), source.readChunk(0, 0, 0, 0)]);
    expect(counts.get("0.0.0")).toBe(1); // deduped, not fetched twice
    expect((a.data as Uint8Array)[0]).toBe((b.data as Uint8Array)[0]);
  });

  it("a later request for an already-resolved chunk is a cache hit, not a second fetch", async () => {
    const { store, counts } = countingStore(memoryStore(buildFixture()));
    const source = await openZarrArray(store);
    await source.readChunk(0, 0, 0, 0);
    await source.readChunk(0, 0, 0, 0);
    expect(counts.get("0.0.0")).toBe(1);
  });
});

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

describe("coordinate-encoded regression across every dtype, with ragged (non-chunk-aligned) edges", () => {
  // Disk shape (z,y,x) = (3,3,3) with chunk size 2 per axis: ceil(3/2) = 2 chunks/axis, the second
  // always a partial (ragged) chunk - every axis exercises cropCOrderChunk's edge-cropping, not just
  // the whole-chunks-only case the fixture above uses. Standard z,y,x OME-NGFF axis order
  // (axisToXyz=[2,1,0]), so output x,y,z == disk x,y,z here (cubic, symmetric shape).
  const DIM = 3;
  const CHUNK = 2;
  const CHUNKS_PER_AXIS = Math.ceil(DIM / CHUNK);

  /** Coordinate-encodes each voxel as x + DIM*y + DIM^2*z (base-DIM digits) - small enough (max 26) to
   * be exactly representable in every advertised dtype, including signed int8's narrow range, so one
   * shared encoding works for all 8 without a per-dtype special case. */
  function encode(x: number, y: number, z: number): number {
    return x + DIM * y + DIM * DIM * z;
  }

  const DTYPE_CASES: Array<{
    dtype: VolumeDType;
    zarrDtype: string;
    build: (length: number) => { view: ArrayBufferView; set: (i: number, v: number) => void };
  }> = [
    { dtype: "uint8", zarrDtype: "|u1", build: (n) => mk(new Uint8Array(n)) },
    { dtype: "int8", zarrDtype: "|i1", build: (n) => mk(new Int8Array(n)) },
    { dtype: "uint16", zarrDtype: "<u2", build: (n) => mk(new Uint16Array(n)) },
    { dtype: "int16", zarrDtype: "<i2", build: (n) => mk(new Int16Array(n)) },
    { dtype: "uint32", zarrDtype: "<u4", build: (n) => mk(new Uint32Array(n)) },
    { dtype: "int32", zarrDtype: "<i4", build: (n) => mk(new Int32Array(n)) },
    { dtype: "float32", zarrDtype: "<f4", build: (n) => mk(new Float32Array(n)) },
    { dtype: "float64", zarrDtype: "<f8", build: (n) => mk(new Float64Array(n)) },
  ];

  function mk<T extends ArrayBufferView & { [i: number]: number }>(
    view: T,
  ): { view: T; set: (i: number, v: number) => void } {
    return { view, set: (i, v) => (view[i] = v) };
  }

  function buildDtypeFixture(zarrDtype: string, build: (n: number) => { view: ArrayBufferView; set: (i: number, v: number) => void }): Map<string, Uint8Array> {
    const entries = new Map<string, Uint8Array>();
    entries.set(
      ".zarray",
      new TextEncoder().encode(
        JSON.stringify({
          shape: [DIM, DIM, DIM],
          chunks: [CHUNK, CHUNK, CHUNK],
          dtype: zarrDtype,
          compressor: null,
          fill_value: 0,
          order: "C",
          filters: null,
          dimension_separator: ".",
          zarr_format: 2,
        }),
      ),
    );
    for (let cz = 0; cz < CHUNKS_PER_AXIS; cz++) {
      for (let cy = 0; cy < CHUNKS_PER_AXIS; cy++) {
        for (let cx = 0; cx < CHUNKS_PER_AXIS; cx++) {
          const { view, set } = build(CHUNK * CHUNK * CHUNK);
          for (let iz = 0; iz < CHUNK; iz++) {
            for (let iy = 0; iy < CHUNK; iy++) {
              for (let ix = 0; ix < CHUNK; ix++) {
                // Global disk (z,y,x) coordinate for this chunk-local voxel - values beyond DIM (the
                // ragged padding zarr v2 always stores at full chunk shape) are written too; they're
                // discarded by cropCOrderChunk and never observed, so any value is fine here.
                const gx = cx * CHUNK + ix;
                const gy = cy * CHUNK + iy;
                const gz = cz * CHUNK + iz;
                const idx = ix + CHUNK * (iy + CHUNK * iz); // C-order, x fastest
                set(idx, encode(gx, gy, gz));
              }
            }
          }
          const bytes = new Uint8Array(view.buffer as ArrayBuffer, (view as unknown as { byteOffset: number }).byteOffset, (view as unknown as { byteLength: number }).byteLength);
          entries.set(`${cz}.${cy}.${cx}`, bytes);
        }
      }
    }
    return entries;
  }

  for (const { dtype, zarrDtype, build } of DTYPE_CASES) {
    it(`decodes every voxel correctly for ${dtype} (axis-order + ragged-chunk cropping together)`, async () => {
      const entries = buildDtypeFixture(zarrDtype, build);
      const source = await openZarrArray(memoryStore(entries), "", { axisToXyz: [2, 1, 0] });
      expect(source.dimensionsAt(0)).toEqual([DIM, DIM, DIM]);

      const seen = new Set<string>();
      for await (const chunk of source.chunks(0)) {
        const [ox, oy, oz] = chunk.origin;
        const [sx, sy, sz] = chunk.shape;
        const data = chunk.data as unknown as ArrayLike<number>;
        for (let z = 0; z < sz; z++) {
          for (let y = 0; y < sy; y++) {
            for (let x = 0; x < sx; x++) {
              const gx = ox + x;
              const gy = oy + y;
              const gz = oz + z;
              const idx = x + sx * (y + sy * z);
              expect(data[idx], `voxel (${gx},${gy},${gz})`).toBe(encode(gx, gy, gz));
              seen.add(`${gx},${gy},${gz}`);
            }
          }
        }
      }
      // Every voxel of the full DIM^3 volume was actually visited exactly once across all chunks - not
      // dropped (a cropping bug) and not double-counted (a chunk-overlap bug).
      expect(seen.size).toBe(DIM * DIM * DIM);
    });
  }
});
