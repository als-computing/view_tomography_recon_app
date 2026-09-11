# Tabs & Split Views

Every reconstruction you open becomes a tab, shown in a browser-style strip under the header. Click a
tab to make it active; each tab has a **×** close button.

Selecting a new dataset from the [data browser](tiled-servers.md) opens it as a new tab alongside
whatever's already open — there's no fixed limit on how many you can have.

## Comparing two datasets side by side

Every tab lives in either the "left" or "right" pane. As soon as both panes have at least one tab, the
app splits into a side-by-side view automatically. Move a tab between panes two ways:

- Click its move button — **⇥** (move to right) or **⇤** (move to left), depending on which side it's
  currently on.
- Drag the tab and drop it onto the other pane's tab group (or drag within a group to reorder tabs).

While split, each tab gets a small marker so you can tell at a glance which pane it belongs to: **◧**
for the left pane, **◨** for the right.

A footer control bar appears while split, with:

- **Link: Camera / Rendering / Cropping** checkboxes — lock the two panes' view angle, colormap/TF, and
  crop box together, independently of each other.
- **✕ Exit split** — or press **Escape** anywhere in the app.

## Linked 2D + 3D split (per tab, WebGPU only)

Separately from the left/right dataset-comparison split above, each tab has its own **◫** button (only
shown when the [WebGPU renderer](../index.md) is active) that splits *that one tab* into a linked 2D
slice + 3D volume view. See [Linked 2D/3D Split View](linked-2d-3d.md) for details — this is a
different feature from comparing two datasets, and the two can even be combined (a linked-2D/3D tab can
sit in either pane of a dataset comparison).

## Keeping tabs responsive

When you switch away from a tab, it isn't destroyed immediately — it stays fully live (still rendering,
GPU memory intact) for **45 seconds**, so switching back within that window is instant, with no reload.
If you don't revisit it within 45 seconds, the app quietly frees its GPU resources in the background.
There's no visible countdown for this; it's purely a responsiveness optimization. The currently active
tab(s) in either pane are always kept live regardless.

## No data open yet

When no tabs are open at all, the viewer area shows: **"Please select a data set to start the viewer."**
