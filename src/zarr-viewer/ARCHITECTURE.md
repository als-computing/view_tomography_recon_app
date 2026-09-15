# Architecture

The real ownership chain, as of this pass — one or two sentences per box on what it owns. Written last,
after the renderer-hardening plan's Phase 1-4 landed, so it describes current reality rather than
aspiration (see the plan's own note on why: this file goes stale fast if written earlier).

## Data → GPU

- **`VolumeSource`** (`io/volume/volume-source.ts`) — format-agnostic, chunked, possibly-multiscale 3D
  scalar data. `OmeZarrVolumeSource` (`io/volume/ome-zarr.ts`) is the only real implementation today;
  owns the dataset's `valueRange` (see `padValueRange`'s doc comment for why it's deliberately widened
  past what the coarsest-level scan alone finds).
- **`VolumeLoader`** (`render/volume/volume-loader.ts`) — streams and uploads the currently *displayed*
  pyramid level into a GPU texture, with an invalidation token so a superseded load can't clobber a
  newer one.
- **`BrickLoader`** (`render/volume/brick-loader.ts`), owned by **`ResidencyController`**
  (`viewer/volume/ResidencyController.ts`) — streams a finer sub-volume ("ROI brick") over the region
  the camera is actually looking at, on top of the coarse displayed level. `ResidencyController` decides
  *when* to request a brick (visibility-hint bins, camera idle time, thrash-avoidance) and fades it
  in/out; `BrickLoader` does the actual chunked GPU upload.

## Rendering

- **`GpuContext`** (`render/device/context.ts`) — the acquired adapter/device/canvas plus a small
  capability struct computed once (`supportsGbufferTargets`, `supportsFloat32Filtering`,
  `supportsTimestampQuery`, `maxTextureDimension3D`) that renderer/residency code reads from instead of
  re-deriving `device.limits`/`device.features.has(...)` at scattered call sites. Also where an
  unrequested `device.lost` is detected (see `DeviceOptions.onDeviceLost`'s doc comment for why recovery
  stops at detection + a clear error rather than full automatic reconstruction).
- **`VolumeRenderer`** (`render/volume/volume-renderer.ts`) — ray-marches the volume for one frame.
  Delegates to three split-out pieces rather than being a monolith:
  - **`VolumePipeline`** (`render/volume/volume-pipeline.ts`) — compile-time GPU state (bind-group/
    pipeline layouts, the main + background render pipelines, samplers/uniform buffer) that only needs
    rebuilding when the shader config changes.
  - **`VolumeBindings`** (`render/volume/volume-bindings.ts`) — per-frame bind-group creation.
  - **`VolumeAcceleration`** (`render/accel/volume-acceleration.ts`) — the occupancy grid, tile
    compaction, visibility-feedback accumulator, opacity shadow map, and (lazy, "quality"-config-only —
    see Phase 1d) the density pre-integration pyramid.
- **`LightingPass`** (`render/accel/lighting-pass.ts`) — the half-res G-buffer lighting pass (AO/shadow/
  multi-scatter), computed once per half-res pixel instead of once per full-res ray-march sample while
  the camera is moving (`deferLighting`, Phase 1a) — bilateral-upsampled and composited back by
  `FxPipeline`, or blitted straight to the swapchain for the `KeyL` debug toggle.
- **`FxPipeline`** (`render/post/fx-pipeline.ts`) — drives one `RenderGraph` (`render/graph/render-graph.ts`)
  per frame: volume pass → optional lighting-composite → TAAU (`render/accel/taau.ts`, temporal
  accumulation while the camera is still) → bloom/tonemap/FXAA/sharpen/vignette → swapchain. Owns the
  transient render-target pool (`RenderGraph.poolBytes()` feeds `getMemoryStats()`'s `renderTargetBytes`)
  and the end-to-end `GpuTimer` (`render/accel/gpu-timer.ts`) that times every pass in the graph.

## Viewer orchestration

- **`WebGpuVolumeViewer.ts`** (`viewer/WebGpuVolumeViewer.ts`) — the public entry point (`run()` →
  `WebGpuViewerInstance`). Owns the render loop (adaptive sampling, settle detection, TAAU
  accumulation-with-a-time-cap — see the settle-time-cap plan note), wires every piece above together,
  and exposes the imperative API a host app or the built-in HUD drives (camera/rendering/cropping get-
  set, mask layers, `getMemoryStats()`). Composes rather than owns the following submodules directly:
  - **`viewer/camera/`** — orbit controls, camera-pose capture/compare (for shareable links and linked
    multi-pane sync).
  - **`viewer/interaction/`** — `PickingController` (click-to-measure/annotate) and `CropDragController`
    (drag a crop-box face directly in the canvas).
  - **`viewer/rendering/`** — pure per-frame math (near/far planes, camera basis) and lighting-state
    helpers, factored out so they're unit-testable without a GPU.
  - **`viewer/ui/`** — the built-in HUD: pure string-builder panels (`html.ts` + `panels/`) and the
    three delegated `click`/`change`/`input`/pointer event listeners (`hudEvents.ts`) that route every
    control to its effect.
  - **`viewer/volume/`** — `ResidencyController` (above), plus `load-mask.ts`/`load-layer.ts` (mask/
    annotation-layer and shelved multi-volume-layer loading) and pure geometry helpers
    (`volume-geom.ts`'s `finestTargetLevel`, `roi-geometry.ts`).

## What this doesn't cover

Deliberately out of scope for this doc (see the hardening plan's "Explicitly deferred" section for the
reasoning on each): true multi-brick virtual GPU residency, policy-driven brick scheduling, a
centralized `ViewerSessionState`, a formal load-lifecycle state machine, and the `packages/`+`apps/`
split this file's own existence might otherwise suggest is closer than it is — none of these exist today,
and this doc describes the codebase as it actually is, not where it might go.
