/**
 * Re-export shim: the WebGPU OME-Zarr viewer's implementation lives in
 * {@link ./viewer/WebGpuVolumeViewer.ts}. Kept at this path so `main.ts`,
 * `WebGpuNative.tsx`, and `useLinkedWebGpuViewers.ts` don't need an import-path change.
 */
export * from "./viewer/WebGpuVolumeViewer.js";
