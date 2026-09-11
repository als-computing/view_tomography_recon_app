# WebGPU Viewer — Cropping & Slicing

## Slices panel

- **View mode** — **3D**, **X (sagittal)**, **Y (coronal)**, **Z (axial)**. Switches between full 3D
  volume rendering and a flat, axis-aligned single-slice view along that axis. Shortcut keys `1`-`4`
  jump directly to each mode.
- In an axis-plane mode:
    - A status line shows the slice's physical position and index (e.g. "12.3 µm · index 128/255").
    - **Position** slider scrubs the slice along its axis (0–1 of the volume). The mouse wheel does
      the same thing directly over the canvas.
    - Hint: scroll wheel scrubs, Ctrl+wheel zooms, middle/Alt-drag pans, `F` reframes.
- Under **Overlays & all axes**:
    - **Show plane overlays in 3D** (also `S`) — draws the current X/Y/Z slice planes as overlays
      inside the full 3D view.
    - **X / Y / Z** checkboxes — enable/disable each axis's plane overlay independently.
    - **X / Y / Z** sliders — position each axis's overlay independently of which one is "active."
    - **Reframe to slice** (also `F`) — re-centers/aims the camera at the current slice.

## Crop panel

- **Crop mode (drag a face in the canvas)** (also `C`) — turns on an interactive 3D crop box. While
  on, hovering a face in the 3D view highlights it, and dragging pushes/pulls that face inward or
  outward along its own axis (3D "volume" view only, not an axis-plane view). The box is drawn as a
  wireframe overlay with the hovered/dragged face highlighted.
- **ROI crop (UVW 0–1)** — one dual-thumb range slider per axis (**X**, **Y**, **Z**) for precise
  numeric entry of the crop region, as a 0–1 fraction of the volume. Drag either thumb individually,
  or drag the filled band between them to shift the whole crop range without resizing it.
- **Reset crop** (also `E`, which also clears any pick/measurement) — restores the crop box to the
  full volume extent on all axes.

!!! tip "Cropping + high-res streaming"
    Turning on [High-res ROI](webgpu-data-panel.md) streams extra detail specifically for whatever
    region the crop box currently covers — crop down to a region of interest first, then enable it, to
    get fine detail exactly where you're looking without paying for the whole volume at full resolution.
