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
