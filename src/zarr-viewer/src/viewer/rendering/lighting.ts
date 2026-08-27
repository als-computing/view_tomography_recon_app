/**
 * Pure lighting math: sRGB-hex → linear color, and building the per-frame GPU light list from the
 * viewer's rendering state + camera basis. No GPU calls, no closure state — takes `rendering` and the
 * camera basis vectors as explicit parameters.
 *
 * @packageDocumentation
 */

import { hexToColor3, srgbToLinear, type Color3 } from "@zarr-viewer/math";
import { makeDirectionalLight, makeSpotLight, type GpuLight } from "@zarr-viewer/render";
import type { WebGpuRenderingState } from "../RenderingState.js";

/** sRGB hex (from `<input type="color">`) → linear RGB for the HDR shading path. */
export function hexToLinearRgb(hex: string): Color3 {
  return srgbToLinear(hexToColor3(hex));
}

/**
 * Rebuild the GPU light list from the enabled modes + the camera basis. Global is a fixed-direction
 * directional (also drives the studio env); flashlight is a spot at the eye aimed at the sample;
 * stage lights are four spots pinned to the screen corners aiming inward for even fill.
 */
export function buildFrameLights(
  rendering: WebGpuRenderingState,
  eye: { x: number; y: number; z: number },
  right: readonly [number, number, number],
  up: readonly [number, number, number],
  fwd: readonly [number, number, number],
  extent: number,
): GpuLight[] {
  const lights: GpuLight[] = [];
  if (rendering.lightGlobalOn) {
    const el = (rendering.lightElevation * Math.PI) / 180;
    const az = (rendering.lightAzimuth * Math.PI) / 180;
    const dir: [number, number, number] = [
      Math.cos(el) * Math.cos(az),
      Math.sin(el),
      Math.cos(el) * Math.sin(az),
    ];
    const gl = makeDirectionalLight(dir, hexToLinearRgb(rendering.lightGlobalColor), rendering.lightGlobalIntensity);
    gl.castShadows = rendering.shadowCastGlobal;
    lights.push(gl);
  }
  if (rendering.lightFlashOn) {
    const outer = (rendering.flashConeDeg * Math.PI) / 180;
    // True camera headlight: positioned exactly at the eye (canvas center) and pointed forward along
    // the camera's view direction, so it tracks the camera 1:1. No offset, no pull-back.
    const fl = makeSpotLight(
      [eye.x, eye.y, eye.z],
      [fwd[0], fwd[1], fwd[2]], // forward into the scene (camera view direction)
      hexToLinearRgb(rendering.lightFlashColor),
      rendering.lightFlashIntensity,
      { range: extent * rendering.flashRange, innerConeAngle: outer * 0.7, outerConeAngle: outer },
    );
    fl.castShadows = rendering.shadowCastFlash;
    lights.push(fl);
  }
  if (rendering.lightStageOn) {
    const d = extent * 2.2; // in front of the eye along the view axis
    const k = extent * 1.7; // corner spread
    const col = hexToLinearRgb(rendering.lightStageColor);
    const outer = (rendering.stageConeDeg * Math.PI) / 180;
    const corners: [number, number][] = [
      [-1, -1],
      [1, -1],
      [-1, 1],
      [1, 1],
    ];
    for (const [sx, sy] of corners) {
      const pos: [number, number, number] = [
        eye.x + fwd[0] * d + right[0] * k * sx + up[0] * k * sy,
        eye.y + fwd[1] * d + right[1] * k * sx + up[1] * k * sy,
        eye.z + fwd[2] * d + right[2] * k * sx + up[2] * k * sy,
      ];
      const sl = makeSpotLight(pos, [-pos[0], -pos[1], -pos[2]], col, rendering.lightStageIntensity, {
        range: extent * rendering.stageRange,
        innerConeAngle: outer * 0.7,
        outerConeAngle: outer,
      });
      sl.castShadows = rendering.shadowCastStage;
      lights.push(sl);
    }
  }
  return lights;
}
