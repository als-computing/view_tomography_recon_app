/**
 * Tests for the byte-budgeted LRU decoded-chunk cache used by ROI/brick streaming.
 */
import { describe, it, expect } from "vitest";
import { DecodedChunkCache } from "../volume/chunk-cache.js";
import type { VolumeChunk } from "../volume/volume-source.js";

function chunk(bytes: number): VolumeChunk {
  return {
    origin: [0, 0, 0],
    shape: [bytes / 4, 1, 1],
    data: new Float32Array(bytes / 4),
  };
}

describe("DecodedChunkCache", () => {
  it("returns undefined on a miss and the stored chunk on a hit", () => {
    const cache = new DecodedChunkCache(1024);
    expect(cache.get("a")).toBeUndefined();
    const c = chunk(64);
    cache.set("a", c);
    expect(cache.get("a")).toBe(c);
  });

  it("evicts least-recently-inserted entries once the byte budget is exceeded", () => {
    const cache = new DecodedChunkCache(100);
    cache.set("a", chunk(40));
    cache.set("b", chunk(40));
    cache.set("c", chunk(40)); // total 120 > 100 → "a" (oldest) evicted
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toBeDefined();
    expect(cache.get("c")).toBeDefined();
  });

  it("get() promotes an entry to most-recently-used, protecting it from the next eviction", () => {
    const cache = new DecodedChunkCache(100);
    cache.set("a", chunk(40));
    cache.set("b", chunk(40));
    cache.get("a"); // "a" is now MRU; "b" is now the oldest
    cache.set("c", chunk(40)); // total 120 > 100 → "b" evicted, not "a"
    expect(cache.get("a")).toBeDefined();
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("c")).toBeDefined();
  });

  it("replacing an existing key updates its byte accounting instead of double-counting", () => {
    const cache = new DecodedChunkCache(100);
    cache.set("a", chunk(40));
    cache.set("a", chunk(80)); // replace, not add — total should be 80, not 120
    cache.set("b", chunk(40)); // 80 + 40 = 120 > 100 → evicts "a" (now oldest), not both
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toBeDefined();
  });

  it("clear() empties the cache and resets byte accounting", () => {
    const cache = new DecodedChunkCache(100);
    cache.set("a", chunk(40));
    cache.clear();
    expect(cache.get("a")).toBeUndefined();
    // After clear, budget accounting is reset, so two more 40-byte chunks fit without eviction.
    cache.set("b", chunk(40));
    cache.set("c", chunk(40));
    expect(cache.get("b")).toBeDefined();
    expect(cache.get("c")).toBeDefined();
  });

  it("rejects a chunk larger than the entire budget rather than admitting it", () => {
    // budgetBytes is meant to be a hard cap: admitting an oversized chunk would otherwise leave
    // the cache permanently over budget, since the eviction loop never evicts the last entry.
    const cache = new DecodedChunkCache(50);
    cache.set("big", chunk(200));
    expect(cache.get("big")).toBeUndefined();
  });

  it("rejecting an oversized chunk does not disturb entries already in the cache", () => {
    const cache = new DecodedChunkCache(50);
    cache.set("a", chunk(40));
    cache.set("big", chunk(200));
    expect(cache.get("a")).toBeDefined();
    expect(cache.get("big")).toBeUndefined();
  });
});

describe("DecodedChunkCache.getOrFetch", () => {
  it("returns the cached chunk directly, without calling fetcher", async () => {
    const cache = new DecodedChunkCache(1024);
    const c = chunk(64);
    cache.set("a", c);
    let calls = 0;
    const result = await cache.getOrFetch("a", async () => {
      calls++;
      return chunk(64);
    });
    expect(result).toBe(c);
    expect(calls).toBe(0);
  });

  it("dedupes concurrent requests for the same key into exactly one fetcher() call", async () => {
    const cache = new DecodedChunkCache(1024);
    let calls = 0;
    let resolveFetch: (c: VolumeChunk) => void = () => {};
    const fetcher = (): Promise<VolumeChunk> => {
      calls++;
      return new Promise((resolve) => {
        resolveFetch = resolve;
      });
    };
    const p1 = cache.getOrFetch("a", fetcher);
    const p2 = cache.getOrFetch("a", fetcher);
    const p3 = cache.getOrFetch("a", fetcher);
    expect(calls).toBe(1); // three callers, one underlying fetch
    const c = chunk(64);
    resolveFetch(c);
    const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
    expect(r1).toBe(c);
    expect(r2).toBe(c);
    expect(r3).toBe(c);
  });

  it("caches the fetched result so a later call is a cache hit, not a second fetch", async () => {
    const cache = new DecodedChunkCache(1024);
    let calls = 0;
    const c = chunk(64);
    await cache.getOrFetch("a", async () => {
      calls++;
      return c;
    });
    const second = await cache.getOrFetch("a", async () => {
      calls++;
      return chunk(64);
    });
    expect(calls).toBe(1);
    expect(second).toBe(c);
  });

  it("does not cache a failed fetch — the next request retries from scratch", async () => {
    const cache = new DecodedChunkCache(1024);
    let calls = 0;
    await expect(
      cache.getOrFetch("a", async () => {
        calls++;
        throw new Error("network error");
      }),
    ).rejects.toThrow("network error");
    expect(calls).toBe(1);

    const c = chunk(64);
    const result = await cache.getOrFetch("a", async () => {
      calls++;
      return c;
    });
    expect(calls).toBe(2); // retried, not permanently poisoned by the earlier failure
    expect(result).toBe(c);
  });

  it("an aborted caller's own wait rejects promptly, without cancelling the shared fetch for other waiters", async () => {
    const cache = new DecodedChunkCache(1024);
    let resolveFetch: (c: VolumeChunk) => void = () => {};
    const fetcher = (): Promise<VolumeChunk> =>
      new Promise((resolve) => {
        resolveFetch = resolve;
      });

    const controller = new AbortController();
    const abortedCaller = cache.getOrFetch("a", fetcher, controller.signal);
    const patientCaller = cache.getOrFetch("a", fetcher); // no signal — same in-flight fetch

    controller.abort();
    await expect(abortedCaller).rejects.toMatchObject({ name: "AbortError" });

    // The underlying fetch was NOT cancelled by the other caller's abort — it still resolves, and the
    // patient (non-aborted) caller still gets the real result.
    const c = chunk(64);
    resolveFetch(c);
    expect(await patientCaller).toBe(c);
    // ...and the result still lands in the cache for a subsequent request, unaffected by the earlier
    // abort.
    expect(cache.get("a")).toBe(c);
  });

  it("an already-aborted signal rejects immediately without waiting on the fetch at all", async () => {
    const cache = new DecodedChunkCache(1024);
    const controller = new AbortController();
    controller.abort();
    let calls = 0;
    // The fetch still starts (another, non-aborted caller might want it) — but THIS caller's own
    // promise rejects right away rather than waiting for it to settle.
    const fetcher = (): Promise<VolumeChunk> => {
      calls++;
      return new Promise(() => {}); // never resolves in this test
    };
    await expect(cache.getOrFetch("a", fetcher, controller.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
  });
});
