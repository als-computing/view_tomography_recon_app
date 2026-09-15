/**
 * The `Scene`: a root {@link "./node".Node} plus component registries and queries.
 *
 * @packageDocumentation
 */

import { Node } from "./node.js";
import type { Component, ComponentKind } from "./components.js";

/** A `(node, component)` pair as returned by {@link Scene.query}. */
export interface ComponentEntry {
  node: Node;
  component: Component;
}

/**
 * A renderable/simulable scene: a transform hierarchy rooted at {@link Scene.root} plus flat
 * component registries indexed by {@link ComponentKind} for fast system queries (render, physics).
 *
 * @example
 * ```ts
 * const scene = new Scene();
 * const cam = new Node("cam");
 * scene.root.add(cam);
 * scene.attach(cam, { kind: "camera", enabled: true, projection: "perspective", fovY: 1, near: 0.1, far: 1000 });
 * for (const { node, component } of scene.query("camera")) {  }
 * ```
 */
export class Scene {
  /** The scene root node. */
  public readonly root: Node = new Node("root");

  private readonly byKind = new Map<ComponentKind, ComponentEntry[]>();

  /** Attach a component to a node, registering it for {@link Scene.query} lookups. */
  public attach(node: Node, component: Component): void {
    let list = this.byKind.get(component.kind);
    if (!list) {
      list = [];
      this.byKind.set(component.kind, list);
    }
    list.push({ node, component });
  }

  /**
   * Remove components for `node` from the registries. If `kind` is omitted, all kinds attached to
   * the node are cleared. Does not remove the node from the transform hierarchy.
   */
  public detach(node: Node, kind?: ComponentKind): void {
    if (kind) {
      const list = this.byKind.get(kind);
      if (!list) return;
      this.byKind.set(
        kind,
        list.filter((e) => e.node !== node),
      );
      return;
    }
    for (const [k, list] of this.byKind) {
      this.byKind.set(
        k,
        list.filter((e) => e.node !== node),
      );
    }
  }

  /** Enumerate `(node, component)` pairs for a given component kind (empty if none). */
  public query(kind: ComponentKind): readonly ComponentEntry[] {
    return this.byKind.get(kind) ?? [];
  }
}
