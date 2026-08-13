/**
 * Canvas2D editor for piecewise opacity curves (itk-viewer transfer-function-editor style).
 *
 * @packageDocumentation
 */

import { sampleOpacity, type OpacityPoint } from "./opacity-curve.js";
import { sampleColorMap, type ColorMapName } from "./colormaps.js";

/** Options for {@link OpacityCurveEditor}. */
export interface OpacityCurveEditorOptions {
  colorMap?: ColorMapName;
  colorRange?: readonly [number, number];
  /** Called whenever points change. */
  onChange?: (points: readonly OpacityPoint[]) => void;
}

/**
 * Interactive opacity-curve editor drawn into a canvas.
 * Drag points vertically (opacity) / horizontally (intensity); double-click to add.
 */
export class OpacityCurveEditor {
  public points: OpacityPoint[];
  public colorMap: ColorMapName;
  public colorRange: readonly [number, number];
  private dragIndex = -1;
  private readonly onChange?: (points: readonly OpacityPoint[]) => void;
  private readonly cleanups: Array<() => void> = [];

  public constructor(
    public readonly canvas: HTMLCanvasElement,
    points: readonly OpacityPoint[],
    options: OpacityCurveEditorOptions = {},
  ) {
    this.points = points.map((p) => [p[0], p[1]] as const);
    this.colorMap = options.colorMap ?? "bone";
    this.colorRange = options.colorRange ?? [0, 1];
    this.onChange = options.onChange;
    this.bind();
    this.redraw();
  }

  public setPoints(points: readonly OpacityPoint[]): void {
    this.points = points.map((p) => [p[0], p[1]] as const);
    this.redraw();
  }

  public setColorMap(name: ColorMapName): void {
    this.colorMap = name;
    this.redraw();
  }

  public dispose(): void {
    for (const c of this.cleanups) c();
    this.cleanups.length = 0;
  }

  public redraw(): void {
    const ctx = this.canvas.getContext("2d");
    if (!ctx) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const cssW = this.canvas.clientWidth || 280;
    const cssH = this.canvas.clientHeight || 72;
    if (this.canvas.width !== Math.floor(cssW * dpr) || this.canvas.height !== Math.floor(cssH * dpr)) {
      this.canvas.width = Math.floor(cssW * dpr);
      this.canvas.height = Math.floor(cssH * dpr);
    }
    const w = this.canvas.width;
    const h = this.canvas.height;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, w, h);

    // Colormap strip background
    for (let x = 0; x < w; x++) {
      const t = x / Math.max(1, w - 1);
      const [cLo, cHi] = this.colorRange;
      const ct = Math.min(1, Math.max(0, (t - cLo) / Math.max(1e-6, cHi - cLo)));
      const [r, g, b] = sampleColorMap(this.colorMap, ct);
      ctx.fillStyle = `rgb(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)})`;
      ctx.fillRect(x, 0, 1, h);
    }
    ctx.fillStyle = "rgba(0,0,0,0.45)";
    ctx.fillRect(0, 0, w, h);

    // Opacity area fill
    ctx.beginPath();
    ctx.moveTo(0, h);
    for (let x = 0; x < w; x++) {
      const t = x / Math.max(1, w - 1);
      const a = sampleOpacity(this.points, t);
      ctx.lineTo(x, h - a * h);
    }
    ctx.lineTo(w, h);
    ctx.closePath();
    ctx.fillStyle = "rgba(200,220,255,0.35)";
    ctx.fill();

    // Curve
    ctx.beginPath();
    for (let x = 0; x < w; x++) {
      const t = x / Math.max(1, w - 1);
      const a = sampleOpacity(this.points, t);
      const y = h - a * h;
      if (x === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = "rgba(230,240,255,0.95)";
    ctx.lineWidth = 2 * dpr;
    ctx.stroke();

    // Points
    for (const [t, a] of this.points) {
      const x = t * w;
      const y = h - a * h;
      ctx.beginPath();
      ctx.arc(x, y, 5 * dpr, 0, Math.PI * 2);
      ctx.fillStyle = "#fff";
      ctx.fill();
      ctx.strokeStyle = "#3a7abd";
      ctx.lineWidth = 1.5 * dpr;
      ctx.stroke();
    }
  }

  private bind(): void {
    const toLocal = (e: PointerEvent): { t: number; a: number } => {
      const rect = this.canvas.getBoundingClientRect();
      const t = Math.min(1, Math.max(0, (e.clientX - rect.left) / Math.max(1, rect.width)));
      const a = Math.min(1, Math.max(0, 1 - (e.clientY - rect.top) / Math.max(1, rect.height)));
      return { t, a };
    };

    const hit = (t: number, a: number): number => {
      const rect = this.canvas.getBoundingClientRect();
      const tolT = 10 / Math.max(1, rect.width);
      const tolA = 10 / Math.max(1, rect.height);
      let best = -1;
      let bestD = Infinity;
      for (let i = 0; i < this.points.length; i++) {
        const p = this.points[i]!;
        const d = Math.hypot(p[0] - t, p[1] - a);
        if (d < bestD && Math.abs(p[0] - t) < tolT && Math.abs(p[1] - a) < tolA) {
          bestD = d;
          best = i;
        }
      }
      return best;
    };

    const onDown = (e: PointerEvent): void => {
      const { t, a } = toLocal(e);
      this.dragIndex = hit(t, a);
      if (this.dragIndex < 0 && e.detail >= 2) {
        const added: OpacityPoint = [t, a];
        this.points = [...this.points, added].sort((x, y) => x[0] - y[0]);
        this.dragIndex = this.points.indexOf(added);
        this.emit();
      }
      this.canvas.setPointerCapture(e.pointerId);
      e.preventDefault();
    };
    const onMove = (e: PointerEvent): void => {
      if (this.dragIndex < 0) return;
      const { t, a } = toLocal(e);
      const next: OpacityPoint[] = this.points.map((p) => [p[0], p[1]] as const);
      const moved: OpacityPoint = [t, a];
      next[this.dragIndex] = moved;
      next.sort((x, y) => x[0] - y[0]);
      this.dragIndex = next.indexOf(moved);
      this.points = next;
      this.redraw();
      this.onChange?.(this.points);
    };
    const onUp = (): void => {
      this.dragIndex = -1;
    };

    this.canvas.addEventListener("pointerdown", onDown);
    this.canvas.addEventListener("pointermove", onMove);
    this.canvas.addEventListener("pointerup", onUp);
    this.canvas.addEventListener("pointercancel", onUp);
    this.cleanups.push(() => {
      this.canvas.removeEventListener("pointerdown", onDown);
      this.canvas.removeEventListener("pointermove", onMove);
      this.canvas.removeEventListener("pointerup", onUp);
      this.canvas.removeEventListener("pointercancel", onUp);
    });
  }

  private emit(): void {
    this.redraw();
    this.onChange?.(this.points);
  }
}
