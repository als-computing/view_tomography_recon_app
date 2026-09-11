# Installation From Source (Advanced)

!!! warning "Prefer Docker"
    This path is only useful for actively developing the app itself. If you just want to view your
    data, use [Installation (Docker)](installation.md) instead.

Running from source means running three pieces yourself: a Tiled server, the React app's dev server,
and (optionally) a standalone `itk-vtk-viewer` process if you want to use the legacy renderer outside
the bundled dev setup.

## 1. Start a Tiled server

Zarr support has been native in Tiled since [PR #774](https://github.com/bluesky/tiled/pull/774)
(0.2.15+) — install the regular published package, no fork needed:

```bash
conda create -n tiled_zarr_env python=3.12
conda activate tiled_zarr_env
pip install "tiled[all]"
```

Then serve a directory of your reconstructions:

```bash
cd /path/to/your/zarr/projects
TILED_ALLOW_ORIGINS='["http://localhost:5174"]' tiled serve directory "." --public --verbose
```

You should see output like:

```text
Tiled server is running in "public" mode, permitting open, anonymous access
for reading. Any data that is not specifically controlled with an access
policy will be visible to anyone who can connect to this server.

Navigate a web browser or connect a Tiled client to:

http://127.0.0.1:8000?api_key=...

[-] INFO:     Uvicorn running on http://127.0.0.1:8000 (Press CTRL+C to quit)
Server is up. Indexing files in ./...
```

## 2. Point the app at your Tiled server

Tiled server addresses aren't read from environment variables — they're configured directly in
[`src/tiledServers.ts`](https://github.com/als-computing/view_tomography_recon_app/blob/main/src/tiledServers.ts)
(the `TILED_SERVERS` array), which the header dropdown switches between at runtime. Edit the `local`
entry's `apiUrl` if your Tiled server isn't at the default `http://localhost:8001/api/v1`.

## 3. Install and run the React app

```bash
npm install
npm run dev
```

```text
  VITE v6.0.11  ready in 139 ms

  ➜  Local:   http://localhost:5174/
  ➜  Network: use --host to expose
```

Open [http://localhost:5174/tomo_viewer/](http://localhost:5174/tomo_viewer/) in your browser.

## Optional: standalone `itk-vtk-viewer`

The [ITK/VTK renderer](../features/itk-vtk-viewer.md) is embedded directly in the app for normal use —
you don't need to run anything extra for it. A standalone `itk-vtk-viewer` process is only relevant if
you're customizing that widget's own interface:

```bash
npm install itk-vtk-viewer -g
itk-vtk-viewer --port 8082
```

Port `8082` matches what the app's dev server proxies to by default (see `vite.config.js`).

## Useful scripts

| Command | What it does |
|---|---|
| `npm run dev` | Start the Vite dev server |
| `npm run build` | Production build (outputs to `dist/`) |
| `npm run lint` | Lint `.js`/`.jsx`/`.ts`/`.tsx` |
| `npm run typecheck` | Type-check `.ts`/`.tsx` files |
| `npm test` | Run the unit test suite (Vitest) |
