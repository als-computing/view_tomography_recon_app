# WebGPU Viewer — Data & Loading

Choosing *which* dataset to open happens in the app's top header, not inside the viewer's own HUD.
Once a dataset is open, the in-viewer **Data** panel controls how much of it is actually loaded and at
what resolution.

## Opening a dataset (app header)

- A **Server** dropdown (when more than one is configured) switches between Tiled servers — see
  [Choosing a Tiled Server](tiled-servers.md).
- A **Folder** dropdown lists subfolders under the active server's catalog path.
- The **Tiled** browser widget opens Tiled's own catalog browser so you can drill in and pick a scan.
  Selecting one loads its data into the viewer.
- A **Share** button copies a link that reopens this scan at the current view — see
  [Sharing a View](share-links.md).
- A **Renderer: WebGPU ⇄ ITK** toggle switches the whole viewer between this renderer and the
  [legacy ITK/VTK renderer](itk-vtk-viewer.md).

You can also press **O** at any time to open a local OME-Zarr folder directly from your computer's
disk, bypassing Tiled entirely (uses your browser's native folder picker).

## The Data panel

- **Resolution (GPU max N³)** — a row of buttons, one per available level (e.g. `L0 512×512×512`,
  `L1 256×256×256`). Click one to switch which resolution is displayed. Levels too large for your
  GPU's maximum 3D-texture size aren't offered, and a hint line explains why (e.g. "L0 needs 1024³
  (GPU max 512)").
- A line under the level buttons reports the **voxel size** and **physical size** of the volume at the
  currently displayed level (e.g. "voxel 1.200 µm · 614×614×614 µm").
- **High-res ROI (stream visible detail)** — when checked, the viewer streams in extra full-resolution
  detail for just the region you're currently viewing or have cropped to, layered on top of the coarser
  level chosen above. While streaming, a progress readout appears ("Streaming ROI… n/total chunks")
  with a small progress bar. Turn this off to keep the whole volume at one fixed, coarser resolution —
  useful on a slow connection, or when panning/orbiting quickly matters more than fine detail.

!!! tip "Large volumes and level choice"
    Start at a coarser level while getting oriented, then step to finer levels (`[`/`]` or the level
    buttons) once you've framed the region you care about. Combined with High-res ROI, this keeps
    interaction responsive on very large datasets.
