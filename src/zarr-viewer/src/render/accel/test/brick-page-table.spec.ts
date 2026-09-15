import { describe, it, expect } from "vitest";
import { BrickPageTable } from "../brick-page-table.js";

describe("BrickPageTable", () => {
  it("assigns free slots and reports capacity/residentCount", () => {
    const table = new BrickPageTable(3);
    expect(table.capacity).toBe(3);
    expect(table.residentCount).toBe(0);

    const a = table.acquire("a");
    const b = table.acquire("b");
    expect(a.evicted).toBeUndefined();
    expect(b.evicted).toBeUndefined();
    expect(a.slot).not.toBe(b.slot);
    expect(table.residentCount).toBe(2);
  });

  it("resolve/has reflect current residency without changing LRU order", () => {
    const table = new BrickPageTable(2);
    table.acquire("a");
    expect(table.has("a")).toBe(true);
    expect(table.has("z")).toBe(false);
    expect(table.resolve("a")).toBe(0);
    expect(table.resolve("z")).toBeUndefined();
  });

  it("re-acquiring an already-resident key returns its slot, evicts nothing, and marks it MRU", () => {
    const table = new BrickPageTable(2);
    const a = table.acquire("a");
    table.acquire("b");
    const reacquired = table.acquire("a");
    expect(reacquired.slot).toBe(a.slot);
    expect(reacquired.evicted).toBeUndefined();

    // "a" is now MRU, "b" is LRU — filling the table should evict "b" next, not "a".
    const c = table.acquire("c");
    expect(c.evicted).toBe("b");
  });

  it("evicts the least-recently-used entry when full, and reuses its slot", () => {
    const table = new BrickPageTable(2);
    const a = table.acquire("a");
    table.acquire("b");
    const c = table.acquire("c"); // full — "a" is LRU, evicted
    expect(c.evicted).toBe("a");
    expect(c.slot).toBe(a.slot);
    expect(table.has("a")).toBe(false);
    expect(table.has("b")).toBe(true);
    expect(table.has("c")).toBe(true);
    expect(table.residentCount).toBe(2);
  });

  it("release frees a slot for reuse and is a no-op for a non-resident key", () => {
    const table = new BrickPageTable(1);
    const a = table.acquire("a");
    expect(() => table.release("nonexistent")).not.toThrow();
    table.release("a");
    expect(table.has("a")).toBe(false);
    expect(table.residentCount).toBe(0);
    const b = table.acquire("b");
    expect(b.slot).toBe(a.slot);
    expect(b.evicted).toBeUndefined();
  });

  it("throws on a non-positive capacity", () => {
    expect(() => new BrickPageTable(0)).toThrow();
    expect(() => new BrickPageTable(-1)).toThrow();
  });
});
