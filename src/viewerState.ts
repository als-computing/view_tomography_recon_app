/**
 * viewerState.ts
 *
 * The single source of truth for the itk-vtk-viewer view state we know how to read and write:
 *   - camera:    pose (position / focalPoint / viewUp / parallelScale) on the vtk.js view proxy
 *   - rendering: everything that shapes the volume's appearance — colormap, color range (+bounds),
 *                the opacity transfer function (points + gaussians), gradient opacity (+scale),
 *                volume sample distance, blend mode, shadow, interpolation
 *   - cropping:  the ROI cropping planes (+ enabled state)
 *
 * This getter/setter surface is consumed in two places:
 *   - useLinkedViewers imports the `*_MIRRORS` descriptors + `copyCamera` to mirror state between the
 *     two split panes live (subscribing to each property's change event).
 *   - shareable links use `captureViewState` / `applyViewState` to snapshot the state into a URL and
 *     replay it when a viewer loads.
 * Keeping the list here means both features stay in lock-step as the viewer's API grows.
 *
 * All method/event names mirror itk-vtk-viewer's `publicAPI`; the getters/setters default to
 * component 0 of the selected image, which is correct for our one-volume-per-viewer usage.
 */

import type { ItkVtkCamera, ItkVtkViewerInstance } from './ItkVtkNative/ItkVtkNative';

/**
 * A single mirrored property. `key` is its stable name in a serialized snapshot; `events` are the
 * viewer events that announce a change; `read`/`write` move the value in and out of a viewer.
 */
export interface Mirror {
  key: string;
  events: string[];
  read: (v: ItkVtkViewerInstance) => unknown;
  write: (v: ItkVtkViewerInstance, value: unknown) => void;
}

export const RENDERING_MIRRORS: Mirror[] = [
  {
    key: 'colorMap',
    events: ['imageColorMapChanged'],
    read: (v) => v.getImageColorMap(),
    write: (v, x) => v.setImageColorMap(x),
  },
  {
    key: 'colorRange',
    events: ['imageColorRangeChanged'],
    read: (v) => v.getImageColorRange(),
    write: (v, x) => v.setImageColorRange(x as number[]),
  },
  {
    key: 'colorRangeBounds',
    events: ['imageColorRangeBoundsChanged'],
    read: (v) => v.getImageColorRangeBounds(),
    write: (v, x) => v.setImageColorRangeBounds(x as number[]),
  },
  {
    key: 'piecewisePoints',
    events: ['imagePiecewiseFunctionPointsChanged'],
    read: (v) => v.getImagePiecewiseFunctionPoints(),
    write: (v, x) => v.setImagePiecewiseFunctionPoints(x),
  },
  {
    key: 'piecewiseGaussians',
    events: ['imagePiecewiseFunctionGaussiansChanged'],
    read: (v) => v.getImagePiecewiseFunctionGaussians(),
    write: (v, x) => v.setImagePiecewiseFunctionGaussians(x),
  },
  {
    key: 'gradientOpacity',
    events: ['imageGradientOpacityChanged'],
    read: (v) => v.getImageGradientOpacity(),
    write: (v, x) => v.setImageGradientOpacity(x),
  },
  {
    key: 'gradientOpacityScale',
    events: ['imageGradientOpacityScaleChanged'],
    read: (v) => v.getImageGradientOpacityScale(),
    write: (v, x) => v.setImageGradientOpacityScale(x),
  },
  {
    key: 'volumeSampleDistance',
    events: ['imageVolumeSampleDistanceChanged'],
    read: (v) => v.getImageVolumeSampleDistance(),
    write: (v, x) => v.setImageVolumeSampleDistance(x),
  },
  {
    key: 'blendMode',
    events: ['imageBlendModeChanged'],
    read: (v) => v.getImageBlendMode(),
    write: (v, x) => v.setImageBlendMode(x),
  },
  {
    key: 'shadow',
    events: ['toggleImageShadow'],
    read: (v) => v.getImageShadowEnabled(),
    write: (v, x) => v.setImageShadowEnabled(x as boolean),
  },
  {
    key: 'interpolation',
    events: ['toggleImageInterpolation'],
    read: (v) => v.getImageInterpolationEnabled(),
    write: (v, x) => v.setImageInterpolationEnabled(x as boolean),
  },
];

export const CROPPING_MIRRORS: Mirror[] = [
  {
    key: 'croppingPlanes',
    events: ['croppingPlanesChanged', 'resetCroppingPlanes'],
    read: (v) => v.getCroppingPlanes(),
    write: (v, x) => v.setCroppingPlanes(x),
  },
  {
    key: 'croppingEnabled',
    events: ['toggleCroppingPlanes'],
    read: (v) => v.getCroppingPlanesEnabled(),
    write: (v, x) => v.setCroppingPlanesEnabled(x as boolean),
  },
];

/** The four camera-pose fields that fully describe an orbit/parallel view. */
export interface CameraPose {
  position: number[];
  focalPoint: number[];
  viewUp: number[];
  parallelScale: number;
}

/** A snapshot of a viewer's state (any group may be absent if it couldn't be read/serialized). */
export interface CapturedViewState {
  camera?: CameraPose;
  rendering?: Record<string, unknown>;
  cropping?: Record<string, unknown>;
}

export const copyCamera = (from: ItkVtkCamera, to: ItkVtkCamera): void => {
  to.set({
    position: from.getPosition(),
    focalPoint: from.getFocalPoint(),
    viewUp: from.getViewUp(),
    parallelScale: from.getParallelScale(),
  });
};

/** True only for values that survive a JSON round-trip (so a share URL never fails to encode). */
const isJsonSafe = (value: unknown): boolean => {
  if (typeof value === 'undefined') return false;
  try {
    return typeof JSON.stringify(value) === 'string';
  } catch {
    return false;
  }
};

const readGroup = (v: ItkVtkViewerInstance, mirrors: Mirror[]): Record<string, unknown> | undefined => {
  const out: Record<string, unknown> = {};
  for (const mirror of mirrors) {
    try {
      const value = mirror.read(v);
      if (isJsonSafe(value)) out[mirror.key] = value;
    } catch {
      /* property unavailable on this viewer — skip it */
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
};

/**
 * Snapshot a viewer's camera + rendering + cropping into a plain, JSON-safe object. Every accessor
 * is guarded: a getter that throws or returns a non-serializable value is simply omitted, so a
 * snapshot is always encodable even if the viewer's API surface differs from what we expect.
 */
export function captureViewState(v: ItkVtkViewerInstance): CapturedViewState {
  const state: CapturedViewState = {};
  try {
    const camera = v.getViewProxy().getCamera();
    state.camera = {
      position: camera.getPosition(),
      focalPoint: camera.getFocalPoint(),
      viewUp: camera.getViewUp(),
      parallelScale: camera.getParallelScale(),
    };
  } catch (error) {
    console.warn('captureViewState: camera read failed:', error);
  }
  state.rendering = readGroup(v, RENDERING_MIRRORS);
  state.cropping = readGroup(v, CROPPING_MIRRORS);
  return state;
}

const writeGroup = (
  v: ItkVtkViewerInstance,
  mirrors: Mirror[],
  values: Record<string, unknown> | undefined,
): void => {
  if (!values) return;
  for (const mirror of mirrors) {
    if (!(mirror.key in values)) continue;
    try {
      mirror.write(v, values[mirror.key]);
    } catch (error) {
      console.warn(`applyViewState: failed to apply "${mirror.key}":`, error);
    }
  }
}

/**
 * Replay a captured snapshot onto a viewer. Camera is applied first (with the light/render refresh
 * the linked-viewer sync uses); each rendering/cropping setter is guarded independently.
 */
export function applyViewState(v: ItkVtkViewerInstance, state: CapturedViewState): void {
  if (state.camera) {
    try {
      const view = v.getViewProxy();
      view.getCamera().set({
        position: state.camera.position,
        focalPoint: state.camera.focalPoint,
        viewUp: state.camera.viewUp,
        parallelScale: state.camera.parallelScale,
      });
      view.getRenderer().updateLightsGeometryToFollowCamera();
      view.renderLater();
    } catch (error) {
      console.warn('applyViewState: camera apply failed:', error);
    }
  }
  writeGroup(v, RENDERING_MIRRORS, state.rendering);
  writeGroup(v, CROPPING_MIRRORS, state.cropping);
}
