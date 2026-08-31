/**
 * The viewer's canonical, serializable state groups: everything that shapes the volume's appearance
 * ({@link WebGpuRenderingState}) and the ROI crop box / slice planes ({@link WebGpuCroppingState}).
 * These are the exact shape `WebGpuViewerInstance.getRendering()`/`getCropping()` return and
 * `setRendering()`/`setCropping()` accept — a stable external contract shared with `main.ts`,
 * `WebGpuNative.tsx`, and `useLinkedWebGpuViewers.ts` (multi-pane linking).
 *
 * @packageDocumentation
 */

import {
  DEFAULT_OPACITY_POINTS,
  type ColorMapName,
  type OpacityPoint,
  type VolumeBlendMode,
  type VolumeViewMode,
  type ShaderConfigName,
} from "@zarr-viewer/render";
import type { ToneMapOperator } from "@zarr-viewer/fx";

/** Everything that shapes the volume's appearance (transfer function + render params + view mode). */
export interface WebGpuRenderingState {
  colorMap: ColorMapName;
  colorLo: number;
  colorHi: number;
  equalizeOn: boolean;
  equalizeClip: number;
  opacityScale: number;
  opacityPoints: OpacityPoint[];
  densityScale: number;
  exposure: number;
  sampleDist: number;
  blendMode: VolumeBlendMode;
  gradOpacity: number;
  gradScale: number;
  lighting: number;
  viewMode: VolumeViewMode;
  // Post-processing FX (tonemap is always applied; the rest are toggle-gated).
  fxOperator: ToneMapOperator;
  fxExposure: number;
  fxBloom: boolean;
  fxBloomThreshold: number;
  fxBloomIntensity: number;
  fxFxaa: boolean;
  fxSharpen: boolean;
  fxSharpenAmount: number;
  fxVignette: boolean;
  fxVignetteAmount: number;
  // Lighting: per-mode on/off + color (sRGB hex) + intensity, shading params, shadows, AO, half-res.
  lightGlobalOn: boolean;
  lightGlobalColor: string;
  lightGlobalIntensity: number;
  lightAzimuth: number;
  lightElevation: number;
  lightFlashOn: boolean;
  lightFlashColor: string;
  lightFlashIntensity: number;
  lightStageOn: boolean;
  lightStageColor: string;
  lightStageIntensity: number;
  lightAmbient: number;
  lightSpecular: number;
  lightRoughness: number;
  shadowOn: boolean;
  shadowQuality: number;
  shadowStrength: number;
  shadowSoftness: number;
  shadowCastGlobal: boolean;
  shadowCastFlash: boolean;
  shadowCastStage: boolean;
  aoOn: boolean;
  aoRadius: number;
  aoIntensity: number;
  aoSamples: number;
  flashConeDeg: number;
  flashRange: number;
  stageConeDeg: number;
  stageRange: number;
  halfRes: boolean;
  temporalAA: boolean;
  /** Milestone 6 (B3), opt-in: composite the half-res G-buffer lighting pass (bilateral-upsampled)
   * instead of the default full per-sample shadow/AO/multi-scatter evaluation. Default off so the two
   * paths stay A/B-comparable. */
  gbufferLighting: boolean;
  shaderConfig: ShaderConfigName;
  measurePlaneOn: boolean;
  measureDepth: number;
  measurePlaneGray: number;
  measurePlaneAlpha: number;
  /** Invert horizontal/vertical orbit drag direction. Both default off (unchanged behavior) — an
   * opt-in fix for users who find the default direction backwards. */
  invertOrbitX: boolean;
  invertOrbitY: boolean;
}

/** The ROI crop box plus the slice planes (positions, per-axis enables, overlay visibility). */
export interface WebGpuCroppingState {
  cropMin: [number, number, number];
  cropMax: [number, number, number];
  sliceX: number;
  sliceY: number;
  sliceZ: number;
  enX: boolean;
  enY: boolean;
  enZ: boolean;
  showPlanes: boolean;
}

/**
 * Default rendering state. Reproduces the viewer's original look: bone colormap, ACES tonemap at
 * exposure 0, one warm global directional light, everything else (FX extras, flashlight/stage,
 * shadows, AO, half-res, TAAU) off.
 */
export function defaultRenderingState(): WebGpuRenderingState {
  return {
    colorMap: "bone",
    colorLo: 0.15,
    colorHi: 0.85,
    equalizeOn: false,
    equalizeClip: 2,
    opacityScale: 1,
    opacityPoints: [...DEFAULT_OPACITY_POINTS],
    densityScale: 1.45,
    exposure: 1.2,
    sampleDist: 1,
    blendMode: "composite",
    gradOpacity: 0.25,
    gradScale: 0.12,
    lighting: 0.85,
    viewMode: "volume",
    fxOperator: "aces",
    fxExposure: 0,
    fxBloom: false,
    fxBloomThreshold: 1.1,
    fxBloomIntensity: 0.6,
    fxFxaa: false,
    fxSharpen: false,
    fxSharpenAmount: 0.5,
    fxVignette: false,
    fxVignetteAmount: 0.4,
    lightGlobalOn: true,
    lightGlobalColor: "#fff2e0",
    lightGlobalIntensity: 1,
    lightAzimuth: 38, // degrees
    lightElevation: 56, // degrees
    lightFlashOn: false,
    lightFlashColor: "#ffffff",
    lightFlashIntensity: 1.2,
    lightStageOn: false,
    lightStageColor: "#cfe0ff",
    lightStageIntensity: 0.6,
    lightAmbient: 0.22,
    lightSpecular: 0.4,
    lightRoughness: 0.6,
    shadowOn: false,
    shadowQuality: 24,
    shadowStrength: 0.85,
    shadowSoftness: 0.3,
    shadowCastGlobal: true,
    shadowCastFlash: true,
    shadowCastStage: false,
    aoOn: false,
    aoRadius: 0.08,
    aoIntensity: 0.7,
    aoSamples: 6,
    flashConeDeg: 79,
    flashRange: 6,
    stageConeDeg: 86,
    stageRange: 8,
    halfRes: true, // adaptive: only applies while navigating (see WebGpuVolumeViewer.ts's `settled`)
    temporalAA: true, // Milestone 5: accumulate a clean supersampled image while the camera is still
    gbufferLighting: true, // Milestone 6 (B3), adaptive: only applies while navigating
    shaderConfig: "baseline",
    measurePlaneOn: false,
    measureDepth: 0.5, // 0..1 fraction across the volume's depth footprint (0 = front face, 1 = back)
    measurePlaneGray: 0.6, // plane greyscale value [0,1]
    measurePlaneAlpha: 0.35, // plane opacity [0,1]
    invertOrbitX: false,
    invertOrbitY: false,
  };
}

/** Default cropping state: no crop, no active slice planes, centered slice positions. */
export function defaultCroppingState(): WebGpuCroppingState {
  return {
    cropMin: [0, 0, 0],
    cropMax: [1, 1, 1],
    sliceX: 0.5,
    sliceY: 0.5,
    sliceZ: 0.5,
    enX: false,
    enY: false,
    enZ: false,
    showPlanes: false,
  };
}

/** Copy every field of `patch` whose value isn't `undefined` onto `target`, in place. */
export function mergeDefined<T extends object>(target: T, patch: Partial<T>): void {
  for (const key of Object.keys(patch) as (keyof T)[]) {
    const value = patch[key];
    if (value !== undefined) target[key] = value;
  }
}
