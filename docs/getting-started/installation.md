# Installation (Docker)

This is the recommended way to run the app — it starts the React app, a local Tiled server, and an
nginx reverse proxy together with one command.

## 1. Install Docker

Download and install [Docker Desktop](https://www.docker.com/) if you don't already have it.

## 2. Clone the repository

```bash
git clone https://github.com/als-computing/view_tomography_recon_app.git
cd view_tomography_recon_app
```

## 3. Point the app at your data

Create a `.env` file in the repo root (or copy `.env.example`) and set `DATA_PATH` to the **parent**
directory of your reconstructed datasets:

```bash title=".env"
DATA_PATH=/absolute/path/to/your/reconstructions
```

The local `tiled` service serves that folder directly (`tiled serve directory ... --public`) — there's
no registration step, no API key, and no separate Tiled checkout to manage. Every subfolder under
`DATA_PATH` shows up as a dataset by name in the app.

!!! tip "Datasets with awkward on-disk names or scattered locations"
    If your reconstructions live in oddly-named folders, or aren't all under one parent directory, you
    don't need to rename or copy anything. Create a `docker-compose.override.yml` (gitignored,
    machine-specific — Compose merges it in automatically) that adds one bind mount per dataset:

    ```yaml title="docker-compose.override.yml"
    services:
      tiled:
        volumes:
          - /absolute/path/to/rec2026..._petiole22.zarr:/storage/data/scans/petiole22.zarr:ro
    ```

    Each mount gives that dataset a clean, friendly name (`petiole22`, here) in the catalog, independent
    of its real path or filename.

## 4. Build and start

```bash
docker compose up -d
```

This builds the React app's development image the first time (subsequent starts are fast) and starts
three services in the background: `react`, `tiled`, and `nginx`.

Check that everything came up:

```bash
docker compose ps
```

```text
NAME                                 IMAGE                              COMMAND                   SERVICE   STATUS
view_tomography_recon_app-nginx-1    nginx:stable                       "/docker-entrypoint.…"    nginx     Up
view_tomography_recon_app-react-1    view_tomography_recon_app-react    "npm run dev -- --ho…"    react     Up
view_tomography_recon_app-tiled-1    ghcr.io/bluesky/tiled:0.2.16       "tiled serve directo…"    tiled     Up
```

## 5. Open the app

Go to **[http://localhost:5174/tomo_viewer/](http://localhost:5174/tomo_viewer/)**.

Tiled runs in public/anonymous mode for reading, so there's no login step for the local server — select
**Local** in the header's server dropdown and your datasets (from `DATA_PATH`) should appear in the
Tiled browser widget. Continue to [Loading Your First Dataset](first-dataset.md).

!!! note "Accessing from another computer"
    You can reach the app from other machines on your network by using your computer's LAN/WAN IP
    address instead of `localhost` (find yours at [wanip.info](http://wanip.info/) or via your OS's
    network settings).

## Updating your data path or restarting

If you change `.env` (e.g. a new `DATA_PATH`), pick it up with:

```bash
docker compose up -d --force-recreate
```

To rebuild just the React app after pulling new code, without touching Tiled or nginx:

```bash
docker compose build react && docker compose up -d react
```

To view logs for all services, or just one:

```bash
docker compose logs           # everything
docker compose logs -f tiled  # just Tiled, follow mode
```

If you ever need the write-capable Tiled API key (for modifying data through Tiled directly, not needed
for normal viewing), it's printed at startup — `docker compose logs tiled`.

To stop everything:

```bash
docker compose down
```
