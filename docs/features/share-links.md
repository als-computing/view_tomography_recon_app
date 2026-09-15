# Sharing a View (Share Links)

Click **Share** in the header to copy a link that reopens the currently active reconstruction at the
current view. The button reads **"Copied!"** for 1.5 seconds after a successful click, and is disabled
when there's no reconstruction open to share. If your browser blocks clipboard access (common on plain
HTTP pages), you'll get a manual copy-this-text prompt instead.

## What the link captures

- **Which scan** — identified by its Tiled catalog path, not a raw data URL, so the same link works
  whether the recipient opens it against dev, staging, or production Tiled (their own app resolves the
  right server).
- **Camera** — position, orientation, and zoom.
- **Rendering** — colormap, color range, transfer-function curve, gradient opacity, sample distance,
  blend mode, shadows, and the equivalent WebGPU rendering/exposure settings if that renderer was active.
- **Cropping** — the crop box / ROI planes, and whether cropping is enabled.
- **Which renderer** ([ITK/VTK](itk-vtk-viewer.md) or WebGPU) was active — opening the link switches
  the recipient into the matching renderer automatically, falling back to ITK if their browser can't
  run WebGPU (the scan still opens, just without the saved camera/colors replaying).

The link carries **no data and no credentials** — only which scan and how it was being viewed. The
recipient still needs their own access to that dataset on their Tiled server.

## Opening a shared link

Just visit the URL. The app opens, opens the referenced reconstruction as a new tab, and — once it
finishes loading — replays the saved camera angle, coloring, and cropping automatically.

If the URL contains a share link, it takes priority over the server's default scan on first load.
