/**
 * ViewportOverlay — a lightweight full-viewport 2D overlay drawn over the WebGPU render (not the HUD).
 *
 * Read-only indicators, redrawn every frame:
 *   - an **axis gizmo** (bottom-right): color-coded R/G/B lines for world X/Y/Z, oriented by the current
 *     camera basis, so you can always read which way the volume is facing while you orbit;
 *   - **X/Y rulers** along the bottom and left edges: tick marks (major + minor) labelled with physical
 *     distances, usable like a ruler to gauge on-screen size;
 *   - a **crop-box wireframe** (only while crop mode is on): the 12 edges of the crop box, with the
 *     currently hovered/dragged face's 4 edges highlighted.
 *
 * It's a pure 2D-canvas drawer: the viewer supplies the camera basis vectors, a pre-computed ruler
 * descriptor (major spacing in px + physical value per major + unit), and already screen-projected crop
 * box corners — all unit/geometry math stays in the viewer (this module must not import from `viewer/`,
 * which is a one-way dependency in this codebase). The canvas is `pointer-events: none` so it never
 * intercepts orbit/pan drags, and it sits over the dark render, so strokes/text are light with a soft
 * dark shadow for legibility.
 *
 * @packageDocumentation
 */

/** A ruler descriptor: tick geometry (CSS px) + the physical value one major interval represents. */
export interface OverlayRuler {
  /** CSS pixels between labelled (major) ticks. */
  majorPx: number;
  /** Minor ticks per major interval. */
  minorPerMajor: number;
  /** Physical distance (display units) spanned by one major interval. */
  majorValue: number;
  /** Display unit symbol, e.g. "µm". */
  unitLabel: string;
}

/**
 * The crop box's 8 corners, already projected to CSS-pixel screen space by the viewer (see
 * `viewer/volume/crop-drag-geometry.ts`'s `boxCorners`/`worldToScreen`) — indexed by the same
 * bit0=x/bit1=y/bit2=z convention `boxCorners()` uses. A `null` entry is a corner behind the camera;
 * edges touching it are skipped.
 */
export interface OverlayCropBox {
  corners: ([number, number] | null)[];
  /** The currently hovered/dragged face, highlighted in an accent color, or undefined for none. */
  highlight?: { axis: 0 | 1 | 2; side: "min" | "max" };
}

/** Per-frame draw inputs: the camera world basis (unit vectors), an optional ruler, and an optional
 * crop-box wireframe. */
export interface OverlayDrawParams {
  /** Camera right axis in world space (world X maps here). */
  right: [number, number, number];
  /** Camera up axis in world space. */
  up: [number, number, number];
  /** Camera forward axis in world space (into the screen). */
  forward: [number, number, number];
  /** Ruler to draw along the edges, or null when it can't be computed this frame. */
  ruler: OverlayRuler | null;
  /** Crop box to draw (only while crop mode is on), or undefined/null to draw nothing. */
  cropBox?: OverlayCropBox | null;
}

const GIZMO_R = 22;

/** The 12 edges of a box, as pairs of `OverlayCropBox.corners` indices (differ in exactly one bit) —
 * must match `viewer/volume/crop-drag-geometry.ts`'s `boxCorners()` indexing convention. Duplicated
 * rather than imported since `render/` doesn't depend on `viewer/` in this codebase; it's a fixed,
 * 12-entry constant, low risk to keep in sync by hand. */
const CROP_BOX_EDGES: readonly [number, number][] = [
  [0, 1], [2, 3], [4, 5], [6, 7],
  [0, 2], [1, 3], [4, 6], [5, 7],
  [0, 4], [1, 5], [2, 6], [3, 7],
];

/** Which axis/side (see `CropFaceAxis`/`"min"|"max"`) each edge belongs to, for highlight matching —
 * an edge belongs to a face if it lies entirely on that face's plane, i.e. both its corner indices
 * share the same bit for that axis. */
function edgeFaces(a: number, b: number): { axis: 0 | 1 | 2; side: "min" | "max" }[] {
  const faces: { axis: 0 | 1 | 2; side: "min" | "max" }[] = [];
  const axes: (0 | 1 | 2)[] = [0, 1, 2];
  for (const axis of axes) {
    const bit = 1 << axis;
    if ((a & bit) === (b & bit)) {
      faces.push({ axis, side: (a & bit) === 0 ? "min" : "max" });
    }
  }
  return faces;
}

const AXES: { v: readonly [number, number, number]; color: string; label: string }[] = [
  { v: [1, 0, 0], color: "#e5484d", label: "X" },
  { v: [0, 1, 0], color: "#46a758", label: "Y" },
  { v: [0, 0, 1], color: "#3b82f6", label: "Z" },
];

export class ViewportOverlay {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private dpr = 0;
  private cssW = 0;
  private cssH = 0;

  public constructor(stage: HTMLElement) {
    const canvas = document.createElement("canvas");
    canvas.className = "whud-overlay";
    Object.assign(canvas.style, {
      position: "absolute",
      inset: "0",
      width: "100%",
      height: "100%",
      pointerEvents: "none",
      zIndex: "2",
    });
    stage.appendChild(canvas);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("ViewportOverlay: failed to get a 2D context");
    this.canvas = canvas;
    this.ctx = ctx;
    this.syncSize();
  }

  /** Match the backing store to the CSS box × DPR (re-read each frame — the viewport resizes freely). */
  private syncSize(): void {
    const dpr = Math.min(2, globalThis.devicePixelRatio || 1);
    const cssW = this.canvas.clientWidth || 1;
    const cssH = this.canvas.clientHeight || 1;
    if (dpr === this.dpr && cssW === this.cssW && cssH === this.cssH) return;
    this.dpr = dpr;
    this.cssW = cssW;
    this.cssH = cssH;
    this.canvas.width = Math.round(cssW * dpr);
    this.canvas.height = Math.round(cssH * dpr);
  }

  /** Redraw the rulers + gizmo + crop box for the current camera basis. Call once per frame. */
  public draw(params: OverlayDrawParams): void {
    this.syncSize();
    const ctx = this.ctx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.cssW, this.cssH);
    if (params.cropBox) this.drawCropBox(params.cropBox);
    if (params.ruler) this.drawRulers(params.ruler);
    this.drawGizmo(params);
  }

  private drawCropBox(box: OverlayCropBox): void {
    const ctx = this.ctx;
    ctx.save();
    ctx.lineWidth = 1.5;
    for (const [a, b] of CROP_BOX_EDGES) {
      const pa = box.corners[a];
      const pb = box.corners[b];
      if (!pa || !pb) continue;
      const highlighted =
        box.highlight !== undefined &&
        edgeFaces(a, b).some((f) => f.axis === box.highlight!.axis && f.side === box.highlight!.side);
      ctx.strokeStyle = highlighted ? "#5b9dd9" : "rgba(255,255,255,0.55)";
      ctx.lineWidth = highlighted ? 2.5 : 1.5;
      ctx.beginPath();
      ctx.moveTo(pa[0], pa[1]);
      ctx.lineTo(pb[0], pb[1]);
      ctx.stroke();
    }
    ctx.restore();
  }

  private drawRulers(r: OverlayRuler): void {
    const minorPx = r.majorPx / Math.max(1, r.minorPerMajor);
    if (!(minorPx > 2)) return; // too dense to read — skip this frame
    const ctx = this.ctx;
    const originX = 26; // vertical (Y) ruler line
    const originY = this.cssH - 26; // horizontal (X) ruler line
    const endX = this.cssW - 12;
    const endY = 12;
    const fmt = (v: number): string => String(Number(v.toPrecision(4)));

    ctx.save();
    ctx.shadowColor = "rgba(0,0,0,0.7)";
    ctx.shadowBlur = 2;
    ctx.strokeStyle = "rgba(255,255,255,0.85)";
    ctx.fillStyle = "rgba(255,255,255,0.92)";
    ctx.lineWidth = 1;
    ctx.font = "600 10px system-ui, -apple-system, sans-serif";

    // Axis baselines.
    ctx.beginPath();
    ctx.moveTo(originX, originY);
    ctx.lineTo(endX, originY);
    ctx.moveTo(originX, originY);
    ctx.lineTo(originX, endY);
    ctx.stroke();

    // X ticks (rightward from the corner).
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    let i = 0;
    for (let x = originX; x <= endX + 0.5; x += minorPx, i++) {
      const major = i % r.minorPerMajor === 0;
      ctx.beginPath();
      ctx.moveTo(x, originY);
      ctx.lineTo(x, originY - (major ? 8 : 4));
      ctx.stroke();
      if (major && i > 0) {
        ctx.fillText(fmt((i / r.minorPerMajor) * r.majorValue), x, originY + 3);
      }
    }

    // Y ticks (upward from the corner).
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    let j = 0;
    for (let y = originY; y >= endY - 0.5; y -= minorPx, j++) {
      const major = j % r.minorPerMajor === 0;
      ctx.beginPath();
      ctx.moveTo(originX, y);
      ctx.lineTo(originX + (major ? 8 : 4), y);
      ctx.stroke();
      if (major && j > 0) {
        ctx.fillText(fmt((j / r.minorPerMajor) * r.majorValue), originX + 10, y);
      }
    }

    // Unit at the origin corner.
    ctx.textAlign = "left";
    ctx.textBaseline = "bottom";
    ctx.fillText(r.unitLabel, originX + 4, originY - 4);
    ctx.restore();
  }

  private drawGizmo({ right, up, forward }: OverlayDrawParams): void {
    const ctx = this.ctx;
    // Bottom-right corner, clear of the edge rulers.
    const cx = this.cssW - 44;
    const cy = this.cssH - 44;
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
      const tipX = cx + p.sx * GIZMO_R;
      const tipY = cy - p.sy * GIZMO_R;
      ctx.globalAlpha = p.dz > 0 ? 0.4 : 1;
      ctx.strokeStyle = p.color;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(tipX, tipY);
      ctx.stroke();
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(tipX, tipY, 2.4, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillText(p.label, cx + p.sx * (GIZMO_R + 8), cy - p.sy * (GIZMO_R + 8));
    }
    ctx.restore();
  }

  /** Remove the overlay canvas from the DOM. */
  public dispose(): void {
    this.canvas.remove();
  }
}
