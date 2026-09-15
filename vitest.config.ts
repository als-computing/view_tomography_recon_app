import { defineConfig } from "vitest/config";
import { yamlPlugin } from "./vite-yaml-plugin.js";

export default defineConfig({
  // Shared with vite.config.js so `.yml` imports (e.g. src/tiledServers.ts's config.yml) resolve
  // identically under `vitest run` as they do in real dev/build.
  plugins: [yamlPlugin()],
  test: {
    include: ["src/**/test/**/*.spec.ts"],
    exclude: ["src/zarr-viewer/**"],
    environment: "happy-dom",
  },
});
