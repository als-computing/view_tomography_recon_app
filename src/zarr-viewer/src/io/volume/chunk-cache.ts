/**
 * A byte-budgeted LRU cache of decoded {@link VolumeChunk}s, keyed by an opaque string (e.g. the
 * chunk's disk key). Used so ROI/brick streaming re-uses chunks when the user pans within a region or
 * re-enters one, instead of re-fetching + re-decoding every time (the stores do no caching of their
 * own). Cached chunks are treated as read-only by consumers, so sharing the same object is safe.
 *
 * @packageDocumentation
 */

import type { VolumeChunk } from "./volume-source.js";

const DEFAULT_BUDGET_BYTES = 256 * 1024 * 1024;

const chunkBytes = (c: VolumeChunk): number => c.data.byteLength;

/** Least-recently-used cache of decoded chunks with a total-bytes budget. */
export class DecodedChunkCache {
  /** Insertion order doubles as LRU order (oldest first). */
  private readonly map = new Map<string, VolumeChunk>();
  private bytes = 0;

  public constructor(private readonly budgetBytes = DEFAULT_BUDGET_BYTES) {}

  /** Return the cached chunk (marking it most-recently-used), or undefined on a miss. */
  public get(key: string): VolumeChunk | undefined {
    const v = this.map.get(key);
    if (v !== undefined) {
      this.map.delete(key);
      this.map.set(key, v); // re-insert → most-recently-used
    }
    return v;
  }

  /**
   * Insert/replace a chunk, evicting the least-recently-used entries to stay under budget.
   * A chunk larger than the entire budget is rejected outright — `budgetBytes` is a hard cap, so
   * admitting it would otherwise leave the cache permanently over budget (nothing left to evict).
   */
  public set(key: string, chunk: VolumeChunk): void {
    if (chunkBytes(chunk) > this.budgetBytes) return;
    const existing = this.map.get(key);
    if (existing) {
      this.bytes -= chunkBytes(existing);
      this.map.delete(key);
    }
    this.map.set(key, chunk);
    this.bytes += chunkBytes(chunk);
    while (this.bytes > this.budgetBytes && this.map.size > 1) {
      const oldest = this.map.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      const c = this.map.get(oldest);
      if (c) this.bytes -= chunkBytes(c);
      this.map.delete(oldest);
    }
  }

  public clear(): void {
    this.map.clear();
    this.bytes = 0;
  }
}
