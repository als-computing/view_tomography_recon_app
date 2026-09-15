# Configuring Tiled Servers

The list of selectable Tiled servers — what shows up in the header dropdown, and what a locked
[deployment](deployment.md) can be pinned to — lives in the repo root's
[`config.yml`](https://github.com/als-computing/view_tomography_recon_app/blob/main/config.yml).
[`src/tiledServers.ts`](https://github.com/als-computing/view_tomography_recon_app/blob/main/src/tiledServers.ts)
just owns the validation/lookup logic on top of it, so editing server addresses doesn't require
touching TypeScript.

`config.yml` is read at **build time** (parsed and inlined into the bundle, the same timing/cost as a
hand-written data file — see `vite-yaml-plugin.js`) — editing it still requires a rebuild, same as
before.

```yaml
tiledServers:
  local:
    label: Local
    apiUrl: http://localhost:8001/api/v1
    processedPath: ""
    defaultFileId: scans/petiole22
    oidcRedirectUrl: http://tiled-test:5174/tomo_viewer/
    supportsStream: false
  # staging: ...
  # production: ...
defaultServerId: local
```

| Field | Meaning |
|---|---|
| `label` | What shows up in the header dropdown. |
| `apiUrl` | The Tiled REST API base, ending in `/api/v1`. Its **host** (e.g. `tiled.als.lbl.gov`) is also what `FIXED_TILED_SERVER` (see [Deployment](deployment.md)) matches against to lock a build to this server. |
| `processedPath` | Parent catalog path whose subfolders populate the folder browser (leave `""` to browse from the catalog root). |
| `defaultFileId` | A scan to auto-open when this server becomes active. Leave `""` to open nothing and let the user browse. |
| `oidcRedirectUrl` | Where this server's login flow redirects back to after authentication. Must exactly match both the app's real served URL (domain + base path) **and** whatever redirect URI is allow-listed on that server's identity provider. |
| `supportsStream` | Whether this server exposes the live-notification WebSocket (`/api/v1/stream/...`). Set `false` to skip opening it (avoids noisy connection errors for servers that don't support it). |

`config.yml`'s `tiledServers` map must have exactly three entries, keyed `local`, `staging`, and
`production` — these three ids are fixed in `src/tiledServers.ts`'s `TiledServerId` type. A missing
entry, or a non-string/non-boolean field, fails the build outright with a clear error rather than
producing a broken runtime.

## Editing a server's address

Edit its entry directly in `config.yml`. If the server requires login, coordinate its
`oidcRedirectUrl` with whoever manages that server's identity provider allowlist **before**
deploying — a mismatch here is a common cause of a broken login redirect (see
[Troubleshooting](../troubleshooting.md)). Then rebuild the app (`npm run build`, or rebuild the
relevant Docker image).

## Locking a deployment to one server

See [Deployment Overview](deployment.md) — pass `FIXED_TILED_SERVER=<hostname>` as a Docker build
argument (e.g. `FIXED_TILED_SERVER=tiled.als.lbl.gov`) to hide the dropdown entirely and lock the app
to whichever `config.yml` entry has a matching `apiUrl` host. A hostname that doesn't match any
configured server fails the build, rather than silently producing an unlocked image.
