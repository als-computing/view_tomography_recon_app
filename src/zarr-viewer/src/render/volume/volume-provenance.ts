/**
 * Pure derivations for the volume renderer's export provenance. No GPU calls, no class state.
 *
 * @packageDocumentation
 */

import { specializationFor, type ShaderConfigName } from "../accel/shader-config.js";
import type { RenderProvenance } from "../accel/provenance.js";

/**
 * Provenance block for PNG export / screenshot stamping. `taauFrames` and `shadowEnabled` are
 * required (not defaulted) because `VolumeRenderer` doesn't own the TAAU accumulator or know
 * whether the shadow map actually built — the caller must supply the real values.
 */
export function computeProvenance(
  shaderConfig: ShaderConfigName,
  tfHash: string,
  renderScale: number,
  taauFrames: number,
  shadowEnabled: boolean,
  extras?: Partial<RenderProvenance>,
): RenderProvenance {
  const spec = specializationFor(shaderConfig);
  return {
    shaderConfig,
    multiScatterOctaves: spec.multiScatterOctaves,
    taauFrames,
    shadowMode: shadowEnabled ? "light-axis-sweep" : "none",
    transferFunction: tfHash,
    renderScale,
    extendedPreIntegration: spec.preIntegrate,
    ...extras,
  };
}
