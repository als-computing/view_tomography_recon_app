# WebGPU Viewer — Presets

The Presets panel lets you save and reuse a rendering "look" across different scans.

- **Preset** dropdown — lists saved looks by name (or "(no presets saved)" if none exist).
- **Apply** — applies the selected preset to the current view.
- **Save as…** — prompts for a name and saves the current look under it.
- **Delete** — removes the selected preset.

A preset captures: colormap, opacity, density/exposure, [Post FX](webgpu-postfx.md),
[Lighting](webgpu-rendering-lighting.md), and [Measure plane](webgpu-measure.md) settings. **Camera
position and cropping are not included** — a preset is about appearance, not where you're looking.

Presets are saved locally in your browser and shared across every dataset you open there. The most
recently used look is automatically applied to newly opened scans, so you generally don't need to
re-tune the transfer function every time you open a new file with similar contrast characteristics.
