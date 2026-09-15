/**
 * A tiny, strongly-typed synchronous event emitter.
 *
 * The event map is a record of `eventName -> payloadType`, giving full type-safety on both `emit`
 * and `on`. Listeners are stored per-event; `emit` iterates a snapshot so listeners may safely
 * unsubscribe during dispatch.
 *
 * @packageDocumentation
 */

/** A function invoked with an event payload. */
export type Listener<T> = (payload: T) => void;

/** Function returned by {@link Emitter.on} that removes the listener when called. */
export type Unsubscribe = () => void;

/**
 * A synchronous, type-safe event emitter.
 *
 * @typeParam Events - A map of event name to payload type.
 *
 * @example
 * ```ts
 * const bus = new Emitter<{ resize: { w: number; h: number }; tick: number }>();
 * const off = bus.on("resize", ({ w, h }) => console.log(w, h));
 * bus.emit("resize", { w: 800, h: 600 });
 * off();
 * ```
 */
export class Emitter<Events extends Record<string, unknown>> {
  readonly #listeners = new Map<keyof Events, Set<Listener<never>>>();

  /**
   * Subscribe to an event.
   * @returns An {@link Unsubscribe} function.
   */
  public on<K extends keyof Events>(event: K, listener: Listener<Events[K]>): Unsubscribe {
    let set = this.#listeners.get(event);
    if (!set) {
      set = new Set();
      this.#listeners.set(event, set);
    }
    set.add(listener as Listener<never>);
    return () => this.off(event, listener);
  }

  /** Subscribe to an event for a single emission, then auto-unsubscribe. */
  public once<K extends keyof Events>(event: K, listener: Listener<Events[K]>): Unsubscribe {
    const off = this.on(event, (payload) => {
      off();
      listener(payload);
    });
    return off;
  }

  /** Remove a previously registered listener. */
  public off<K extends keyof Events>(event: K, listener: Listener<Events[K]>): void {
    this.#listeners.get(event)?.delete(listener as Listener<never>);
  }

  /** Synchronously dispatch `payload` to all listeners of `event`. */
  public emit<K extends keyof Events>(event: K, payload: Events[K]): void {
    const set = this.#listeners.get(event);
    if (!set || set.size === 0) return;
    for (const listener of [...set]) {
      (listener as Listener<Events[K]>)(payload);
    }
  }

  /** Remove all listeners for `event`, or all listeners entirely when `event` is omitted. */
  public clear(event?: keyof Events): void {
    if (event === undefined) this.#listeners.clear();
    else this.#listeners.delete(event);
  }

  /** Number of listeners currently registered for `event`. */
  public listenerCount(event: keyof Events): number {
    return this.#listeners.get(event)?.size ?? 0;
  }
}
