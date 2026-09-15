import { describe, it, expect } from "vitest";
import { LayerManager, MAX_LAYERS } from "../layer-manager.js";

describe("LayerManager", () => {
  it("assigns each of the first MAX_LAYERS added layers a unique slot", () => {
    const mgr = new LayerManager();
    const records = Array.from({ length: MAX_LAYERS }, (_, i) => mgr.add(`layer-${i}`));
    const slots = records.map((r) => r.gpuSlot);
    expect(new Set(slots).size).toBe(MAX_LAYERS);
    for (const s of slots) expect(s).not.toBeNull();
  });

  it("leaves a layer beyond MAX_LAYERS unslotted instead of failing or bumping another layer", () => {
    const mgr = new LayerManager();
    for (let i = 0; i < MAX_LAYERS; i++) mgr.add(`layer-${i}`);
    const overflow = mgr.add("overflow");
    expect(overflow.gpuSlot).toBeNull();
    expect(mgr.list()).toHaveLength(MAX_LAYERS + 1);
    // Every previously-assigned layer keeps its slot - the overflow add doesn't reshuffle anything.
    for (const l of mgr.list().slice(0, MAX_LAYERS)) expect(l.gpuSlot).not.toBeNull();
  });

  it("frees a slot on remove so a previously-overflowed layer can claim it", () => {
    const mgr = new LayerManager();
    const first = Array.from({ length: MAX_LAYERS }, (_, i) => mgr.add(`layer-${i}`));
    const overflow = mgr.add("overflow");
    expect(overflow.gpuSlot).toBeNull();

    mgr.remove(first[0]!.id);
    expect(overflow.gpuSlot).not.toBeNull();
  });

  it("frees a slot on disable and reassigns it (without touching unrelated layers' slots)", () => {
    const mgr = new LayerManager();
    const a = mgr.add("a");
    const b = mgr.add("b");
    const aSlot = a.gpuSlot;
    const bSlot = b.gpuSlot;

    mgr.setEnabled(a.id, false);
    expect(a.gpuSlot).toBeNull();
    expect(b.gpuSlot).toBe(bSlot); // untouched

    mgr.setEnabled(a.id, true);
    expect(a.gpuSlot).not.toBeNull();
    expect(b.gpuSlot).toBe(bSlot); // still untouched by re-enabling a
    expect(a.gpuSlot).toBe(aSlot); // its original slot was free, so it gets it back
  });

  it("keeps an already-slotted layer's slot stable across unrelated add/remove churn", () => {
    const mgr = new LayerManager();
    const a = mgr.add("a");
    const stableSlot = a.gpuSlot;
    const b = mgr.add("b");
    mgr.remove(b.id);
    const c = mgr.add("c");
    expect(a.gpuSlot).toBe(stableSlot);
    expect(c.gpuSlot).not.toBeNull();
    expect(c.gpuSlot).not.toBe(stableSlot);
  });

  it("setOpacity clamps to [0,1] and setEnabled/remove on an unknown id is a no-op", () => {
    const mgr = new LayerManager();
    const a = mgr.add("a", 0.5);
    mgr.setOpacity(a.id, 5);
    expect(a.opacity).toBe(1);
    mgr.setOpacity(a.id, -5);
    expect(a.opacity).toBe(0);
    expect(() => mgr.setEnabled("nope", false)).not.toThrow();
    expect(() => mgr.remove("nope")).not.toThrow();
    expect(mgr.list()).toHaveLength(1);
  });
});
