/**
 * Helpers over a {@link GpuLight} list. The `extractLightsFromScene` path from prism (scene-graph
 * `LightComponent` → GpuLight) is omitted here: this viewer builds its light set procedurally from
 * the camera each frame (global / flashlight / stage), so only the key-light bridge is kept.
 *
 * @packageDocumentation
 */

import type { GpuLight } from "./types.js";

/** First directional light, or a default key if none. */
export function keyDirectionalFromLights(
  lights: readonly GpuLight[],
): { dir: readonly [number, number, number]; color: readonly [number, number, number]; intensity: number } {
  for (const L of lights) {
    if (L.positionKind[3] === 0) {
      return {
        dir: [L.directionRange[0]!, L.directionRange[1]!, L.directionRange[2]!],
        color: [L.colorIntensity[0]!, L.colorIntensity[1]!, L.colorIntensity[2]!],
        intensity: L.colorIntensity[3]!,
      };
    }
  }
  return { dir: [0.4, 1, 0.5], color: [1, 1, 1], intensity: 1 };
}
