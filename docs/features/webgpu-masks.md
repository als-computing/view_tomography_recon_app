# WebGPU Viewer — Annotations & Masks

The Annotations panel gives you two independent mask/annotation slots — **Mask 1** and **Mask 2** —
each holding its own separate mask volume, displayed independently and simultaneously if you want.

A mask is assumed to share the exact same voxel grid as the primary volume — it's treated as an
annotation layer over the same scan, not a separate dataset in its own right.

## Loading a mask

For each slot:

1. Enter a **URL** (e.g. `https://.../mask.zarr`).
2. Click **Load** (shows "Loading…" while in progress).
3. Click **Remove** (appears once loaded) to unload that slot.

An inline error message appears if loading fails, or a note if the mask loaded but contains only
background (class 0) voxels.

## Per-class controls

Once a mask loads, one row appears per discovered class:

- A **color swatch** — click to change that class's display color.
- A **class label** with its voxel count (e.g. "Class 2 (48,213 vox)").
- An **opacity slider** (0–1) for that class.
- An **eye toggle** (👁/◌) to show/hide that class independently.

Class id `0` is always treated as background and is never rendered.

!!! tip
    Because the two mask slots are independent, you can load two different annotation sets (e.g. two
    segmentation runs) on the same scan and compare them by toggling classes/opacity in each slot.
