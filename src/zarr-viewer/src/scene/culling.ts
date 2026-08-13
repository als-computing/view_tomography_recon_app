/**
 * View-frustum culling and world-space bounds for visibility queries.
 *
 * Nodes do not store geometry AABBs yet; {@link computeWorldBounds} therefore treats each node as a
 * unit cube centered at the origin in local space (the same convention as `@zarr-viewer/render`'s analytic
 * primitives), transformed by that node's world matrix.
 *
 * @packageDocumentation
 */

import { Aabb, type Frustum, Vec3 } from "@zarr-viewer/math";
import type { Node } from "./node.js";

const _corner = new Vec3();
const _localMin = new Vec3(-0.5, -0.5, -0.5);
const _localMax = new Vec3(0.5, 0.5, 0.5);
const _nodeBox = new Aabb();

/**
 * Expand `out` by the eight corners of a local AABB after transforming them by `node`'s world
 * matrix. Used internally by {@link computeWorldBounds}.
 */
function expandByTransformedBox(out: Aabb, node: Node, localMin: Vec3, localMax: Vec3): void {
  const m = node.worldMatrix();
  const e = m.elements;
  for (let i = 0; i < 8; i++) {
    const x = i & 1 ? localMax.x : localMin.x;
    const y = i & 2 ? localMax.y : localMin.y;
    const z = i & 4 ? localMax.z : localMin.z;
    // Column-major point transform (w = 1).
    _corner.set(
      e[0]! * x + e[4]! * y + e[8]! * z + e[12]!,
      e[1]! * x + e[5]! * y + e[9]! * z + e[13]!,
      e[2]! * x + e[6]! * y + e[10]! * z + e[14]!,
    );
    out.expandByPoint(_corner);
  }
}

/**
 * Compute the world-space AABB of a node subtree into `out`. Each node contributes a unit cube
 * (`[-0.5, 0.5]^3` in local space) transformed by its world matrix.
 *
 * @example
 * ```ts
 * const bounds = computeWorldBounds(scene.root, new Aabb());
 * ```
 */
export function computeWorldBounds(root: Node, out: Aabb): Aabb {
  out.makeEmpty();
  root.traverse((node) => {
    expandByTransformedBox(out, node, _localMin, _localMax);
  });
  return out;
}

/**
 * Cull a node subtree against a camera frustum, returning those nodes whose unit-cube world bounds
 * are at least partially inside. The root itself is included when visible.
 *
 * @example
 * ```ts
 * const visible = cullFrustum(scene.root, frustum);
 * ```
 */
export function cullFrustum(root: Node, frustum: Frustum): Node[] {
  const visible: Node[] = [];
  root.traverse((node) => {
    _nodeBox.makeEmpty();
    expandByTransformedBox(_nodeBox, node, _localMin, _localMax);
    if (frustum.intersectsAabb(_nodeBox)) visible.push(node);
  });
  return visible;
}
