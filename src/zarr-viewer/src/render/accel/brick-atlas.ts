/**
 * A single large 3D texture partitioned into a fixed grid of equal-size brick slots (item 8,
 * foundation-only pass — see the plan file). Pairs with {@link "./brick-page-table.js".BrickPageTable},
 * which decides which slot a given brick occupies; this class only owns the GPU texture and knows how
 * to compute a slot's voxel origin and upload data into it.
 *
 * **Not yet wired into the renderer.** Nothing samples this texture or calls `uploadToSlot` today; no
 * production slot-size/count is chosen here either — the current single-ROI-brick system uses
 * dynamically-sized brick regions, and adapting that to a fixed-size slot grid is a real design
 * decision left to whoever does the shader-wiring pass.
 *
 * @packageDocumentation
 */

import { ManagedTexture, bytesPerTexel } from "../resources/texture.js";

/** A voxel-space origin `[x, y, z]`. */
export type VoxelOrigin = readonly [number, number, number];

/**
 * Owns one `ManagedTexture` sized `(slotsX*slotSize) × (slotsY*slotSize) × (slotsZ*slotSize)`, logically
 * divided into `slotsX * slotsY * slotsZ` equal-size cubic slots, each `slotSize` voxels per axis.
 */
export class BrickAtlas {
  public readonly texture: ManagedTexture;

  public constructor(
    device: GPUDevice,
    public readonly slotsX: number,
    public readonly slotsY: number,
    public readonly slotsZ: number,
    public readonly slotSize: number,
    format: GPUTextureFormat,
  ) {
    this.texture = new ManagedTexture(device, {
      size: [slotsX * slotSize, slotsY * slotSize, slotsZ * slotSize],
      format,
      dimension: "3d",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
  }

  /** Total slot capacity of this atlas. */
  public get capacity(): number {
    return this.slotsX * this.slotsY * this.slotsZ;
  }

  /** The voxel-space origin of `slotIndex` within the atlas texture (row-major: x fastest, then y, then z). */
  public slotVoxelOrigin(slotIndex: number): VoxelOrigin {
    const sx = slotIndex % this.slotsX;
    const sy = Math.floor(slotIndex / this.slotsX) % this.slotsY;
    const sz = Math.floor(slotIndex / (this.slotsX * this.slotsY));
    return [sx * this.slotSize, sy * this.slotSize, sz * this.slotSize];
  }

  /**
   * Upload `data` (exactly `slotSize³` texels, row-major x-fastest, tightly packed — no row padding;
   * this computes `bytesPerRow`/`rowsPerImage` for the caller) into `slotIndex`'s region of the atlas.
   */
  public uploadToSlot(device: GPUDevice, slotIndex: number, data: BufferSource): void {
    const [ox, oy, oz] = this.slotVoxelOrigin(slotIndex);
    const bytesPerRow = this.slotSize * bytesPerTexel(this.texture.desc.format);
    device.queue.writeTexture(
      { texture: this.texture.gpu, origin: { x: ox, y: oy, z: oz } },
      data,
      { bytesPerRow, rowsPerImage: this.slotSize },
      { width: this.slotSize, height: this.slotSize, depthOrArrayLayers: this.slotSize },
    );
  }

  public dispose(): void {
    this.texture.dispose();
  }
}
