# OME-Zarr Viewer

WebGPU volume viewer for OME-NGFF / Zarr stores, embedded in the parent `view_tomography_recon_app` React app via the `@zarr-viewer/*` path aliases (see `vite.config.js` at the repo root). Also runs standalone (this folder's own `npm run dev`) for isolated development.

## Requirements

- Node 20+
- A browser with WebGPU (Chrome / Edge recommended)
- Optional: a local `.zarr` directory to serve during development

## Quick start

```bash
cd zarr-viewer
npm install
npm run dev
```

Opens on [http://localhost:5181](http://localhost:5181).

### Point at a local dataset

Either:

1. Set `ZARR_ROOT` to your OME-Zarr directory (served at `/datasets/petiole.zarr`):

   ```bash
   ZARR_ROOT=/path/to/my.zarr npm run dev
   ```

2. Or edit `root` in [`vite-zarr-static.ts`](vite-zarr-static.ts).

3. Or in the app: **Open** (File System Access) / `?zarr=https://…`.

The Vite plugin serves Zarr keys as **raw bytes** (required for extensionless chunks). Do not use Vite `/@fs` for Zarr.

## Use in another project

This is exactly how the parent `view_tomography_recon_app` React app already consumes it — no published package, no build step of its own required by the consumer: the parent's `vite.config.js` points the `@zarr-viewer/*` aliases straight at this folder's `src/`, and `App.jsx` imports `run()` from the viewer module directly. To reuse it elsewhere, copy this entire `zarr-viewer/` folder into the other repo and set up the same aliases (defined here in `tsconfig.json` and `vite.config.ts`) in the consumer's own config. It is self-contained — no dependency on anything else in this monorepo at runtime.

| Path | Role |
|------|------|
| `src/io/` | Custom OME-Zarr reader (no npm `zarr`) |
| `src/render/` | `VolumeRenderer`, render graph, post-processing, GPU resource management |
| `src/core`, `math`, `scene`, `controls` | Slim supporting libs |
| `src/viewer/WebGpuVolumeViewer.ts` | The viewer's public entry point (`run()` → `WebGpuViewerInstance`) — orchestrates everything below |
| `src/viewer/camera/`, `interaction/`, `rendering/`, `ui/`, `volume/` | Camera controls, pointer/crop-drag interaction, rendering-state helpers, the built-in HUD, and volume/mask/ROI loading, respectively — `WebGpuVolumeViewer.ts` composes these rather than being a monolith itself |
| `src/ome-zarr-viewer.ts` | Thin re-export shim (kept only so existing import paths in the parent app don't need to change) — the real implementation is `src/viewer/WebGpuVolumeViewer.ts` above |
| `src/main.ts` | Standalone dev-server entry (not used when embedded in the parent app) |

Aliases (`@zarr-viewer/*`) are defined in `tsconfig.json` and `vite.config.ts`.

```bash
npm run typecheck
npm run build
```

## Notes

- Prism packages under `../packages` are **not** modified or linked.
- Codecs: raw, gzip/zlib (`DecompressionStream`), Blosc+LZ4 (in-repo).
- Zarr v2 / OME-NGFF multiscales; Zarr v3 is not implemented.
