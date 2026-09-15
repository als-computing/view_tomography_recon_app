# Linked 2D/3D Split View

This is a WebGPU-only feature: a single tab split into a 2D orthoslice pane (left) and a full 3D
volume pane (right), kept in sync with each other. It's different from the
[left/right dataset-comparison split](tabs-and-splits.md#comparing-two-datasets-side-by-side) — this
splits *one dataset's view*, not two different datasets.

## Turning it on

Click the **◫** button on a tab (only shown when the WebGPU renderer is active). Its tooltip reads
"Show linked 2D slice + 3D split" when off, and "Show 3D only" when on. Click **✕ 3D only** in the
pane's own toolbar, or the tab's **◫** button again, to return to a plain single 3D view.

## The pane's toolbar

- **2D slice: X / Y / Z** — picks which orthogonal slice axis the left (2D) pane displays. The left
  pane shows that flat slice while the right (3D) pane keeps showing the full volume from whatever
  angle you've orbited it to.
- **🔗 3D angle** — a different mode. Instead of a fixed axis-aligned slice, the left pane becomes a
  zoomed-in view of a small cube sitting at the intersection of the crop/slice planes, always rendered
  facing the same direction the right pane's camera currently points. Rotate either pane and the other
  follows (only the viewing *angle* syncs — each pane keeps its own zoom level). Moving the slice
  position on the right pane's own HUD moves where the cube is centered. This effectively makes the
  split a "detail view" (left) + "overview" (right) pair, rather than a flat axis slice.
- **◈ cube / ◇ cube** — only visible while **🔗 3D angle** is active — shows or hides a green
  wireframe box on the right (3D) pane, marking exactly the region shown zoomed-in on the left.
- **✕ 3D only** — exits the split, returning to a plain single 3D view.

## Other behavior

- The left (2D) pane's own control sidebar is collapsed by default, since its rendering/cropping
  controls are already linked to the right pane.
- The right (3D) pane's sidebar stays open, and has its own **⌖** button for recentering the 3D camera
  on whatever the 2D pane is currently showing.
