/**
 * Pure validate-and-merge helper for `VolumeRenderer`'s scalar multi-light params: shadow / AO /
 * master-ambient / specular controls for the multi-light path. Deliberately does not own
 * `LightingEnvironment` (`lightEnv`) — that's a GPU resource with a different lifecycle, handled
 * separately.
 *
 * @packageDocumentation
 */

/** Shadow / AO / master-ambient / specular controls for the multi-light path. */
export interface VolumeLightingParams {
  masterAmbient?: number;
  specStrength?: number;
  roughness?: number;
  shadowEnable?: boolean;
  shadowSteps?: number;
  shadowStrength?: number;
  shadowSoftness?: number;
  aoEnable?: boolean;
  aoRadius?: number;
  aoIntensity?: number;
  aoSamples?: number;
}

/** `VolumeRenderer`'s scalar multi-light fields, pre-merge. */
export interface VolumeLightingState {
  masterAmbient: number;
  specStrength: number;
  roughnessL: number;
  shadowEnable: boolean;
  shadowSteps: number;
  shadowStrength: number;
  shadowSoftness: number;
  aoEnable: boolean;
  aoRadius: number;
  aoIntensity: number;
  aoSamples: number;
}

/** Merge `params` onto `current`; `shadowSteps`/`aoSamples` are rounded to a non-negative integer. */
export function applyVolumeLighting(
  current: VolumeLightingState,
  params: VolumeLightingParams,
): VolumeLightingState {
  return {
    masterAmbient: params.masterAmbient ?? current.masterAmbient,
    specStrength: params.specStrength ?? current.specStrength,
    roughnessL: params.roughness ?? current.roughnessL,
    shadowEnable: params.shadowEnable ?? current.shadowEnable,
    shadowSteps:
      params.shadowSteps !== undefined
        ? Math.max(0, Math.round(params.shadowSteps))
        : current.shadowSteps,
    shadowStrength: params.shadowStrength ?? current.shadowStrength,
    shadowSoftness: params.shadowSoftness ?? current.shadowSoftness,
    aoEnable: params.aoEnable ?? current.aoEnable,
    aoRadius: params.aoRadius ?? current.aoRadius,
    aoIntensity: params.aoIntensity ?? current.aoIntensity,
    aoSamples:
      params.aoSamples !== undefined ? Math.max(0, Math.round(params.aoSamples)) : current.aoSamples,
  };
}
