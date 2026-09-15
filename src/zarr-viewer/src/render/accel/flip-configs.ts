/**
 * Fixed camera / transfer-function / blend-mode configurations for the ℲLIP regression harness.
 *
 * The four named failure modes three review rounds identified are required:
 *  - `alpha-spike` — thin-feature popping (narrow alpha spike in the TF)
 *  - `low-opacity` — undefined-depth-centroid case (transparent window that never reaches α=0.5)
 *  - `mip` — no coherent depth (MIP blend)
 *  - `dense-flat` — mip mean/meanSq cancellation (high-density, low-variance core)
 *
 * Plus four more covering baseline composite, crop, dielectric-off lighting, and a second camera.
 *
 * @packageDocumentation
 */

import type { VolumeBlendMode } from "../volume/volume-renderer.js";

/** One frozen view the harness renders and asserts ℲLIP against. */
export interface FlipConfig {
  /** Stable id used as the golden-image stem. */
  id: string;
  /** What this config is here to catch. */
  description: string;
  blendMode: VolumeBlendMode;
  /** Orbit yaw / pitch in radians, radius in world units. */
  camera: { yaw: number; pitch: number; radius: number };
  /**
   * Window/level TF in normalized density. `spike` places a narrow alpha peak at `center` with
   * `width` (the thin-feature case). `window` is a radiology window.
   */
  tf:
    | { kind: "window"; center: number; width: number; opacity: number }
    | { kind: "spike"; center: number; width: number; opacity: number };
  /** Mean ℲLIP above this vs the committed golden fails CI. */
  maxMeanFlip: number;
}

/**
 * Eight harness configurations. Thresholds start loose enough that a first golden capture can
 * land; tighten after the baseline images are committed.
 */
export const FLIP_CONFIGS: readonly FlipConfig[] = [
  {
    id: "alpha-spike",
    description: "Narrow alpha spike on the thin shell — thin-feature popping",
    blendMode: "composite",
    camera: { yaw: 0.4, pitch: 0.25, radius: 1.8 },
    tf: { kind: "spike", center: 1.0, width: 0.04, opacity: 0.95 },
    maxMeanFlip: 0.1,
  },
  {
    id: "low-opacity",
    description: "Low-opacity transparent window — no α=0.5 crossing",
    blendMode: "composite",
    camera: { yaw: 0.4, pitch: 0.25, radius: 1.8 },
    tf: { kind: "window", center: 0.8, width: 0.5, opacity: 0.08 },
    maxMeanFlip: 0.1,
  },
  {
    id: "mip",
    description: "MIP blend — no coherent single-surface depth",
    blendMode: "mip",
    camera: { yaw: 0.4, pitch: 0.25, radius: 1.8 },
    tf: { kind: "window", center: 0.5, width: 0.9, opacity: 1 },
    maxMeanFlip: 0.1,
  },
  {
    id: "dense-flat",
    description: "High-density low-variance core — mip mean/meanSq cancellation",
    blendMode: "composite",
    camera: { yaw: 0.15, pitch: 0.1, radius: 1.35 },
    tf: { kind: "window", center: 0.8, width: 0.15, opacity: 0.9 },
    maxMeanFlip: 0.1,
  },
  {
    id: "composite-baseline",
    description: "Default composite window on the synthetic volume",
    blendMode: "composite",
    camera: { yaw: 0.6, pitch: 0.35, radius: 2.0 },
    tf: { kind: "window", center: 0.5, width: 0.7, opacity: 0.7 },
    maxMeanFlip: 0.1,
  },
  {
    id: "minip",
    description: "MinIP blend mode",
    blendMode: "minip",
    camera: { yaw: 0.4, pitch: 0.25, radius: 1.8 },
    tf: { kind: "window", center: 0.5, width: 0.9, opacity: 1 },
    maxMeanFlip: 0.1,
  },
  {
    id: "average",
    description: "Average blend mode",
    blendMode: "average",
    camera: { yaw: 0.4, pitch: 0.25, radius: 1.8 },
    tf: { kind: "window", center: 0.5, width: 0.9, opacity: 0.8 },
    maxMeanFlip: 0.1,
  },
  {
    id: "side-view",
    description: "Second camera (side) with a mid window — pose regression",
    blendMode: "composite",
    camera: { yaw: 1.4, pitch: -0.2, radius: 2.2 },
    tf: { kind: "window", center: 0.45, width: 0.4, opacity: 0.75 },
    maxMeanFlip: 0.1,
  },
];

/** Build a 256-entry RGBA8 LUT for a harness TF. */
export function flipConfigToLut(tf: FlipConfig["tf"], lutSize = 256): Uint8Array {
  const lut = new Uint8Array(lutSize * 4);
  for (let i = 0; i < lutSize; i++) {
    const t = i / (lutSize - 1);
    let a = 0;
    if (tf.kind === "spike") {
      const d = Math.abs(t - tf.center);
      a = d < tf.width * 0.5 ? tf.opacity * (1 - d / (tf.width * 0.5)) : 0;
    } else {
      const lo = tf.center - tf.width * 0.5;
      const hi = tf.center + tf.width * 0.5;
      if (t >= lo && t <= hi) {
        const u = (t - lo) / Math.max(tf.width, 1e-6);
        const shoulder = Math.min(u, 1 - u) * 2;
        a = tf.opacity * Math.min(1, shoulder / 0.3);
      }
    }
    const o = i * 4;
    lut[o] = 242;
    lut[o + 1] = 209;
    lut[o + 2] = 173;
    lut[o + 3] = Math.round(Math.min(1, Math.max(0, a)) * 255);
  }
  return lut;
}
