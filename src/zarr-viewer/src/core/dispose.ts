/**
 * Deterministic resource cleanup primitives.
 *
 * WebGPU buffers, textures, bind groups, and simulation state must be released explicitly. These
 * helpers provide a uniform {@link Disposable} contract and a {@link DisposableScope} that disposes
 * children in reverse (LIFO) order, mirroring stack semantics.
 *
 * @packageDocumentation
 */

/** Anything that owns resources requiring explicit release. */
export interface Disposable {
  dispose(): void;
}

/** A function form of {@link Disposable}. */
export type DisposeFn = () => void;

function toDisposeFn(d: Disposable | DisposeFn): DisposeFn {
  return typeof d === "function" ? d : () => d.dispose();
}

/**
 * Collects {@link Disposable}s and releases them in reverse registration order. Safe to dispose
 * more than once (subsequent calls are no-ops).
 *
 * @example
 * ```ts
 * const scope = new DisposableScope();
 * scope.add(() => buffer.destroy());
 * scope.add(texture); // Disposable
 * // ...later
 * scope.dispose(); // texture disposed first, then buffer
 * ```
 */
export class DisposableScope implements Disposable {
  #items: DisposeFn[] = [];
  #disposed = false;

  /** Register a child resource; returns it for convenient chaining. */
  public add<T extends Disposable | DisposeFn>(item: T): T {
    if (this.#disposed) {
      toDisposeFn(item)();
      return item;
    }
    this.#items.push(toDisposeFn(item));
    return item;
  }

  /** Whether this scope has already been disposed. */
  public get disposed(): boolean {
    return this.#disposed;
  }

  /** Dispose all registered resources in reverse order. Idempotent. */
  public dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (let i = this.#items.length - 1; i >= 0; i--) {
      this.#items[i]!();
    }
    this.#items.length = 0;
  }
}
