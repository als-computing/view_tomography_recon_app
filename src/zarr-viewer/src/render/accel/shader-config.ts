/**
 * Bounded volume-shader specialization: a small curated set of named configs rather than a flag
 * product space. Innermost-loop features (occupancy / distance-field traversal) are compile-time;
 * once-per-sample or once-per-frame features (visibility feedback, shadows) stay as runtime branches.
 *
 * Approximate-shading techniques (multi-scatter octaves, bent-normal ambient) live only in
 * {@link ShaderConfigName.quality} and are never on by default — see the provenance requirements.
 *
 * @packageDocumentation
 */

/** Named shader configuration. Default is {@link ShaderConfigName.baseline}. */
export type ShaderConfigName = "baseline" | "fast" | "quality";

/** Compile-time specialization derived from a named config. */
export interface ShaderSpecialization {
  /** Occupancy-grid HDDA + Chebyshev empty-space skip + majorant step (Milestone 4). */
  occupancy: boolean;
  /** Draw-indirect instanced tile quads instead of a fullscreen triangle (Milestone 4.5). */
  tiles: boolean;
  /**
   * Multi-scatter octaves (Milestone 7.3): cheap Wrenninge-style octaves that soften shadows with a
   * multi-scatter glow (0 = off). Quality-config only — an artistic approximation, so it is provenance-
   * stamped on export and labeled on-screen while active.
   */
  multiScatterOctaves: number;
  /** Bent-normal (directional env) ambient term (Milestone 7.2). Quality-config only; provenance-stamped. */
  bentNormalAmbient: boolean;
  /**
   * Analytic pre-integration (Milestone 3.1): composite each segment with the exact optical-depth
   * integral (epsilon-guarded ratio / midpoint-limit forms over a cumulative-extinction LUT) instead of
   * point-sampling `1-exp(-σ·step)`. Reduces slicing/banding under the large majorant steps `occupancy`
   * takes. Enabled for `quality`; converges to the point-sampled result as step → 0.
   */
  preIntegrate: boolean;
}

/**
 * Human-readable shadow representation names for provenance stamps. `light-axis-sweep` is the one
 * currently implemented ({@link ../shadow-map.js}): a light-space opacity map built by marching along
 * the light axis — softer / lower depth-resolution than AVSM, but robust and cheap. `macrocell-sweep`,
 * `fom`, and `avsm` are named for future representations discussed in the acceleration plan; do not
 * report them unless the corresponding implementation actually exists.
 */
export type ShadowRepresentation = "none" | "light-axis-sweep" | "macrocell-sweep" | "fom" | "avsm";

/**
 * Compile-time features for `name`. `baseline` matches the pre-acceleration shader; `fast` and
 * `quality` enable occupancy + tile compaction. Approximate shading is reserved for `quality`.
 */
export function specializationFor(name: ShaderConfigName): ShaderSpecialization {
  const accel = name === "fast" || name === "quality";
  const quality = name === "quality";
  return {
    occupancy: accel,
    // Tile compaction (Milestone 4.5): draw-indirect tile march + a fullscreen background pass for the
    // culled pixels. This is the big win when the volume is small on screen (zoomed out) — most tiles are
    // background and never pay the march. The background pass must paint EXACTLY what the march paints for
    // a miss pixel (same envRadiance, same camera-basis ray) or the coverage boundary seams; that is now
    // enforced in VOLUME_BACKGROUND_WGSL. The screen-AABB classifier pads by a tile and keeps all tiles
    // when any corner is behind the camera, so it never under-covers the silhouette.
    tiles: accel,
    // Milestone 7: approximate (artistic) shading lives ONLY in `quality`, never default — see the
    // provenance requirement. Two octaves of cheap multi-scatter + a directional (bent-normal) ambient.
    multiScatterOctaves: quality ? 2 : 0,
    bentNormalAmbient: quality,
    // Milestone 3.1: quality-only for now (baseline/fast stay the exact reference); extend to `fast`
    // once validated, since occupancy's large steps are exactly where pre-integration pays off.
    preIntegrate: quality,
  };
}

/**
 * True when any artistic / approximate-shading feature is active. Used to drive the visible
 * viewport label — not a settings-panel footnote.
 */
export function approximateShadingActive(spec: ShaderSpecialization): boolean {
  return spec.multiScatterOctaves > 0 || spec.bentNormalAmbient;
}

/** Short viewport banner when approximate shading is on; `null` otherwise. */
export function approximateShadingLabel(spec: ShaderSpecialization): string | null {
  if (!approximateShadingActive(spec)) return null;
  const bits: string[] = [];
  if (spec.multiScatterOctaves > 0) {
    bits.push(`multi-scatter ×${spec.multiScatterOctaves}`);
  }
  if (spec.bentNormalAmbient) bits.push("bent-normal ambient");
  return `Approximate shading: ${bits.join(", ")}`;
}
