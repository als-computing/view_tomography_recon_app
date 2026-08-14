/**
 * ViewportOverlay — a lightweight 2D overlay drawn over the WebGPU render viewport (not the HUD).
 *
 * Two read-only indicators, redrawn every frame in the bottom-left corner:
 *   - an **axis gizmo**: color-coded R/G/B lines for world X/Y/Z, oriented by the current camera basis,
 *     so you can always read which way the volume is facing while you orbit;
 *   - a **scale bar**: a horizontal bar labelled with a rounded physical distance, so on-screen size is
 *     legible.
 *
 * It's a pure 2D-canvas drawer: the viewer supplies the camera basis vectors and a pre-computed
 * `{px, label}` for the scale bar (all unit/geometry math stays in the viewer). The overlay canvas is
 * `pointer-events: none` so it never intercepts orbit/pan drags, and it sits over the dark rendered
 * viewport, so strokes/text are light with a soft dark shadow for legibility over bright volume regions.
 *
 * @packageDocumentation
 */

/** A scale bar to draw: a bar `px` CSS pixels long, labelled with a rounded physical distance. */
export interface OverlayScaleBar {
  px: number;
  label: string;
}

/** Per-frame draw inputs: the camera world basis (unit vectors) + an optional scale bar. */
export interface OverlayDrawParams {
  /** Camera right axis in world space (world X maps here). */
  right: [number, number, number];
  /** Camera up axis in world space. */
  up: [number, number, number];
  /** Camera forward axis in world space (into the screen). */
  forward: [number, number, number];
  /** Scale bar to draw, or null when it can't be computed this frame. */
  scaleBar: OverlayScaleBar | null;
}

const CSS_W = 240;
const CSS_H = 88;
const GIZMO_CX = 34;
const GIZMO_CY = 40;
const GIZMO_R = 22;

const AXES: { v: readonly [number, number, number]; color: string; label: string }[] = [
  { v: [1, 0, 0], color: "#e5484d", label: "X" },
  { v: [0, 1, 0], color: "#46a758", label: "Y" },
  { v: [0, 0, 1], color: "#3b82f6", label: "Z" },
];

export class ViewportOverlay {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private dpr = 0;

  public constructor(stage: HTMLElement) {
    const canvas = document.createElement("canvas");
    canvas.className = "whud-overlay";
    Object.assign(canvas.style, {
      position: "absolute",
      left: "12px",
      bottom: "12px",
      width: `${CSS_W}px`,
      height: `${CSS_H}px`,
      pointerEvents: "none",
      zIndex: "2",
    });
    stage.appendChild(canvas);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("ViewportOverlay: failed to get a 2D context");
    this.canvas = canvas;
    this.ctx = ctx;
    this.syncDpr();
  }

  /** Keep the backing store matched to the device pixel ratio (crisp after a monitor/DPR change). */
  private syncDpr(): void {
    const dpr = Math.min(2, globalThis.devicePixelRatio || 1);
    if (dpr === this.dpr) return;
    this.dpr = dpr;
    this.canvas.width = Math.round(CSS_W * dpr);
    this.canvas.height = Math.round(CSS_H * dpr);
  }

  /** Redraw the gizmo (+ scale bar) for the current camera basis. Call once per frame. */
  public draw(params: OverlayDrawParams): void {
    this.syncDpr();
    const ctx = this.ctx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, CSS_W, CSS_H);
    this.drawGizmo(params);
    if (params.scaleBar) this.drawScaleBar(params.scaleBar);
  }

  private drawGizmo({ right, up, forward }: OverlayDrawParams): void {
    const ctx = this.ctx;
    // Project each world axis onto the view basis: sx→screen-x, sy→screen-y (canvas y is down), dz→depth.
    const projected = AXES.map((a) => ({
      color: a.color,
      label: a.label,
      sx: a.v[0] * right[0] + a.v[1] * right[1] + a.v[2] * right[2],
      sy: a.v[0] * up[0] + a.v[1] * up[1] + a.v[2] * up[2],
      dz: a.v[0] * forward[0] + a.v[1] * forward[1] + a.v[2] * forward[2],
    }));
    // Draw axes pointing away (dz > 0) first and dimmed so near axes overlay them.
    projected.sort((p, q) => q.dz - p.dz);

    ctx.save();
    ctx.shadowColor = "rgba(0,0,0,0.6)";
    ctx.shadowBlur = 2;
    ctx.lineCap = "round";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = "bold 10px system-ui, -apple-system, sans-serif";
    for (const p of projected) {
      const tipX = GIZMO_CX + p.sx * GIZMO_R;
      const tipY = GIZMO_CY - p.sy * GIZMO_R;
      ctx.globalAlpha = p.dz > 0 ? 0.4 : 1;
      ctx.strokeStyle = p.color;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(GIZMO_CX, GIZMO_CY);
      ctx.lineTo(tipX, tipY);
      ctx.stroke();
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(tipX, tipY, 2.4, 0, Math.PI * 2);
      ctx.fill();
      // Label just beyond the tip.
      ctx.fillText(p.label, GIZMO_CX + p.sx * (GIZMO_R + 8), GIZMO_CY - p.sy * (GIZMO_R + 8));
    }
    ctx.restore();
  }

  private drawScaleBar(bar: OverlayScaleBar): void {
    const ctx = this.ctx;
    const x0 = 76;
    const barY = CSS_H - 18;
    const len = Math.max(6, Math.min(bar.px, CSS_W - x0 - 10));
    ctx.save();
    ctx.shadowColor = "rgba(0,0,0,0.65)";
    ctx.shadowBlur = 2;
    ctx.strokeStyle = "#fff";
    ctx.fillStyle = "#fff";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x0, barY);
    ctx.lineTo(x0 + len, barY);
    ctx.moveTo(x0, barY - 4);
    ctx.lineTo(x0, barY + 4);
    ctx.moveTo(x0 + len, barY - 4);
    ctx.lineTo(x0 + len, barY + 4);
    ctx.stroke();
    ctx.font = "600 11px system-ui, -apple-system, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "bottom";
    ctx.fillText(bar.label, x0 + len / 2, barY - 6);
    ctx.restore();
  }

  /** Remove the overlay canvas from the DOM. */
  public dispose(): void {
    this.canvas.remove();
  }
}
