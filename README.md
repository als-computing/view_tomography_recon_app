# Tomography Reconstruction Visualizer

## (Powered by itk-vtk-viewer)

This web application allows users to load their reconstructed volumes using `Bluesky Tiled Browser` into the `itk-vtk-viewer` widget, all within the same `React` web application.

📖 **Full documentation (getting started + every feature) is available as an mkdocs site**, and is also
built into the app itself — a **📖 Docs** button in the header opens it in an in-app iframe.

- **Via `docker compose up`**: a `docs` service serves it automatically, proxied through the app at
  `/tomo_viewer/docs/` — the Docs button just works, no setup needed.
- **Via a published/deployed image** (`:local`/`:als-prod`/`:als-staging`): the docs are built into the
  same image and served same-origin, at `<base path>docs/` (e.g. `/bl832/tomo_viewer/docs/`) — the Docs
  button resolves this as a relative path, so it works regardless of which domain fronts the
  deployment, with no docs URL/FQDN ever hardcoded into the app.
- **Standalone**, outside the app (e.g. while writing docs):
  ```bash
  pip install -r requirements-docs.txt
  mkdocs serve
  ```
  Then open http://127.0.0.1:8000/.

To point the Docs button at a genuinely separate, externally-hosted docs site instead (or to hide it
entirely), set `VITE_DOCS_URL` when building from source (`VITE_DOCS_URL=https://docs.example.com npm
run build`, or `VITE_DOCS_URL= npm run build` to hide it) — see `src/config.ts`. This isn't exposed as
a `react/Dockerfile` build arg, since the built-in same-origin docs already work correctly for every
published image without needing a per-deployment override.

---

# Installation via Docker (Recommended)

## Install Docker
Before you begin, make sure you have Docker (the `docker` CLI + a running daemon, plus the `docker compose` plugin) installed on your machine. Any of the following work — this repo doesn't depend on Docker Desktop specifically:

- [Docker Desktop](https://www.docker.com/) — official, free for personal/small-business use, available for macOS/Windows/Linux.
- [Colima](https://github.com/abiosoft/colima) — open-source, macOS/Linux, a lightweight Docker Desktop alternative (`brew install docker docker-compose colima`, then `colima start`).
- [Podman Desktop](https://podman-desktop.io/) or [OrbStack](https://orbstack.dev/) — other common alternatives; either works as long as `docker`/`docker compose` resolve on your `PATH`.

## Clone repository
Next, clone this repository.

`git clone https://github.com/als-computing/view_tomography_recon_app.git`

Once it is downloaded, cd into it:

`cd view_tomography_recon_app`

## Set environment variables

Create a new file `.env` in `view_tomography_recon_app/` (or rename `.env.example`) and set `DATA_PATH` to the parent directory of your reconstructed datasets:

```
DATA_PATH=/absolute/path/to/your/reconstructions/wherever/they/are
```

`docker-compose.yml`'s `tiled` service serves that directory directly (`tiled serve directory ... --public`) - no registration step, no API key, no separate Tiled checkout. Subfolders show up as datasets by name. Tiled server URL/paths/default-dataset are configured in `src/tiledServers.ts` (`TILED_SERVERS`), not via env vars - edit that file if you need to point at a different local port or Tiled server.

If your reconstructions have awkward on-disk names and you want friendlier dataset names in the catalog without renaming/copying the actual files, create a `docker-compose.override.yml` (gitignored, machine-specific - Docker Compose merges it automatically) that adds per-dataset bind mounts to the `tiled` service, e.g.:

```yaml
services:
  tiled:
    volumes:
      - /absolute/path/to/rec2026..._petiole22.zarr:/storage/data/scans/petiole22.zarr:ro
```

## Build and start the application

Now we're ready to build the Docker container. This will build the container and start the application in the background.  

`docker compose up -d`

You can check the status of each service by running

`docker compose ps`

and you should see an output like this:

```
(base) you@your-computer view_tomography_recon_app % docker compose ps
NAME                                 IMAGE                              COMMAND                   SERVICE   CREATED      STATUS      PORTS
view_tomography_recon_app-nginx-1    nginx:stable                       "/docker-entrypoint.…"    nginx     5 days ago   Up 2 days   0.0.0.0:5174->80/tcp
view_tomography_recon_app-react-1    view_tomography_recon_app-react    "npm run dev -- --ho…"    react     4 days ago   Up 2 days   5174/tcp
view_tomography_recon_app-tiled-1    ghcr.io/bluesky/tiled:0.2.16       "tiled serve directo…"    tiled     4 days ago   Up 2 days   0.0.0.0:8001->8000/tcp
```

## Start the viewer

Tiled runs in public/anonymous mode for reading, so no separate authentication step is needed. Open the app directly: http://localhost:5174/tomo_viewer/ — select "Local" in the header's server dropdown and your datasets (from `DATA_PATH`) should list in the Tiled browser widget.

If you ever need the write-capable API key (e.g. to modify data through Tiled directly), it's printed at startup — `docker compose logs tiled`.

Note: you can access the app from other computers by noting your [WAN IP address](http://wanip.info/) and using that instead of `localhost`.

Voila!

## Debugging

Since there are a few connected services, you may run into issues. To get a sense of what's wrong, you can diplay the logs for each service. In the root of the project, run `docker compose logs` to see all of the logs, or `docker compose logs tiled` to see the logs for a specific service.

If you update the `.env` file, you can restart the whole application by running `docker compose up -d --force-recreate` to pick up your changes.
  


---

# Building the deployment images

The docker-compose flow above runs the Vite **dev server** — good for local development, not for
deployment. For deployment, the app instead builds three separate, purpose-built production images
from the same `react/Dockerfile` (`target: prod`), differing only in build args. See
[`docs/admin/deployment.md`](docs/admin/deployment.md) for the full picture (why three images, HTTPS
requirements, the server-locking mechanism, etc.) — this section is just the commands.

| Tag | Build command |
|---|---|
| `:local` | `docker build --target prod --build-arg BASE_PATH=/tomo_viewer/ -f react/Dockerfile -t view_tomography_recon_app:local .` |
| `:als-prod` | `docker build --target prod --build-arg BASE_PATH=/bl832/tomo_viewer/ --build-arg FIXED_TILED_SERVER=tiled.als.lbl.gov -f react/Dockerfile -t view_tomography_recon_app:als-prod .` |
| `:als-staging` | `docker build --target prod --build-arg BASE_PATH=/bl832/tomo_viewer/ --build-arg FIXED_TILED_SERVER=tiled-staging.als.lbl.gov -f react/Dockerfile -t view_tomography_recon_app:als-staging .` |

- `:local` shows the full Local/Remote/Production server dropdown (same as the dev-server flow above) —
  useful for testing against any of the three Tiled servers from one image.
- `:als-prod`/`:als-staging` are each locked to one Tiled server (dropdown hidden) — these are exactly
  what gets published to `ghcr.io` on merge (see below).

Run any of them the same way:

```bash
docker run -d -p 5174:80 view_tomography_recon_app:local
```

Then open `http://localhost:5174/tomo_viewer/` (adjust the path to match whichever `BASE_PATH` you built with).

## Pulling the published images

Once `remote-tiled` merges to `main`, [`.github/workflows/publish-image.yml`](.github/workflows/publish-image.yml)
automatically builds and pushes all three images to `ghcr.io` on every push to `main` (and any `v*` tag)
— no manual build needed after that point:

```bash
docker pull ghcr.io/als-computing/view_tomography_recon_app:local
docker pull ghcr.io/als-computing/view_tomography_recon_app:als-prod
docker pull ghcr.io/als-computing/view_tomography_recon_app:als-staging
```

```bash
docker run -d -p 8080:80 ghcr.io/als-computing/view_tomography_recon_app:als-prod
```

Note: depending on the GHCR package's visibility setting (public vs. private, configured separately in
GitHub's package settings after the first push), pulling may require `docker login ghcr.io` first even
though pushing always does.

---

# Installation from Scratch (Not recommended)

## `Bluesky Tiled`

Host your reconstructed data using `Tiled`, which we use to connect data servers to front end applications such as this one.

#### Prepare environment

Zarr support is native in Tiled as of `bluesky/tiled` [PR #774](https://github.com/bluesky/tiled/pull/774) — install the regular published package (0.2.15+), no fork needed:

```
conda create -n tiled_zarr_env python=3.12
conda activate tiled_zarr_env
pip install "tiled[all]"
```

#### Start Tiled

Open a new terminal, and either navigate to the directory containing your zarr projects, or specify the full path directly:

```
cd [go/to/your/zarr/projects/]
TILED_ALLOW_ORIGINS="http://localhost:3000 http://localhost:5174 http://localhost:8082" tiled serve directory "data/tomo/scratch/" --public --verbose
```

If that is successful, you should see something like this:

```
(tiled_zarr_env) you@your-computer tiled_zarr % TILED_ALLOW_ORIGINS="http://localhost:3000 http://localhost:5174 http://localhost:8082" tiled serve directory "data/tomo/scratch/" --public --verbose
Creating catalog database at /var/folders/7t/17b_zxx55jnggw80_6672tbh0000gn/T/tmp94wbqw7y/catalog.db

    Tiled server is running in "public" mode, permitting open, anonymous access
    for reading. Any data that is not specifically controlled with an access
    policy will be visible to anyone who can connect to this server.


    Navigate a web browser or connect a Tiled client to:

    http://127.0.0.1:8000?api_key=ee7caca056af09c62993ffa789689bf181d41a4e885544c070e68b32339ed1c0


    Because this server is public, the '?api_key=...' portion of
    the URL is needed only for _writing_ data (if applicable).


[-] INFO:     Started server process [15895]
[-] INFO:     Waiting for application startup.
Tiled version 0.1.dev2517+g202f10e
[-] INFO:     Application startup complete.
[-] INFO:     Uvicorn running on http://127.0.0.1:8000 (Press CTRL+C to quit)
[58c42c2098d320fd] 127.0.0.1:61412 (unset) - "GET /api/v1/ HTTP/1.1" 200 OK
[74cb5a4350af0bb9] 127.0.0.1:61412 (unset) - "GET /api/v1/metadata/?include_data_sources=false HTTP/1.1" 200 OK
Server is up. Indexing files in data/tomo/scratch/...
  Overwriting '/'
```

The important thing to grab here is the URL with the api\_key:

`**http://127.0.0.1:8000?api_key=ee7caca056af09c62993ffa789689bf181d41a4e885544c070e68b32339ed1c0**`

In your web browser, open the URL you see in your terminal to activate the Tiled session. The Zarr files that are indexed here and viewable in the main Tiled UI are loadable from the Tiled Browser widget in the React App.

## `itk-vtk-viewer`

#### Install

[Official Documentation](https://kitware.github.io/itk-vtk-viewer/docs/cli.html)

[Install or update Node.js](https://nodejs.org/en/download)

Then, install `itk-vtk-viewer`

**npm version**

```
npm install itk-vtk-viewer -g
```

**specific version**  
The `itk-vtk-viewer` interface is customizable, so you can install a different version following these steps:

#### Run

Once you have a version of `itk-vtk-viewer` installed in your environment, you can start it in the command line with the following command:

```
itk-vtk-viewer --port 8082
```

We specify `--port 8082`, as this is what the React App is configured to listen to by default.

### Start the `React` App

Run in your terminal

```
cd /orchestration/flows/bl832/view_recon_app/
npm run dev
```

```
  VITE v6.0.11  ready in 139 ms

  ➜  Local:   http://localhost:5174/
  ➜  Network: use --host to expose
  ➜  press h + enter to show help
```

Navigate to http://localhost:5174/ in your web browser