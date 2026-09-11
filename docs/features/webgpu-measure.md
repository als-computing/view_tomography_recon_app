# WebGPU Viewer — Measurements

## Measure plane

**Measure plane (camera-linked ruler)** turns on a grey reference sheet that sweeps between the
volume's front face (0) and back face (1) along the current view direction.

- **Plane depth (front→back)** — positions the plane between front (0) and back (1).
- **Plane gray** — the plane's shade of grey.
- **Plane opacity** — how strongly it's blended into the render.

The volume in front of the plane occludes it, and it dims the volume behind it, so it's a way to
visually judge depth. The [on-screen edge rulers](webgpu-navigation.md#viewport-overlays) calibrate to
this plane's depth while it's on, or to the volume's center otherwise.

## Pick / measure a structure

**Pick mode (or Ctrl+click)** (also `P`) enables click-to-measure: clicking a structure in the volume
grows a connected region (flood fill) from that point and reports its physical size.

After a pick, the result readout includes:

- The seed voxel's coordinates and density.
- The density threshold used for the flood fill.
- The number of voxels in the connected region.
- Its physical volume (in the viewer's current length unit — e.g. µm³ — and also in mL).
- The mean density of the selected region.

The crop box automatically snaps to the picked feature. **Clear selection** (also `E`, which also
resets the crop box) discards the current result.

!!! tip "Speed on large volumes"
    Picking uses a ray cast plus a 6-connected flood fill at the *currently displayed* resolution
    level. Switch to a coarser level (`[`, or `L2`+ in the [Data panel](webgpu-data-panel.md)) before
    picking on a very large volume if it feels slow.
