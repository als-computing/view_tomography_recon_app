/**
 * Pure validate-and-merge helpers for `VolumeRenderer`'s low-coupling shading parameter bags:
 * dielectric liquid shading, the camera-linked measure plane, and the legacy single-light
 * Blinn-Phong params. Each `applyXxx` takes the renderer's current state plus a partial params
 * object and returns the next state — clamping/defaulting is centralized here instead of inline
 * in the setter, so it's testable without a GPU context.
 *
 * @packageDocumentation
 */

import { asColor3, type Color3, type Color3Like } from "@zarr-viewer/math";

/** Dielectric liquid shading for CGI-style water / oil / steam volumes. */
export interface LiquidShadingParams {
  /** Enable Fresnel + env + Beer dielectric path (default false = legacy TF Phong). */
  enabled?: boolean;
  /** Index of refraction (water ≈ 1.333, oil ≈ 1.47). Default `1.333`. */
  ior?: number;
  /** Microfacet roughness for free-surface specular. Default `0.04`. */
  roughness?: number;
  /** Scales procedural studio environment. Default `1.2`. */
  envIntensity?: number;
  /** Beer–Lambert absorption path scale. Default `2.5`. */
  absorptionScale?: number;
}

/** `VolumeRenderer`'s liquid-shading fields, pre-merge. */
export interface LiquidShadingState {
  enabled: boolean;
  ior: number;
  roughness: number;
  envIntensity: number;
  absorptionScale: number;
}

/** Merge `params` onto `current`, clamping each field to its valid range. */
export function applyLiquidShading(
  current: LiquidShadingState,
  params: LiquidShadingParams,
): LiquidShadingState {
  return {
    enabled: params.enabled ?? current.enabled,
    ior: params.ior !== undefined ? Math.min(3.5, Math.max(1.0, params.ior)) : current.ior,
    roughness:
      params.roughness !== undefined
        ? Math.min(1, Math.max(0.012, params.roughness))
        : current.roughness,
    envIntensity:
      params.envIntensity !== undefined
        ? Math.max(0, params.envIntensity)
        : current.envIntensity,
    absorptionScale:
      params.absorptionScale !== undefined
        ? Math.max(0.05, params.absorptionScale)
        : current.absorptionScale,
  };
}

/**
 * Camera-linked measure plane: a fronto-parallel grey sheet composited in depth with the volume.
 * `depth` is world distance from the eye along `forward` (a unit view-axis vector); `gray`/`alpha`
 * in `[0, 1]`.
 */
export interface MeasurePlaneParams {
  enabled: boolean;
  depth: number;
  gray: number;
  alpha: number;
  forward: readonly [number, number, number];
}

/** `VolumeRenderer`'s measure-plane fields, pre-merge. */
export interface MeasurePlaneState {
  enabled: boolean;
  depth: number;
  gray: number;
  alpha: number;
  forward: [number, number, number];
}

/** `setMeasurePlane` is a full replace (called every frame with the current camera forward). */
export function applyMeasurePlane(params: MeasurePlaneParams): MeasurePlaneState {
  return {
    enabled: params.enabled,
    depth: params.depth,
    gray: params.gray,
    alpha: params.alpha,
    forward: [params.forward[0], params.forward[1], params.forward[2]],
  };
}

/** Legacy single-light Blinn-Phong params (superseded by the multi-light path, kept for compat). */
export interface LegacyLightParams {
  ambient?: number;
  specularPower?: number;
  lightDirection?: readonly [number, number, number];
  lightColor?: Color3Like;
}

/** `VolumeRenderer`'s legacy-light fields, pre-merge. */
export interface LegacyLightState {
  ambient: number;
  specularPower: number;
  lightDirection: [number, number, number];
  lightColor: Color3;
}

/** Merge `params` onto `current`. */
export function applyLegacyLight(
  current: LegacyLightState,
  params: LegacyLightParams,
): LegacyLightState {
  return {
    ambient: params.ambient ?? current.ambient,
    specularPower: params.specularPower ?? current.specularPower,
    lightDirection: params.lightDirection
      ? ([...params.lightDirection] as [number, number, number])
      : current.lightDirection,
    lightColor: params.lightColor ? asColor3(params.lightColor) : current.lightColor,
  };
}
