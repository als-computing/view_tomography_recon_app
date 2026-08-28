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
 * Drag points vertically (opacity) / horizontally (intensity); double-click empty space to add a
 * point, double-click an existing point to remove it (at least 2 points are always kept).
 */
export class OpacityCurveEditor {
  public points: OpacityPoint[];
  public colorMap: ColorMapName;
  public colorRange: readonly [number, number];
  /** Normalized-intensity histogram of the volume (counts per bin over [0,1]); drawn behind the curve. */
  private histogram?: Float32Array;
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

  /** Update the color low/high range; recolors the colormap strip + histogram live (drag the slider). */
  public setColorRange(range: readonly [number, number]): void {
    this.colorRange = range;
    this.redraw();
  }

  /** Set the volume intensity histogram (counts per bin over normalized [0,1]) drawn behind the curve. */
  public setHistogram(bins: Float32Array): void {
    this.histogram = bins;
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

    const [cLo, cHi] = this.colorRange;

    // Volume histogram: bars tinted by the colormap at each bin's *remapped* position, so the
    // distribution recolors live as the color range changes. sqrt scale so peaky tomography
    // histograms still show structure. Drawn over the darkened strip, behind the opacity curve.
    if (this.histogram && this.histogram.length > 0) {
      const bins = this.histogram;
      const n = bins.length;
      let maxCount = 0;
      for (let i = 0; i < n; i++) if (bins[i]! > maxCount) maxCount = bins[i]!;
      if (maxCount > 0) {
        const bw = w / n;
        for (let i = 0; i < n; i++) {
          const t = i / Math.max(1, n - 1);
          const bh = Math.sqrt(bins[i]! / maxCount) * h;
          const ct = Math.min(1, Math.max(0, (t - cLo) / Math.max(1e-6, cHi - cLo)));
          const [r, g, b] = sampleColorMap(this.colorMap, ct);
          ctx.fillStyle = `rgba(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)},0.6)`;
          ctx.fillRect(i * bw, h - bh, Math.ceil(bw), bh);
        }
      }
    }

    // Color-range guides: thin verticals marking low/high so the graph aligns with the range slider.
    for (const cx of [cLo, cHi]) {
      const x = cx * w;
      ctx.fillStyle = "rgba(255,255,255,0.5)";
      ctx.fillRect(Math.round(x) - 0.5 * dpr, 0, Math.max(1, dpr), h);
    }

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
    // `PointerEvent.detail` isn't populated with click-count semantics in most engines (it's a
    // `MouseEvent`/`click` concept), so double-click add/remove uses the browser's native `dblclick`
    // event instead — `pointerdown`/`move`/`up` below handle only single-click drag.
    const toLocal = (e: MouseEvent): { t: number; a: number } => {
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

    const onDblClick = (e: MouseEvent): void => {
      const { t, a } = toLocal(e);
      const hitIndex = hit(t, a);
      if (hitIndex >= 0) {
        // Remove, but always keep at least a start and end point.
        if (this.points.length > 2) {
          this.points = this.points.filter((_, i) => i !== hitIndex);
          this.dragIndex = -1;
          this.emit();
        }
      } else {
        const added: OpacityPoint = [t, a];
        this.points = [...this.points, added].sort((x, y) => x[0] - y[0]);
        this.dragIndex = -1;
        this.emit();
      }
      e.preventDefault();
    };

    this.canvas.addEventListener("pointerdown", onDown);
    this.canvas.addEventListener("pointermove", onMove);
    this.canvas.addEventListener("pointerup", onUp);
    this.canvas.addEventListener("pointercancel", onUp);
    this.canvas.addEventListener("dblclick", onDblClick);
    this.cleanups.push(() => {
      this.canvas.removeEventListener("pointerdown", onDown);
      this.canvas.removeEventListener("pointermove", onMove);
      this.canvas.removeEventListener("pointerup", onUp);
      this.canvas.removeEventListener("pointercancel", onUp);
      this.canvas.removeEventListener("dblclick", onDblClick);
    });
  }

  private emit(): void {
    this.redraw();
    this.onChange?.(this.points);
  }
}
