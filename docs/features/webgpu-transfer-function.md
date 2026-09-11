# WebGPU Viewer — Transfer Function

The Transfer Function (TF) panel controls how raw intensity values in your volume map to color and
opacity — this is usually the single most important control for making features visible. A **Single /
Bands** toggle at the top switches the whole panel between two styles.

## Single mode (default)

- **Colormap** — the color ramp applied across the intensity range.
- **Opacity ×** — a global multiplier scaling the whole opacity curve up or down.
- **Opacity curve editor** — an interactive canvas with the volume's own intensity histogram drawn
  behind it as a visual reference.
    - **Drag a point** vertically to change its opacity, horizontally to change its intensity position.
    - **Double-click empty space** to add a new control point.
    - **Double-click an existing point** to remove it (at least 2 points are always kept).
- **Color range** — a dual-thumb slider setting the low/high intensity window mapped across the
  colormap.
    - Drag either thumb individually, or **drag the filled band between them** to shift the whole
      window without changing its width.
- **Auto** — runs a percentile auto-contrast pass against the volume's real histogram and resets the
  color-range thumbs to the computed window. A fast way to get a reasonable starting point on an
  unfamiliar dataset.
- **Equalize** — a display filter (contrast-limited histogram equalization) layered on top of the
  current TF, without altering the curve/colormap itself.
- **Clip limit** — controls the strength of the Equalize filter (only relevant while Equalize is on).
- **Reset TF** — restores the colormap, color range, and opacity curve/scale to their defaults, and
  drops out of Bands mode back to Single. (Equalize is a separate filter and isn't reset by this.)

## Bands mode

Build up to a fixed number of independent intensity sub-ranges ("bands") of the same volume, each
colored on its own — useful for highlighting several distinct material densities at once.

- One compact row per band: a number to select it, an eye toggle (👁/◌) to show/hide it, its own
  **Colormap**, a read-only range label (e.g. "0.20 – 0.55"), and a **×** to remove it.
- **+ Add band** adds a new band (disabled once the maximum is reached).
- Selecting a band reveals its own **Band N range** dual-thumb slider (same drag-the-band-to-shift
  behavior as Single mode), its own **Opacity ×** slider, and its own opacity-curve editor.
- Overlapping bands are resolved with later bands painting over earlier ones.
- Switching back to Single mode discards all bands.

!!! note
    A transfer function you're happy with (Single or Bands, plus lighting/post-processing) can be
    saved and reused across datasets — see [Presets](webgpu-presets.md).
