/**
 * A cached TRS transform: position + rotation + scale with a lazily-recomputed local matrix. This is
 * the building block reused by the scene graph.
 *
 * @packageDocumentation
 */

import { Mat4 } from "./mat4.js";
import { Quat } from "./quat.js";
import { Vec3 } from "./vec3.js";

/**
 * Translation/rotation/scale with a dirty-flagged matrix cache.
 *
 * @example
 * ```ts
 * const t = new Transform();
 * t.position.set(1, 2, 3);
 * t.setDirty();
 * const m = t.matrix(); // recomputed once, then cached
 * ```
 */
export class Transform {
  public readonly position = new Vec3(0, 0, 0);
  public readonly rotation = new Quat();
  public readonly scale = new Vec3(1, 1, 1);

  readonly #matrix = new Mat4();
  #dirty = true;

  /** Mark the cached matrix stale (call after mutating position/rotation/scale). */
  public setDirty(): this {
    this.#dirty = true;
    return this;
  }

  /** Whether the cached matrix is stale. */
  public get dirty(): boolean {
    return this.#dirty;
  }

  /** The local TRS matrix, recomposed only when dirty. */
  public matrix(): Mat4 {
    if (this.#dirty) {
      this.#matrix.compose(this.position, this.rotation, this.scale);
      this.#dirty = false;
    }
    return this.#matrix;
  }

  /** Copy TRS from another transform and mark dirty. */
  public copy(other: Transform): this {
    this.position.copy(other.position);
    this.rotation.copy(other.rotation);
    this.scale.copy(other.scale);
    return this.setDirty();
  }
}
