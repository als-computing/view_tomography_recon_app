/**
 * Components attach renderable/simulable data to {@link "./node".Node}s: meshes, cameras, lights,
 * volumes, and physics bodies. Components are plain data; systems (render, sim) consume them.
 *
 * @packageDocumentation
 */

import type { Color3 } from "@zarr-viewer/math";

/** Discriminant for the component union. */
export type ComponentKind = "mesh" | "camera" | "light" | "volume" | "physicsBody";

/** Base component fields. */
export interface ComponentBase {
  readonly kind: ComponentKind;
  enabled: boolean;
}

/** References geometry (by resource id/handle) plus a material id. */
export interface MeshComponent extends ComponentBase {
  readonly kind: "mesh";
  geometryId: string;
  materialId: string;
}

/** A camera: perspective or orthographic projection parameters. */
export interface CameraComponent extends ComponentBase {
  readonly kind: "camera";
  projection: "perspective" | "orthographic";
  /** Vertical field of view in radians (perspective). */
  fovY: number;
  near: number;
  far: number;
}

/** A light source mirroring UsdLux kinds. */
export interface LightComponent extends ComponentBase {
  readonly kind: "light";
  type: "distant" | "sphere" | "rect" | "disk" | "dome";
  intensity: number;
  /** Linear RGB (`Color3` / `Vec3`: x=r, y=g, z=b). */
  color: Color3;
}

/** A scientific volume referencing a `VolumeSource` and a transfer function. */
export interface VolumeComponent extends ComponentBase {
  readonly kind: "volume";
  volumeSourceId: string;
  transferFunctionId: string;
}

/** Binds this node to a `@zarr-viewer/physics` body for simulation-driven transforms. */
export interface PhysicsBodyComponent extends ComponentBase {
  readonly kind: "physicsBody";
  bodyId: string;
}

/** The union of all component types. */
export type Component =
  | MeshComponent
  | CameraComponent
  | LightComponent
  | VolumeComponent
  | PhysicsBodyComponent;
