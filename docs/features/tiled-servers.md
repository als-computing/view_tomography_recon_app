# Choosing a Tiled Server

The header's **Server** dropdown switches which Tiled server the app talks to. Up to three options may
be available (an admin can also lock a deployment to just one — see
[Configuring Tiled Servers](../admin/configuring-tiled-servers.md) — in which case this dropdown won't
appear at all):

| Option | Points at | Login required? | Notes |
|---|---|---|---|
| **Local** | A Tiled server on your own machine (`localhost:8001`) | No | Opens a fixed default scan automatically. Intended for local development/testing — see [Installation (Docker)](../getting-started/installation.md). |
| **Remote** | ALS's staging Tiled server | Yes | Browses `beamlines/bl832/processed`; supports [live notifications](notifications.md) when new data arrives. |
| **Production** | ALS's production Tiled server | Yes | Same processed-data path as Remote; also supports live notifications. |

Switching servers clears your currently open tabs (since they point at data on the old server) and, if
the newly selected server has one configured, automatically reopens its default scan.

## Logging in (Remote / Production)

These two servers require sign-in before browsing or viewing data. In practice this happens through the
**Select Data** browser widget in the header: if you aren't authenticated yet, it shows you a login
screen. The flow redirects you to your identity provider and back to the app once you've signed in —
after that, the **Folder** dropdown and data browser populate normally.

Until you log in, the Folder dropdown shows **"Failed to load folders"** — if you see that, sign in via
the data browser first.

Your session's tokens are refreshed automatically and silently in the background from then on; you
won't need to do anything further until the session eventually expires and you're prompted to sign in
again.

## Folders

The **Folder** dropdown lists the subfolders under the active server's data path (typically per-user or
per-ESAF folders). Selecting one sets where the data browser opens to. While it's loading, it reads
**"Loading folders…"**.
