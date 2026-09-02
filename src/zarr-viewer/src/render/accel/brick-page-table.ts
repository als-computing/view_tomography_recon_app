/**
 * CPU-side LRU slot allocator for a future GPU brick atlas (item 8, foundation-only pass — see the
 * plan file). Maps a resident brick's key to an atlas slot index, evicting least-recently-used slots
 * once full. Pure bookkeeping, no GPU dependency at all — pairs with {@link "./brick-atlas.js".BrickAtlas}
 * once a later pass wires the two together (shader rewrite, streaming/eviction integration, and
 * accel-structure extension), none of which this class does.
 *
 * **Not yet wired into the renderer.** Nothing in the live render loop constructs or calls this today.
 *
 * @packageDocumentation
 */

/**
 * Identifies a resident brick. Reuses `ResidencyController`'s own key scheme as-is (see
 * `ResidencyController.ts`'s `lastRoiKey`: `` `${level}:${voxelMin.join(",")}:${voxelMax.join(",")}` ``)
 * rather than inventing a new one — whoever wires this table into the residency system can build this
 * key exactly the way it already does today.
 */
export type BrickKey = string;

interface Entry {
  key: BrickKey;
  slot: number;
}

/** Result of {@link BrickPageTable.acquire}. */
export interface AcquireResult {
  /** The atlas slot now holding (or already holding) `key`. */
  slot: number;
  /** The key evicted to make room for `slot`, if any — its atlas contents are now stale and need
   * overwriting before use. `undefined` when `key` was already resident or a free slot was available. */
  evicted: BrickKey | undefined;
}

/**
 * Fixed-capacity LRU map from {@link BrickKey} to atlas slot index. Capacity equals the number of
 * slots the (not-yet-built) atlas texture actually has.
 */
export class BrickPageTable {
  /** Most-recently-used last. */
  private readonly order: Entry[] = [];
  private readonly bySlot: (BrickKey | undefined)[];

  public constructor(public readonly capacity: number) {
    if (capacity <= 0) throw new Error(`BrickPageTable: capacity must be positive, got ${capacity}`);
    this.bySlot = new Array(capacity).fill(undefined);
  }

  /** Number of currently-resident bricks. */
  public get residentCount(): number {
    return this.order.length;
  }

  /** The resident slot for `key`, if any — does not affect LRU order. */
  public resolve(key: BrickKey): number | undefined {
    return this.order.find((e) => e.key === key)?.slot;
  }

  /** Whether `key` currently occupies a slot. */
  public has(key: BrickKey): boolean {
    return this.order.some((e) => e.key === key);
  }

  /**
   * Resolve `key` to a slot, allocating (evicting the LRU entry if full) if not already resident.
   * Re-acquiring an already-resident key marks it most-recently-used and evicts nothing.
   */
  public acquire(key: BrickKey): AcquireResult {
    const existingIndex = this.order.findIndex((e) => e.key === key);
    if (existingIndex !== -1) {
      const [entry] = this.order.splice(existingIndex, 1);
      this.order.push(entry!);
      return { slot: entry!.slot, evicted: undefined };
    }

    if (this.order.length < this.capacity) {
      const slot = this.bySlot.indexOf(undefined);
      this.bySlot[slot] = key;
      this.order.push({ key, slot });
      return { slot, evicted: undefined };
    }

    const lru = this.order.shift()!;
    this.bySlot[lru.slot] = key;
    this.order.push({ key, slot: lru.slot });
    return { slot: lru.slot, evicted: lru.key };
  }

  /** Free `key`'s slot, if resident. A no-op if `key` isn't resident. */
  public release(key: BrickKey): void {
    const index = this.order.findIndex((e) => e.key === key);
    if (index === -1) return;
    const [entry] = this.order.splice(index, 1);
    this.bySlot[entry!.slot] = undefined;
  }
}
