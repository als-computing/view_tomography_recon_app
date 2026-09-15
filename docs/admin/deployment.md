# Deployment Overview

This page is for whoever is deploying the app to a shared server (e.g. ALS's `hub.als.lbl.gov`), not
for end users viewing their own data locally. For local use, see
[Installation (Docker)](../getting-started/installation.md).

## Published images

Every push to `main` (or a `v*` tag) builds and publishes **three** images to `ghcr.io`, all from the
same multi-stage `react/Dockerfile`, differing only in build-time configuration:

| Tag | Base path | Tiled server | Server dropdown |
|---|---|---|---|
| `:local` | `/tomo_viewer/` | Configurable at runtime (persisted in the browser) | Shown — full Local/Remote/Production switcher |
| `:als-prod` | `/bl832/tomo_viewer/` | Locked to production (`tiled.als.lbl.gov`) | Hidden |
| `:als-staging` | `/bl832/tomo_viewer_staging/` | Locked to staging (`tiled-staging.als.lbl.gov`) | Hidden |

All three serve static, production-built assets via nginx (gzip compression, immutable long-lived
caching on hashed asset filenames, `index.html` never cached) — none of them run the Vite dev server.

```bash
docker pull ghcr.io/als-computing/view_tomography_recon_app:als-prod
docker run -d -p 8080:80 ghcr.io/als-computing/view_tomography_recon_app:als-prod
```

The container always listens on port 80 internally — map it to whatever host port you need with
`-p <host-port>:80`. None of the three images terminate TLS themselves; that's expected to happen
upstream (e.g. at ALS's own reverse proxy/ingress) before traffic reaches the container.

!!! warning "HTTPS is required for the WebGPU renderer"
    The WebGPU renderer needs a [secure context](https://developer.mozilla.org/en-US/docs/Web/Security/Secure_Contexts)
    (HTTPS, or `localhost`). Serve `:als-prod`/`:als-staging` behind HTTPS, or the app will silently fall
    back to the [ITK/VTK renderer](../features/itk-vtk-viewer.md) for every user.

## Why three images instead of one configurable image

- **`:local`** matches today's local-dev experience exactly — anyone can point it at any Tiled server
  via the dropdown, and it defaults to `/tomo_viewer/` so it drops into the existing `docker-compose.yml`
  setup unchanged.
- **`:als-prod`** and **`:als-staging`** are locked, single-purpose deployments: no dropdown means no risk of
  someone accidentally pointing a "production" deployment at staging data (or vice versa), and each has
  its own base path so both can run side-by-side on the same host without colliding.

## Building a custom image yourself

If you need a deployment this table doesn't cover, build directly with `docker build`, passing your own
`BASE_PATH` and (optionally) `FIXED_TILED_SERVER`:

```bash
docker build \
  --target prod \
  --build-arg BASE_PATH=/your/custom/path/ \
  --build-arg FIXED_TILED_SERVER=tiled.als.lbl.gov \
  -t my-custom-image \
  -f react/Dockerfile .
```

- `BASE_PATH` — must include both a leading and trailing slash. This is baked into the built JS/CSS
  asset paths and nginx's serving location — it can't be changed after the image is built.
- `FIXED_TILED_SERVER` — a configured Tiled server's hostname (matched against the `apiUrl` host of an
  entry in [`config.yml`](https://github.com/als-computing/view_tomography_recon_app/blob/main/config.yml)
  — e.g. `tiled.als.lbl.gov` or `tiled-staging.als.lbl.gov`). Leave unset for a fully configurable
  dropdown, like `:local`. A hostname that doesn't match any configured server fails the build
  outright, rather than silently producing an unlocked image.

See [Configuring Tiled Servers](configuring-tiled-servers.md) to add a new server option before locking
an image to it.

## Local development is unaffected

`docker-compose.yml`'s `react` service is pinned to the Dockerfile's `dev` stage
(`target: dev`) — `docker compose up -d` still runs the Vite dev server exactly as before. The `prod`
stage (used by the published images above) is never built by `docker compose` unless you ask for it
explicitly:

```bash
docker build --target prod --build-arg BASE_PATH=/tomo_viewer/ -f react/Dockerfile . -t test-prod
```
