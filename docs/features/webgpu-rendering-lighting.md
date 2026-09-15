# WebGPU Viewer — Rendering & Lighting

These controls live under the **⚙ Render settings** tab.

## Render panel

- **Blend mode** — how samples along each ray combine:
    - **composite** — standard alpha-blended volume compositing (the default look).
    - **TF-weighted MIP** — maximum-intensity projection of the transfer function's alpha-weighted
      color (not a literal scalar-density max — named to be precise about that).
    - **minip** — minimum-intensity projection.
    - **TF-weighted average** — average of the TF's alpha-weighted color along the ray.
- **Shader config** — **baseline / fast / quality**. `baseline` is a plain ray march. `fast` and
  `quality` add empty-space skipping and tiled drawing, which speed things up on data with a lot of
  empty margin; `quality` is reserved for upcoming cinematic shading and currently behaves like `fast`.
- **Export PNG (stamped)** — saves a screenshot of the current render, stamped with metadata.
- **Sample dist** — ray-march step size. Lower = higher quality, slower.
- **Density** — overall density scaling applied to the volume.
- **Exposure** — brightness multiplier for the volume render itself (separate from Post FX's
  tone-mapping exposure — see [Post-Processing](webgpu-postfx.md)).
- **Grad opacity** — how much surface-gradient (edge) strength contributes to opacity.
- **Grad scale** — the spatial scale used to estimate that gradient.
- **Lighting** — overall strength of the lighting contribution mixed into the volume shading.

## Lighting panel

Three independent, simultaneously-usable light types, plus shared shading, shadow, ambient-occlusion,
and performance controls.

**Global directional** — a fixed directional light: **Color**, **Intensity**, **Azimuth°** (0–360),
**Elevation°** (-90–90).

**Camera flashlight** — a light that follows the camera like a headlamp: **Color**, **Intensity**,
**Cone°** (spread angle), **Range ×ext** (throw distance, as a multiple of the volume's extent).

**Stage lights (4 corners)** — four lights positioned around the volume: **Color**, **Intensity**,
**Cone°**, **Range ×ext**.

**Shading**:

- **Ambient** — flat ambient light floor.
- **Specular** — highlight strength.
- **Roughness** — surface roughness affecting specular spread.

**Shadows** — toggle, plus:

- **Shadow steps** — ray-march sample count for shadow rays (quality vs. speed).
- **Shadow strength**, **Shadow softness**.
- **Casters (Global / Flashlight / Stage)** — choose which light types actually cast shadows; fewer
  casters render faster.

**Ambient occlusion** — toggle, plus **AO radius**, **AO intensity**, **AO samples**.

## Performance toggles

- **Half resolution while navigating** — renders at half resolution while the camera is moving, then
  re-renders full-res once you stop. Recommended when shadows/AO are on for large volumes.
- **Temporal AA (accumulate when still)** — accumulates multiple jittered samples once the camera is
  still, reducing noise/aliasing.
- **Half-res lighting while navigating (experimental)** — an additional half-resolution mode
  specifically for the lighting pass while moving.
- **Full quality while navigating (no step-size coarsening)** — disables automatic step-size
  coarsening during camera movement, trading frame rate for consistent full quality.

A live **GPU: … ms** readout shows total measured GPU time per frame; hover it for a per-pass timing
breakdown, useful for judging the cost of any toggle above.
