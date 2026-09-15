#!/usr/bin/env node
/**
 * validate-fixed-tiled-server.mjs
 *
 * Real build-time gate for FIXED_TILED_SERVER (see react/Dockerfile's `build` stage). A bad hostname
 * here can't be caught by src/tiledServers.ts's own runtime check alone — `vite build` only bundles
 * JS, it never executes the app's module graph, so a `throw` at module scope in a browser-only module
 * doesn't fail the build; it would only surface later, as a crashed page, once someone actually opens
 * the deployed image in a browser. Running this script as its own build step turns that into a real
 * CI/Docker-build failure instead.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import yaml from 'js-yaml';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixedServer = (process.env.VITE_FIXED_TILED_SERVER ?? '').trim();

if (!fixedServer) {
  // Unset — the :local image's default (full switcher). Nothing to validate.
  process.exit(0);
}

const config = yaml.load(readFileSync(resolve(repoRoot, 'config.yml'), 'utf-8'));
const servers = config?.tiledServers ?? {};

const hostOf = (apiUrl) => {
  try {
    return new URL(apiUrl).host;
  } catch {
    return '';
  }
};

const hosts = Object.fromEntries(Object.entries(servers).map(([id, s]) => [id, hostOf(s.apiUrl)]));
const matchedId = Object.keys(hosts).find((id) => hosts[id] === fixedServer);

if (!matchedId) {
  console.error(
    `\nFIXED_TILED_SERVER ("${fixedServer}") doesn't match any configured server's host in config.yml.\n` +
      `Configured hosts: ${Object.values(hosts).join(', ')}\n`,
  );
  process.exit(1);
}

console.log(`FIXED_TILED_SERVER "${fixedServer}" matches config.yml's "${matchedId}" entry.`);
