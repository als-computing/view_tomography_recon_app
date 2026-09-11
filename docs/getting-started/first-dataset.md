# Loading Your First Dataset

Once the app is running (see [Installation](installation.md)) and open in your browser:

## 1. Pick a server

In the header, the **Server** dropdown lets you choose which Tiled server to browse. If you followed
the Docker install, choose **Local** — it requires no login. See
[Choosing a Tiled Server](../features/tiled-servers.md) for what **Remote** and **Production** mean.

## 2. (Optional) Pick a folder

The **Folder** dropdown narrows where the data browser starts. If you're not sure, leave it and browse
from the top.

## 3. Browse and open a scan

Click **Select Data** to open the Tiled data browser. Navigate the catalog and click a dataset to open
it — it loads as a new [tab](../features/tabs-and-splits.md) in the viewer.

If you're running Local via Docker and haven't picked anything yet, the app may already have opened a
default scan for you automatically.

## 4. Choose a renderer (if needed)

The app defaults to the **WebGPU renderer** when your browser supports it and the page is served over
HTTPS (or `localhost`) — see the [WebGPU features](../features/webgpu-navigation.md). If WebGPU isn't
available, it falls back to the [ITK/VTK renderer](../features/itk-vtk-viewer.md) automatically. You
can switch manually at any time via the **Renderer** button in the header.

## 5. Start exploring

- Drag to orbit, scroll to zoom, `Space`+drag to pan — see the full
  [navigation reference](../features/webgpu-navigation.md) if you're using the WebGPU renderer.
- Adjust colors and contrast in the [Transfer Function panel](../features/webgpu-transfer-function.md).
- Crop down to a region of interest and stream in extra detail — see
  [Cropping & Slicing](../features/webgpu-slicing.md) and
  [Data & Loading](../features/webgpu-data-panel.md).
- When you've got a view worth keeping, use [Share](../features/share-links.md) to copy a link back to
  exactly this scan and view.

Continue to the [Features](../features/tabs-and-splits.md) section for a full tour of every panel and
control.
