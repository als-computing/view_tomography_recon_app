/**
 * A byte-budgeted LRU cache of decoded {@link VolumeChunk}s, keyed by an opaque string (e.g. the
 * chunk's disk key). Used so ROI/brick streaming re-uses chunks when the user pans within a region or
 * re-enters one, instead of re-fetching + re-decoding every time (the stores do no caching of their
 * own). Cached chunks are treated as read-only by consumers, so sharing the same object is safe.
 *
 * Meant to be **shared across every level of one dataset's multiscale pyramid** (one instance, passed
 * to `openZarrArrayFromMeta` via `OpenZarrArrayOptions.sharedCache`), not one instance per level — chunk
 * keys already include the level's own store path, so this is collision-safe, and a single shared byte
 * budget across all levels is a more honest memory bound than N independent per-level budgets that
 * could together exceed it N-fold. {@link getOrFetch} also dedupes concurrent in-flight requests for
 * the same key (e.g. a whole-level scan and an overlapping ROI brick both wanting the same chunk at the
 * same time previously each paid for their own fetch + decode).
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
  /** Fetches currently in progress, keyed the same as `map` — see {@link getOrFetch}. */
  private readonly inFlight = new Map<string, Promise<VolumeChunk>>();

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

  /**
   * Get a cached chunk, or dedupe against an already-in-flight fetch for the same `key`, or start a
   * new one via `fetcher`. Concurrent callers for the same key share exactly one underlying `fetcher()`
   * call, not one per caller.
   *
   * `signal`, if given, is honored for THIS caller's own wait only — it is deliberately NOT threaded
   * into `fetcher` (callers should build `fetcher` without one). Aborting a fetch other callers are
   * also waiting on would incorrectly fail their requests too; instead, an aborted caller simply stops
   * waiting early while the shared fetch keeps running in the background and still lands in the cache
   * for next time (a superseded ROI request sharing a chunk with a still-desired region no longer stops
   * that one chunk's fetch early — a narrow, accepted cost: the chunk was, by definition, wanted by
   * more than one consumer, so the fetch was unlikely to be pure waste in the first place).
   */
  public getOrFetch(
    key: string,
    fetcher: () => Promise<VolumeChunk>,
    signal?: AbortSignal,
  ): Promise<VolumeChunk> {
    const cached = this.get(key);
    if (cached) return Promise.resolve(cached);

    let inflight = this.inFlight.get(key);
    if (!inflight) {
      inflight = fetcher();
      this.inFlight.set(key, inflight);
      inflight
        .then((chunk) => this.set(key, chunk))
        .catch(() => {}) // a failed fetch isn't cached - the next request just retries from scratch
        .finally(() => {
          if (this.inFlight.get(key) === inflight) this.inFlight.delete(key);
        });
    }
    if (!signal) return inflight;
    if (signal.aborted) return Promise.reject(new DOMException("aborted", "AbortError"));
    return new Promise<VolumeChunk>((resolve, reject) => {
      const onAbort = (): void => reject(new DOMException("aborted", "AbortError"));
      signal.addEventListener("abort", onAbort, { once: true });
      inflight!.then(
        (v) => {
          signal.removeEventListener("abort", onAbort);
          resolve(v);
        },
        (e: unknown) => {
          signal.removeEventListener("abort", onAbort);
          reject(e);
        },
      );
    });
  }
}
