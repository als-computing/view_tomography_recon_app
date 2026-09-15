/**
 * Shared viewer session: RAF + window listeners + HUD cleanup.
 * The shell ({@link resetViewerStage}) restores a fresh `#canvas` on load.
 */

export interface ViewerHandle {
  dispose(): void;
}

/** Create a disposable session bound to the current viewer canvas. */
export function createViewerSession(canvas: HTMLCanvasElement): {
  canvas: HTMLCanvasElement;
  stage: HTMLElement;
  /** Start a self-cancelling animation loop. */
  loop: (frame: (dt: number, now: number) => void) => void;
  /** `window` keydown listener removed on dispose. */
  onKeyDown: (handler: (e: KeyboardEvent) => void) => void;
  /** Append an overlay under the stage; removed on dispose. */
  mountHud: (el: HTMLElement) => void;
  /** Extra cleanup (controls.dispose, UI detach, etc.). */
  onDispose: (fn: () => void) => void;
  /** Return the handle the viewer shell should retain. */
  handle: () => ViewerHandle;
} {
  const stage = (canvas.parentElement ?? document.body) as HTMLElement;
  const cleanups: Array<() => void> = [];
  let rafId = 0;
  let disposed = false;

  const onDispose = (fn: () => void): void => {
    cleanups.push(fn);
  };

  return {
    canvas,
    stage,
    loop(frame) {
      let last = performance.now();
      const tick = (now: number): void => {
        if (disposed) return;
        rafId = requestAnimationFrame(tick);
        const dt = Math.min(0.05, (now - last) / 1000);
        last = now;
        frame(dt, now);
      };
      rafId = requestAnimationFrame(tick);
      onDispose(() => {
        cancelAnimationFrame(rafId);
        rafId = 0;
      });
    },
    onKeyDown(handler) {
      window.addEventListener("keydown", handler);
      onDispose(() => window.removeEventListener("keydown", handler));
    },
    mountHud(el) {
      stage.appendChild(el);
      onDispose(() => el.remove());
    },
    onDispose,
    handle() {
      return {
        dispose() {
          if (disposed) return;
          disposed = true;
          cancelAnimationFrame(rafId);
          rafId = 0;
          for (let i = cleanups.length - 1; i >= 0; i--) cleanups[i]!();
          cleanups.length = 0;
        },
      };
    },
  };
}

/** Wipe the stage and install a fresh WebGPU/2D-capable canvas. */
export function resetViewerStage(stage: HTMLElement): HTMLCanvasElement {
  stage.replaceChildren();
  const canvas = document.createElement("canvas");
  canvas.id = "canvas";
  stage.appendChild(canvas);
  return canvas;
}

/** Shared absolute HUD chrome used by the viewer. */
export function createViewerHud(options?: {
  position?: "top-left" | "bottom-left";
  pointerEvents?: boolean;
}): HTMLDivElement {
  const top = (options?.position ?? "top-left") === "top-left";
  const hud = document.createElement("div");
  hud.style.cssText = [
    "position:absolute",
    "left:12px",
    top ? "top:12px" : "bottom:12px",
    "padding:10px 12px",
    "border-radius:10px",
    "background:rgba(8,10,16,0.78)",
    "color:#e8e8ec",
    "font:12px/1.45 ui-sans-serif,system-ui,sans-serif",
    "max-width:min(420px, 92%)",
    options?.pointerEvents ? "pointer-events:auto" : "pointer-events:none",
    "z-index:2",
    "white-space:pre-wrap",
  ].join(";");
  return hud;
}

/** Resize a canvas backing store to its CSS box, capped by `maxDpr` (default 2). */
export function resizeViewerCanvas(canvas: HTMLCanvasElement, maxDpr = 2): void {
  const dpr = Math.min(window.devicePixelRatio || 1, maxDpr);
  const w = Math.max(1, Math.floor(canvas.clientWidth * dpr));
  const h = Math.max(1, Math.floor(canvas.clientHeight * dpr));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
}

/**
 * Hide the shell canvas and mount a stacked pair of absolute canvases (back = sim/GPU,
 * front = UI overlay with pointer events).
 */
export function mountOverlayCanvases(
  shellCanvas: HTMLCanvasElement,
  stage: HTMLElement,
): { host: HTMLElement; back: HTMLCanvasElement; front: HTMLCanvasElement } {
  const host = document.createElement("div");
  host.style.cssText = "position:relative;width:100%;height:100%;";
  const back = document.createElement("canvas");
  const front = document.createElement("canvas");
  for (const c of [back, front]) {
    c.style.cssText = "position:absolute;inset:0;width:100%;height:100%;display:block;";
  }
  front.style.pointerEvents = "auto";
  host.append(back, front);
  shellCanvas.style.display = "none";
  stage.appendChild(host);
  return { host, back, front };
}
