# WebGPU Viewer — Navigation & Controls

The heads-up display (HUD) is a single collapsible panel docked to the side of the viewport. Its
header has two tabs — **▣ Volume settings** (Data, Transfer Function, Slices, Crop, Measure,
Annotations, Presets) and **⚙ Render settings** (Render, Lighting, Post FX, Controls) — plus a
collapse/expand arrow that shrinks the whole HUD to a thin strip. Only one panel is open at a time;
opening a new one closes whichever was open.

A one-line status bar under the header shows the current resolution level, the volume's voxel
dimensions, and flags for loading/picking/streaming activity, e.g.:

```
L2 · 512×512×512 · loading… · PICK · ROI L1
```

A permanent hint at the bottom of the HUD reminds you of the core shortcuts:

```
Pan: Space+drag / Shift / middle / right · wheel zooms to cursor · P / Ctrl+click pick · [ ] LOD · O open
```

## Mouse controls

| Input | Action |
|---|---|
| Left-drag | Orbit the camera around the volume |
| Space+drag, Shift+drag, Alt+drag, middle-drag, or right-drag | Pan |
| Mouse wheel | Zoom toward the cursor (3D view) — or scrub through slices (axis-plane view) |
| Ctrl/Meta+wheel | Zoom (when in an axis-plane view) |
| Ctrl+click | Pick / measure a structure (see [Measurements](webgpu-measure.md)) |
| Drag a crop-box face | Push/pull that face, while [Crop mode](webgpu-slicing.md) is on |
| Drag the filled band between a slider's two thumbs | Shift the whole range without resizing it (used throughout the TF, crop, and band-range sliders) |

## Keyboard shortcuts

| Key | Action |
|---|---|
| `[` / `]` | Step to the next-coarser / next-finer resolution level |
| `1` `2` `3` `4` | Jump to the X-plane / Y-plane / Z-plane / full 3D volume view |
| `F` | Reframe the camera to the current slice plane |
| `P` | Toggle Pick/measure mode |
| `S` | Toggle slice-plane overlays in the 3D view |
| `R` | Return to the full 3D volume view |
| `O` | Open a local OME-Zarr folder directly from disk (bypasses Tiled) |
| `E` | Clear the current pick/measurement selection and reset the crop box |
| `C` | Toggle crop-box drag mode |

## On-canvas floating buttons

- **⌂** (top-right) — recenter the camera on the whole volume.
- **⌖** (top-right, below ⌂) — zoom to the point where the current X/Y/Z slice planes intersect.

## Viewport overlays

These are drawn directly over the render, not inside a HUD panel:

- **Axis gizmo** (bottom-right) — three color-coded lines for world X/Y/Z, rotating with the camera so
  you can always tell which way the volume is oriented.
- **Edge rulers** (bottom and left edges) — tick marks labeled with physical distance (e.g. µm),
  rescaling automatically as you zoom. They calibrate to the [Measure plane's](webgpu-measure.md) depth
  when it's enabled, or to the orbit pivot depth otherwise.
- **Crop-box wireframe** — appears only while Crop mode is on, showing the 12 edges of the crop box
  with the hovered/dragged face highlighted.

## Controls panel (input preferences)

Under the **⚙ Render settings** tab:

- **Invert X axis** — inverts the horizontal orbit-drag direction.
- **Invert Y axis** — inverts the vertical orbit-drag direction.
