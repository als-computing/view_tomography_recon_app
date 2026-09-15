/**
 * Data model for composited volume "layers" (item 7 of the feature plan): an unbounded, user-facing
 * list of layer records mapped onto a small, fixed pool of real GPU slots. WebGPU has no 3D texture
 * arrays and no reliable bindless-texture support, so a layer's density volume must occupy one fixed
 * bind-group slot — {@link MAX_LAYERS} is that hard ceiling. The HUD list itself stays unbounded: a
 * layer beyond the cap (or a disabled one) simply holds `gpuSlot: null` and isn't composited until a
 * slot frees up.
 *
 * Pure state only — no GPU/network calls. {@link LayerManager} just tracks records and slot
 * assignment; loading a dataset into a slot's texture is a separate concern layered on top of this.
 *
 * @packageDocumentation
 */

import { MAX_LAYERS } from "@zarr-viewer/render";

export { MAX_LAYERS };

/** One entry in the layer list. `gpuSlot` is `null` when disabled or when the slot pool is full. */
export interface LayerRecord {
  readonly id: string;
  name: string;
  opacity: number;
  enabled: boolean;
  gpuSlot: number | null;
}

/**
 * Owns the ordered layer list and its mapping onto `0..MAX_LAYERS-1` GPU slots. A layer that already
 * holds a valid slot keeps it across other layers' add/remove/enable changes — slot index doubles as
 * the shader's fixed compositing order (see the plan's "compositing-order caveat"), so reshuffling
 * slots on unrelated changes would cause visible order flicker.
 */
export class LayerManager {
  private readonly layers: LayerRecord[] = [];
  private nextId = 1;

  /** Layers in display/list order (not GPU slot order). */
  public list(): readonly LayerRecord[] {
    return this.layers;
  }

  /** Add a new, enabled layer, assigning it the lowest free slot (or `null` if the pool is full). */
  public add(name: string, opacity = 1): LayerRecord {
    const record: LayerRecord = {
      id: `layer-${this.nextId++}`,
      name,
      opacity: Math.min(1, Math.max(0, opacity)),
      enabled: true,
      gpuSlot: null,
    };
    this.layers.push(record);
    this.reassignSlots();
    return record;
  }

  public remove(id: string): void {
    const idx = this.layers.findIndex((l) => l.id === id);
    if (idx === -1) return;
    this.layers.splice(idx, 1);
    this.reassignSlots();
  }

  public setEnabled(id: string, enabled: boolean): void {
    const record = this.layers.find((l) => l.id === id);
    if (!record || record.enabled === enabled) return;
    record.enabled = enabled;
    this.reassignSlots();
  }

  public setOpacity(id: string, opacity: number): void {
    const record = this.layers.find((l) => l.id === id);
    if (record) record.opacity = Math.min(1, Math.max(0, opacity));
  }

  /**
   * Re-derive slot assignment: layers that already hold a valid slot keep it; disabled layers are
   * cleared to `null`; remaining enabled-but-unslotted layers fill the lowest free slots, in list
   * order, until the pool (`MAX_LAYERS`) is exhausted.
   */
  private reassignSlots(): void {
    const used = new Set<number>();
    for (const l of this.layers) {
      if (l.enabled && l.gpuSlot !== null) used.add(l.gpuSlot);
    }
    for (const l of this.layers) {
      if (!l.enabled) {
        l.gpuSlot = null;
        continue;
      }
      if (l.gpuSlot !== null) continue; // already holds a valid slot
      let assigned = false;
      for (let slot = 0; slot < MAX_LAYERS; slot++) {
        if (!used.has(slot)) {
          l.gpuSlot = slot;
          used.add(slot);
          assigned = true;
          break;
        }
      }
      if (!assigned) l.gpuSlot = null; // pool full — stays listed, not composited
    }
  }
}
