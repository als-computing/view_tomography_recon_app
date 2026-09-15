/**
 * Rebindable input mapping: abstract named "actions" and "axes" over keyboard (and later pointer /
 * gamepad) so controllers read intent, not raw devices.
 *
 * Binding strings use KeyboardEvent `code` values (`KeyW`, `Space`, `ShiftLeft`, …). Call
 * {@link InputMap.dispose} when tearing down a demo to detach listeners.
 *
 * @packageDocumentation
 */

/** A binding source specification (e.g. `"KeyW"`, `"Space"`, `"ShiftLeft"`). */
export type Binding = string;

interface AxisBinding {
  positive: readonly Binding[];
  negative: readonly Binding[];
}

/**
 * Maps physical inputs to named actions/axes.
 *
 * @example
 * ```ts
 * const input = new InputMap(canvas);
 * input.bindAction("jump", ["Space"]);
 * input.bindAxis("moveX", { positive: ["KeyD"], negative: ["KeyA"] });
 * if (input.action("jump")) jump();
 * const x = input.axis("moveX"); // -1 … 1
 * ```
 */
export class InputMap {
  private readonly actions = new Map<string, readonly Binding[]>();
  private readonly axes = new Map<string, AxisBinding>();
  private readonly down = new Set<string>();
  private readonly onKeyDown: EventListener;
  private readonly onKeyUp: EventListener;
  private readonly onBlur: EventListener;
  private disposed = false;

  private readonly target: EventTarget;

  /**
   * Create an input map. Keyboard events are listened on the element's window when available
   * (so a canvas with pointer capture still receives keys); otherwise on `element` itself (tests /
   * non-DOM hosts).
   */
  public constructor(public readonly element: HTMLElement) {
    this.target = (element.ownerDocument?.defaultView as EventTarget | null | undefined) ?? element;
    this.onKeyDown = (e) => {
      this.down.add((e as KeyboardEvent).code);
    };
    this.onKeyUp = (e) => {
      this.down.delete((e as KeyboardEvent).code);
    };
    this.onBlur = () => {
      this.down.clear();
    };
    this.target.addEventListener("keydown", this.onKeyDown);
    this.target.addEventListener("keyup", this.onKeyUp);
    this.target.addEventListener("blur", this.onBlur);
  }

  /** Bind a digital action to one or more sources (replaces any previous binding for `name`). */
  public bindAction(name: string, sources: readonly Binding[]): this {
    this.actions.set(name, sources.slice());
    return this;
  }

  /** Bind a bipolar axis (replaces any previous binding for `name`). */
  public bindAxis(
    name: string,
    sources: { positive: readonly Binding[]; negative: readonly Binding[] },
  ): this {
    this.axes.set(name, {
      positive: sources.positive.slice(),
      negative: sources.negative.slice(),
    });
    return this;
  }

  /** Whether an action is currently active (any of its sources is held). Unknown actions are false. */
  public action(name: string): boolean {
    const sources = this.actions.get(name);
    if (!sources) return false;
    for (const s of sources) if (this.down.has(s)) return true;
    return false;
  }

  /**
   * Current value of an axis in `[-1, 1]`. Positive and negative cancel; both pressed → 0.
   * Unknown axes return 0.
   */
  public axis(name: string): number {
    const binding = this.axes.get(name);
    if (!binding) return 0;
    let v = 0;
    for (const s of binding.positive) if (this.down.has(s)) v += 1;
    for (const s of binding.negative) if (this.down.has(s)) v -= 1;
    return v < -1 ? -1 : v > 1 ? 1 : v;
  }

  /** True if a raw binding source (`KeyW`, …) is currently held. */
  public isDown(source: Binding): boolean {
    return this.down.has(source);
  }

  /** Detach listeners. Safe to call more than once. */
  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.target.removeEventListener("keydown", this.onKeyDown);
    this.target.removeEventListener("keyup", this.onKeyUp);
    this.target.removeEventListener("blur", this.onBlur);
    this.down.clear();
  }
}
