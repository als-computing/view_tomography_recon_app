import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

const src = resolve(import.meta.dirname, "src");

export default defineConfig({
  resolve: {
    alias: {
      "@zarr-viewer/core": resolve(src, "core/index.ts"),
      "@zarr-viewer/math": resolve(src, "math/index.ts"),
      "@zarr-viewer/io": resolve(src, "io/index.ts"),
      "@prism/render": resolve(src, "render/index.ts"),
      "@prism/fx": resolve(src, "fx/src/index.ts"),
      "@prism/core": resolve(src, "core/index.ts"),
      "@prism/math": resolve(src, "math/index.ts"),
    },
  },
  test: {
    include: ["src/**/test/**/*.spec.ts"],
    environment: "node",
  },
});
