/**
 * config.ts
 *
 * Build-time-only app configuration read from `VITE_*` env vars (Vite auto-inlines these into
 * `import.meta.env` at build time — see src/tiledServers.ts's FIXED_SERVER_ID for the same pattern).
 */

/**
 * URL of the user documentation site (MkDocs — see the repo root's `mkdocs.yml`/`docs/`), opened in
 * the header's Docs button via an in-app iframe.
 *
 * Deliberately **relative to the app's own base path** by default — `${BASE_URL}docs/` (e.g.
 * `/bl832/tomo_viewer/docs/`) — never a hardcoded host/FQDN. The docs site is built and served
 * alongside the app itself (Dockerfile's `docs` stage, copied into `prod` under that same
 * path; the Vite dev server proxies it to the `docs` container — see vite.config.js), so this one
 * relative path resolves correctly on every deployment (`:local`, `:als-prod`, `:als-staging`) and in
 * local dev, with no per-environment override needed.
 *
 * Set `VITE_DOCS_URL` at build time only to point at a genuinely separately-hosted docs site instead,
 * or to `''` to hide the Docs button entirely.
 */
export const DOCS_URL: string =
  import.meta.env.VITE_DOCS_URL?.trim() ?? `${import.meta.env.BASE_URL}docs/`;
