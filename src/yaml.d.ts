// `.yml`/`.yaml` imports are parsed at build time into a plain JS object literal by
// vite-yaml-plugin.js (shared by vite.config.js and vitest.config.ts) — see src/tiledServers.ts.
declare module '*.yml' {
  const data: unknown;
  export default data;
}
declare module '*.yaml' {
  const data: unknown;
  export default data;
}
