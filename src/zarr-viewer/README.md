# OME-Zarr Viewer

Standalone WebGPU volume viewer for OME-NGFF / Zarr stores. Copied from Prism Demo 26 — no dependency on the Prism monorepo at runtime.

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

Copy this entire `zarr-viewer/` folder into the other repo. It is self-contained:

| Path | Role |
|------|------|
| `src/io/` | Custom OME-Zarr reader (no npm `zarr`) |
| `src/render/` | `VolumeRenderer` + TF / opacity UI helpers |
| `src/core`, `math`, `scene`, `controls` | Slim supporting libs |
| `src/ome-zarr-viewer.ts` | Full Cosmovis-style UI |
| `src/main.ts` | App entry |

Aliases (`@zarr-viewer/*`) are defined in `tsconfig.json` and `vite.config.ts`.

```bash
npm run typecheck
npm run build
```

## Notes

- Prism packages under `../packages` are **not** modified or linked.
- Codecs: raw, gzip/zlib (`DecompressionStream`), Blosc+LZ4 (in-repo).
- Zarr v2 / OME-NGFF multiscales; Zarr v3 is not implemented.
