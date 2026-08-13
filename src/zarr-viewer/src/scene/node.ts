/**
 * Scene-graph nodes: a transform hierarchy with cached local/world matrices and dirty-flag
 * propagation so world transforms are recomputed lazily and minimally.
 *
 * @packageDocumentation
 */

import { Vec3, Quat, Mat4 } from "@zarr-viewer/math";

/**
 * A transform node in the scene graph. Holds TRS (translation/rotation/scale) and derives local and
 * world matrices on demand.
 *
 * The `position`, `rotation`, and `scale` fields are plain mutable {@link Vec3}/{@link Quat}
 * objects, so you edit them directly. Matrix accessors detect changes to those fields (via a cheap
 * component snapshot) and only recompose when something actually moved, so calling
 * {@link Node.worldMatrix} every frame is inexpensive for a static hierarchy.
 *
 * @example
 * ```ts
 * const root = new Node("root");
 * const child = new Node("child");
 * root.add(child);
 * child.position.set(1, 0, 0);
 * const world = child.worldMatrix(); // recomposes only because the transform changed
 * ```
 */
export class Node {
  public readonly position = new Vec3(0, 0, 0);
  public readonly rotation = new Quat();
  public readonly scale = new Vec3(1, 1, 1);

  public parent: Node | undefined;
  public readonly children: Node[] = [];

  private readonly _local = new Mat4();
  private readonly _world = new Mat4();

  /** Snapshot of the TRS components at the last local recompose (px,py,pz, qx,qy,qz,qw, sx,sy,sz). */
  private readonly _trs = new Float64Array(10).fill(Number.NaN);

  public constructor(public name = "") {}

  /** Attach `child`, detaching it from any previous parent. Returns `this` for chaining. */
  public add(child: Node): this {
    if (child === this) throw new Error("Node.add: cannot parent a node to itself");
    child.parent?.remove(child);
    child.parent = this;
    this.children.push(child);
    return this;
  }

  /** Detach `child` if it is a direct child of this node. */
  public remove(child: Node): this {
    const i = this.children.indexOf(child);
    if (i !== -1) {
      this.children.splice(i, 1);
      child.parent = undefined;
    }
    return this;
  }

  /**
   * Force the next {@link Node.localMatrix}/{@link Node.worldMatrix} call to recompose, even if the
   * change-detection snapshot would not otherwise notice. Rarely needed directly.
   */
  public markDirty(): void {
    this._trs[0] = Number.NaN;
  }

  /** Returns `true` and refreshes the snapshot if any TRS component changed since the last check. */
  private transformChanged(): boolean {
    const p = this.position;
    const r = this.rotation;
    const s = this.scale;
    const t = this._trs;
    if (
      t[0] === p.x &&
      t[1] === p.y &&
      t[2] === p.z &&
      t[3] === r.x &&
      t[4] === r.y &&
      t[5] === r.z &&
      t[6] === r.w &&
      t[7] === s.x &&
      t[8] === s.y &&
      t[9] === s.z
    ) {
      return false;
    }
    t[0] = p.x;
    t[1] = p.y;
    t[2] = p.z;
    t[3] = r.x;
    t[4] = r.y;
    t[5] = r.z;
    t[6] = r.w;
    t[7] = s.x;
    t[8] = s.y;
    t[9] = s.z;
    return true;
  }

  /** The local TRS matrix (recomposed only when the transform changed). */
  public localMatrix(): Mat4 {
    if (this.transformChanged()) {
      this._local.compose(this.position, this.rotation, this.scale);
    }
    return this._local;
  }

  /** The world matrix (`parent.world * local`), recomputed from the current transform chain. */
  public worldMatrix(): Mat4 {
    const local = this.localMatrix();
    if (this.parent) {
      this._world.multiplyMatrices(this.parent.worldMatrix(), local);
    } else {
      this._world.copy(local);
    }
    return this._world;
  }

  /** Depth-first traversal invoking `visit` on this node and all descendants. */
  public traverse(visit: (node: Node) => void): void {
    visit(this);
    for (const child of this.children) child.traverse(visit);
  }
}
