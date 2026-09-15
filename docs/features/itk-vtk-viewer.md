# Legacy ITK/VTK Viewer

The app ships two rendering engines. The **ITK/VTK renderer** is the original
[itk-vtk-viewer](https://kitware.github.io/itk-vtk-viewer/)-based renderer, embedded directly in the
page. It's the fallback used whenever [WebGPU isn't available](../getting-started/first-dataset.md) —
an unsupported browser, or the page served over plain HTTP — and can also be selected manually.

## Switching renderers

The header's **Renderer: ITK ⇄** / **Renderer: WebGPU ⇄** button flips the rendering engine for the
whole app (not per tab — every open tab switches together). Its tooltip reads "Switch the volume
renderer between ITK (itk-vtk) and WebGPU."

## What's different from the WebGPU renderer

Functionally, the ITK viewer is the "original" volume viewer: standard orbit/zoom/pan, colormap and
transfer-function controls, and ROI cropping planes. It does **not** have:

- The [linked 2D/3D split view](linked-2d-3d.md) (WebGPU-only).
- The exposure and half-resolution-while-navigating performance controls described in
  [Rendering & Lighting](webgpu-rendering-lighting.md).

If you don't need those specific features, both renderers work equally well for browsing and viewing
reconstructions — the WebGPU renderer is simply the newer, more actively developed one.

## When you'll see it automatically

If the app is served over plain HTTP (not HTTPS, and not `localhost`), or your browser doesn't support
WebGPU, the renderer toggle is disabled and the app uses ITK by default. If a shared link tries to
force WebGPU mode and your browser can't run it, the viewer pane shows the reason and a
**"Switch back to the ITK renderer"** link.
