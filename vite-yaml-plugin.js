import { readFileSync } from 'node:fs';
import yaml from 'js-yaml';

/**
 * vite-yaml-plugin.js
 *
 * Minimal Vite/Rollup plugin: imports of `.yml`/`.yaml` files are parsed at build time and inlined
 * as a plain JS object literal — `js-yaml` runs here, in Node, at build/test time only, never shipped
 * to the browser bundle (same zero-runtime-cost shape as a hand-written TS data file). Shared between
 * vite.config.js (real dev/build) and vitest.config.ts (unit tests), so both resolve `.yml` imports
 * identically — see src/tiledServers.ts's import of the root config.yml.
 */
export function yamlPlugin() {
  return {
    name: 'yaml-loader',
    transform(_code, id) {
      if (!id.endsWith('.yml') && !id.endsWith('.yaml')) return null;
      const data = yaml.load(readFileSync(id, 'utf-8'));
      return { code: `export default ${JSON.stringify(data)};`, map: { mappings: '' } };
    },
  };
}
