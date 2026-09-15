# Troubleshooting

## "WebGPU needs a secure context (https, or localhost)..."

You're viewing the app over plain HTTP on a non-`localhost` address. The
[WebGPU renderer](features/webgpu-navigation.md) requires HTTPS or `localhost` — the app will fall back
to the [ITK/VTK renderer](features/itk-vtk-viewer.md) automatically. If you need WebGPU, access the app
via HTTPS instead, or via `localhost` if you're running it on your own machine.

## "WebGPU is not available in this browser..."

Your browser doesn't support WebGPU yet (needs a recent Chrome/Edge — 113+). The app falls back to the
ITK/VTK renderer automatically; try a supported browser if you specifically need the WebGPU features.

## Folder dropdown says "Failed to load folders"

You're not logged in yet on **Remote** or **Production**. Click **Select Data** to open the Tiled data
browser — it will prompt you to sign in. Once you're authenticated, the Folder dropdown and browser
populate normally. See [Choosing a Tiled Server](features/tiled-servers.md).

## Stuck on a "Select Login Provider" screen even though the server doesn't require login

This usually means a leftover authentication token from a *different* Tiled server is being sent along
with your request, and the server you're now pointed at doesn't recognize it. Click the login screen's
own **Clear Tokens** button, then refresh and try again. (Switching servers via the header dropdown
already clears this automatically — this is only likely if you're seeing stale behavior after a very
old session.)

## Login redirect fails / bounces back to a Tiled page instead of the app

This is a server-side configuration issue: the identity provider's allow-listed redirect URI for that
Tiled server doesn't match the app's real served URL. This isn't something you can fix as a viewer —
report it to whoever administers that Tiled server/deployment (see
[Configuring Tiled Servers](admin/configuring-tiled-servers.md) if that's you).

## `docker compose up` fails, or a service won't start

Check the logs:

```bash
docker compose logs           # everything
docker compose logs tiled     # just one service
```

Common causes:

- `DATA_PATH` in `.env` doesn't point at a real, readable directory.
- A port (`5174` or `8001`) is already in use by something else on your machine.
- You changed `.env` but didn't recreate the containers — run
  `docker compose up -d --force-recreate`.

## The app doesn't show my data / a dataset I expect

- Confirm `DATA_PATH` points at the **parent** directory containing your dataset folders, not the
  dataset folder itself.
- If your reconstruction lives somewhere with an awkward name/path, use a
  `docker-compose.override.yml` bind mount instead of moving files — see
  [Installation (Docker)](getting-started/installation.md#3-point-the-app-at-your-data).
- Datasets only show up as subfolders under `DATA_PATH` (or your override mounts) — nested structure
  beyond that follows whatever's on disk.

## The viewer feels slow / laggy

- Try a coarser [resolution level](features/webgpu-data-panel.md) (`[` key, or the level buttons).
- Turn off [shadows and ambient occlusion](features/webgpu-rendering-lighting.md) or enable
  **Half resolution while navigating** if they're on.
- If you enabled **High-res ROI** streaming, try disabling it while panning/orbiting quickly, and
  re-enable it once you've settled on a region.

## Still stuck?

Check the project's [GitHub issues](https://github.com/als-computing/view_tomography_recon_app/issues),
or reach out to whoever administers your deployment.
