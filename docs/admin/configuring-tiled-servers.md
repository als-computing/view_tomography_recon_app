# Configuring Tiled Servers

The list of selectable Tiled servers — what shows up in the header dropdown, and what a locked
[deployment](deployment.md) can be pinned to — lives entirely in one file:
[`src/tiledServers.ts`](https://github.com/als-computing/view_tomography_recon_app/blob/main/src/tiledServers.ts).

There's no environment variable for this. It's a plain TypeScript array (`TILED_SERVERS`), edited and
rebuilt like any other source change:

```ts
export const TILED_SERVERS: readonly TiledServer[] = [
  {
    id: 'local',
    label: 'Local',
    apiUrl: 'http://localhost:8001/api/v1',
    processedPath: '',
    defaultFileId: 'scans/petiole22',
    oidcRedirectUrl: 'http://tiled-test:5174/tomo_viewer/',
    supportsStream: false,
  },
  // ...
];
```

| Field | Meaning |
|---|---|
| `id` | Internal identifier — also what `FIXED_TILED_SERVER` (see [Deployment](deployment.md)) matches against. |
| `label` | What shows up in the header dropdown. |
| `apiUrl` | The Tiled REST API base, ending in `/api/v1`. |
| `processedPath` | Parent catalog path whose subfolders populate the folder browser (leave `''` to browse from the catalog root). |
| `defaultFileId` | A scan to auto-open when this server becomes active. Leave `''` to open nothing and let the user browse. |
| `oidcRedirectUrl` | Where this server's login flow redirects back to after authentication. Must exactly match both the app's real served URL (domain + base path) **and** whatever redirect URI is allow-listed on that server's identity provider. |
| `supportsStream` | Whether this server exposes the live-notification WebSocket (`/api/v1/stream/...`). Set `false` to skip opening it (avoids noisy connection errors for servers that don't support it). |

## Adding a new server

1. Add a new entry to `TILED_SERVERS` with a new `id`.
2. Add that `id` to the `TiledServerId` union type at the top of the file.
3. If the server requires login, coordinate its `oidcRedirectUrl` with whoever manages that server's
   identity provider allowlist **before** deploying — a mismatch here is the most common cause of a
   broken login redirect (see [Troubleshooting](../troubleshooting.md)).
4. Rebuild the app (`npm run build`, or rebuild the relevant Docker image).

## Locking a deployment to one server

See [Deployment Overview](deployment.md) — pass `FIXED_TILED_SERVER=<id>` as a Docker build argument to
hide the dropdown entirely and lock the app to that one server.
