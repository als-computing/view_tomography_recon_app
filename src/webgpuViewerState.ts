/**
 * webgpuViewerState.ts
 *
 * The WebGPU counterpart to viewerState.ts: capture / replay the WebGPU OME-Zarr viewer's view state
 * (camera pose + rendering/transfer-function params + cropping) for shareable links. The WebGpu
 * viewer already exposes JSON-serializable get/set for each group (used by the split-view linking),
 * so a snapshot is just those three getters and a replay is the three setters — each guarded so a
 * shape drift between app versions degrades gracefully instead of throwing.
 */

import type { WebGpuViewerInstance } from './WebGpuNative/WebGpuNative';

/** A JSON-safe snapshot of a WebGPU viewer (any group absent if it couldn't be read). */
export interface WebGpuCapturedState {
  camera?: unknown;
  rendering?: Record<string, unknown>;
  cropping?: Record<string, unknown>;
}

/** Snapshot the WebGPU viewer's camera + rendering + cropping into a plain, JSON-safe object. */
export function captureWebGpuViewState(v: WebGpuViewerInstance): WebGpuCapturedState {
  const state: WebGpuCapturedState = {};
  try {
    state.camera = v.getCamera();
  } catch (error) {
    console.warn('captureWebGpuViewState: camera read failed:', error);
  }
  try {
    state.rendering = v.getRendering() as unknown as Record<string, unknown>;
  } catch (error) {
    console.warn('captureWebGpuViewState: rendering read failed:', error);
  }
  try {
    state.cropping = v.getCropping() as unknown as Record<string, unknown>;
  } catch (error) {
    console.warn('captureWebGpuViewState: cropping read failed:', error);
  }
  return state;
}

/** Replay a captured snapshot onto a WebGPU viewer; each group is applied independently and guarded. */
export function applyWebGpuViewState(v: WebGpuViewerInstance, state: WebGpuCapturedState): void {
  if (state.rendering) {
    try {
      v.setRendering(state.rendering as Parameters<WebGpuViewerInstance['setRendering']>[0]);
    } catch (error) {
      console.warn('applyWebGpuViewState: rendering apply failed:', error);
    }
  }
  if (state.cropping) {
    try {
      v.setCropping(state.cropping as Parameters<WebGpuViewerInstance['setCropping']>[0]);
    } catch (error) {
      console.warn('applyWebGpuViewState: cropping apply failed:', error);
    }
  }
  // Camera last so a rendering-driven reframe can't clobber the shared pose.
  if (state.camera) {
    try {
      v.setCamera(state.camera as Parameters<WebGpuViewerInstance['setCamera']>[0]);
    } catch (error) {
      console.warn('applyWebGpuViewState: camera apply failed:', error);
    }
  }
}
