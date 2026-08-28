import { resolve } from "node:path";
import { defineConfig } from "vite";
import { PETIOLE_ZARR_MOUNT, zarrStaticPlugin } from "./vite-zarr-static";

const src = resolve(import.meta.dirname, "src");

export default defineConfig({
  root: ".",
  plugins: [zarrStaticPlugin([PETIOLE_ZARR_MOUNT])],
  resolve: {
    alias: {
      "@zarr-viewer/core": resolve(src, "core/index.ts"),
      "@zarr-viewer/math": resolve(src, "math/index.ts"),
      "@zarr-viewer/scene": resolve(src, "scene/index.ts"),
      "@zarr-viewer/controls": resolve(src, "controls/index.ts"),
      "@zarr-viewer/io": resolve(src, "io/index.ts"),
      "@zarr-viewer/render": resolve(src, "render/index.ts"),
      "@zarr-viewer/fx": resolve(src, "fx/src/index.ts"),
    },
  },
  server: {
    port: 5181,
    open: true,
    fs: {
      allow: [
        resolve(import.meta.dirname),
        // Allow serving the default petiole store (override via ZARR_ROOT env).
        "/Users/david/Documents/data/tomo/scratch",
      ],
    },
  },
});
