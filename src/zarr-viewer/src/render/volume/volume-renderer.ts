/**
 * High-level direct volume renderer: ray-marches a 3D density texture with a transfer function into
 * the canvas. Supports itk-vtk-viewer–style blend modes, crop, axis slices, gradient opacity, and
 * dielectric liquid shading (Fresnel / env / Beer) for CGI-style fluids.
 *
 * @packageDocumentation
 */

import type { Disposable } from "@zarr-viewer/core";
import { Mat4, asColor3, type Color3, type Color3Like, type Color4Like } from "@zarr-viewer/math";
import type { GpuContext } from "../device/context.js";
import { ManagedBuffer } from "../resources/buffer.js";
import { ManagedTexture } from "../resources/texture.js";
import { PipelineCache } from "../resources/pipeline.js";
import { toGpuColor } from "../color.js";
import { TransferFunction } from "./transfer-function.js";
import {
  VOLUME_FRAME_UNIFORM_SIZE,
  VOLUME_RAYMARCH_WGSL,
} from "../shaders/volume-raymarch.js";

/** Volume blend / compositing mode (itk-vtk `setImageBlendMode`). */
export type VolumeBlendMode = "composite" | "mip" | "minip" | "average";

/** Primary view mode. */
export type VolumeViewMode = "volume" | "xPlane" | "yPlane" | "zPlane";

/** Dielectric liquid shading for CGI-style water / oil / steam volumes. */
export interface LiquidShadingParams {
  /** Enable Fresnel + env + Beer dielectric path (default false = legacy TF Phong). */
  enabled?: boolean;
  /** Index of refraction (water ≈ 1.333, oil ≈ 1.47). Default `1.333`. */
  ior?: number;
  /** Microfacet roughness for free-surface specular. Default `0.04`. */
  roughness?: number;
  /** Scales procedural studio environment. Default `1.2`. */
  envIntensity?: number;
  /** Beer–Lambert absorption path scale. Default `2.5`. */
  absorptionScale?: number;
}

const BLEND_MODE_ID: Record<VolumeBlendMode, number> = {
  composite: 0,
  mip: 1,
  minip: 2,
  average: 3,
};

const VIEW_MODE_ID: Record<VolumeViewMode, number> = {
  volume: 0,
  xPlane: 1,
  yPlane: 2,
  zPlane: 3,
};

/** Options for {@link VolumeRenderer}. */
export interface VolumeRendererOptions {
  clearColor?: Color4Like;
  /** Ray step size in world units. Smaller = sharper, more expensive. */
  stepSize?: number;
  densityScale?: number;
  maxSteps?: number;
  exposure?: number;
  lightDirection?: readonly [number, number, number];
  lightColor?: Color3Like;
  ambient?: number;
  specularPower?: number;
  blendMode?: VolumeBlendMode;
  /** Gradient opacity amount in `[0, 1]` (0 = off). */
  gradientOpacity?: number;
  /** Gradient magnitude scale for opacity. */
  gradientOpacityScale?: number;
  /** 0 = flat TF color, 1 = full gradient shading. */
  lightingStrength?: number;
  /** Optional dielectric liquid shading (can also call {@link setLiquidShading}). */
  liquidShading?: LiquidShadingParams;
  /**
   * Color attachment format the ray-march pipeline targets. Defaults to the swapchain format.
   * Set to an HDR format when driving the volume renderer through the {@link RenderGraph}.
   */
  colorFormat?: GPUTextureFormat;
  /**
   * Output linear HDR (skip the in-shader ACES tonemap/gamma) so a downstream post stack tonemaps
   * once. Default `false`. Set `true` alongside an HDR `colorFormat` for the render-graph path.
   */
  linearOutput?: boolean;
}

/**
 * Ray-marches a volume each frame from an explicit view/projection.
 */
export class VolumeRenderer implements Disposable {
  private readonly cache: PipelineCache;
  private readonly clearColor: GPUColor;
  /** Color format the ray-march pipeline renders into (swapchain format by default). */
  public readonly colorFormat: GPUTextureFormat;
  /** When true, emit linear HDR (no inline tonemap) for a post stack. */
  private readonly linearOutput: boolean;
  private stepSize: number;
  private densityScale: number;
  private maxSteps: number;
  private exposure: number;
  private lightDirection: [number, number, number];
  private lightColor: Color3;
  private ambient: number;
  private specularPower: number;
  private boxHalf: [number, number, number] = [0.5, 0.5, 0.5];
  private blendMode: VolumeBlendMode = "composite";
  private gradientOpacity = 0;
  private gradientOpacityScale = 0.15;
  private lightingStrength = 1;
  private liquidEnabled = false;
  private liquidIor = 1.333;
  private liquidRoughness = 0.04;
  private liquidEnvIntensity = 1.2;
  private liquidAbsorptionScale = 2.5;
  private cropMin: [number, number, number] = [0, 0, 0];
  private cropMax: [number, number, number] = [1, 1, 1];
  private sliceX = 0.5;
  private sliceY = 0.5;
  private sliceZ = 0.5;
  private sliceEnableX = false;
  private sliceEnableY = false;
  private sliceEnableZ = false;
  private showSlicePlanes = false;
  private viewMode: VolumeViewMode = "volume";
  private frameIndex = 0;

  private pipeline: GPURenderPipeline | undefined;
  private frameUniform: ManagedBuffer | undefined;
  private bindGroup: GPUBindGroup | undefined;
  private volumeTex: ManagedTexture | undefined;
  private tfTex: ManagedTexture | undefined;
  private volumeSampler: GPUSampler | undefined;
  private tfSampler: GPUSampler | undefined;

  private readonly frameData = new Float32Array(VOLUME_FRAME_UNIFORM_SIZE / 4);
  private readonly invViewProj = new Mat4();

  public constructor(
    public readonly ctx: GpuContext,
    options: VolumeRendererOptions = {},
  ) {
    this.cache = new PipelineCache(ctx.device);
    this.clearColor = toGpuColor(options.clearColor ?? [0.02, 0.03, 0.05, 1]);
    this.colorFormat = options.colorFormat ?? ctx.format;
    this.linearOutput = options.linearOutput ?? false;
    this.stepSize = options.stepSize ?? 1 / 260;
    this.densityScale = options.densityScale ?? 1.35;
    // Hard safety cap on ray-march iterations. The per-frame step count is derived from the box
    // diagonal / step size (see writeFrame) so a ray always reaches the far face; this only bounds the
    // pathological case (very fine sampling of a large box).
    this.maxSteps = options.maxSteps ?? 4096;
    this.exposure = options.exposure ?? 1.15;
    this.lightDirection = [...(options.lightDirection ?? [0.45, 0.85, 0.35])] as [
      number,
      number,
      number,
    ];
    this.lightColor = asColor3(options.lightColor ?? [1.0, 0.96, 0.9]);
    this.ambient = options.ambient ?? 0.22;
    this.specularPower = options.specularPower ?? 48;
    this.blendMode = options.blendMode ?? "composite";
    this.gradientOpacity = options.gradientOpacity ?? 0;
    this.gradientOpacityScale = options.gradientOpacityScale ?? 0.15;
    this.lightingStrength = options.lightingStrength ?? 1;
    if (options.liquidShading) this.setLiquidShading(options.liquidShading);
  }

  public setVolume(texture: ManagedTexture): void {
    this.volumeTex = texture;
    this.bindGroup = undefined;
  }

  public setBoxHalfSize(x: number, y: number, z: number): void {
    this.boxHalf = [Math.max(1e-9, x), Math.max(1e-9, y), Math.max(1e-9, z)];
  }

  public setTransferFunction(tf: TransferFunction, lutSize = 512): void {
    const lut = tf.toLut(lutSize);
    this.tfTex?.dispose();
    this.tfTex = new ManagedTexture(this.ctx.device, {
      size: [lutSize, 1, 1],
      format: "rgba8unorm",
      dimension: "2d",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    const bytesPerRow = Math.max(256, Math.ceil((lutSize * 4) / 256) * 256);
    const padded = new Uint8Array(bytesPerRow);
    padded.set(lut.subarray(0, lutSize * 4));
    this.ctx.device.queue.writeTexture(
      { texture: this.tfTex.gpu },
      padded,
      { bytesPerRow, rowsPerImage: 1 },
      { width: lutSize, height: 1, depthOrArrayLayers: 1 },
    );
    this.bindGroup = undefined;
  }

  /**
   * Enable CGI-style dielectric liquid shading (Fresnel free-surface, procedural env reflection,
   * Beer–Lambert absorption). When disabled, uses the legacy TF Blinn-Phong path.
   */
  public setLiquidShading(params: LiquidShadingParams): void {
    if (params.enabled !== undefined) this.liquidEnabled = params.enabled;
    if (params.ior !== undefined) this.liquidIor = Math.min(3.5, Math.max(1.0, params.ior));
    if (params.roughness !== undefined) {
      this.liquidRoughness = Math.min(1, Math.max(0.012, params.roughness));
    }
    if (params.envIntensity !== undefined) {
      this.liquidEnvIntensity = Math.max(0, params.envIntensity);
    }
    if (params.absorptionScale !== undefined) {
      this.liquidAbsorptionScale = Math.max(0.05, params.absorptionScale);
    }
  }

  public setBlendMode(mode: VolumeBlendMode): void {
    this.blendMode = mode;
  }

  public setViewMode(mode: VolumeViewMode): void {
    this.viewMode = mode;
  }

  /** Crop region in normalized volume UVW `[0,1]^3`. */
  public setCrop(min: readonly [number, number, number], max: readonly [number, number, number]): void {
    this.cropMin = [
      Math.min(min[0], max[0]),
      Math.min(min[1], max[1]),
      Math.min(min[2], max[2]),
    ];
    this.cropMax = [
      Math.max(min[0], max[0]),
      Math.max(min[1], max[1]),
      Math.max(min[2], max[2]),
    ];
  }

  public resetCrop(): void {
    this.cropMin = [0, 0, 0];
    this.cropMax = [1, 1, 1];
  }

  /** Slice positions in normalized UVW `[0,1]`. */
  public setSlices(x: number, y: number, z: number): void {
    this.sliceX = clamp01(x);
    this.sliceY = clamp01(y);
    this.sliceZ = clamp01(z);
  }

  public setSliceEnabled(axis: "x" | "y" | "z", enabled: boolean): void {
    if (axis === "x") this.sliceEnableX = enabled;
    else if (axis === "y") this.sliceEnableY = enabled;
    else this.sliceEnableZ = enabled;
  }

  /** Draw axis planes as highlights in volume mode (itk-vtk `s` toggle). */
  public setSlicePlanesVisible(visible: boolean): void {
    this.showSlicePlanes = visible;
  }

  public setParams(
    params: Partial<
      Pick<
        VolumeRendererOptions,
        | "stepSize"
        | "densityScale"
        | "maxSteps"
        | "exposure"
        | "ambient"
        | "specularPower"
        | "lightDirection"
        | "lightColor"
        | "blendMode"
        | "gradientOpacity"
        | "gradientOpacityScale"
        | "lightingStrength"
      >
    >,
  ): void {
    if (params.stepSize !== undefined) this.stepSize = params.stepSize;
    if (params.densityScale !== undefined) this.densityScale = params.densityScale;
    if (params.maxSteps !== undefined) this.maxSteps = params.maxSteps;
    if (params.exposure !== undefined) this.exposure = params.exposure;
    if (params.ambient !== undefined) this.ambient = params.ambient;
    if (params.specularPower !== undefined) this.specularPower = params.specularPower;
    if (params.lightDirection) {
      this.lightDirection = [...params.lightDirection] as [number, number, number];
    }
    if (params.lightColor) this.lightColor = asColor3(params.lightColor);
    if (params.blendMode) this.blendMode = params.blendMode;
    if (params.gradientOpacity !== undefined) this.gradientOpacity = params.gradientOpacity;
    if (params.gradientOpacityScale !== undefined) {
      this.gradientOpacityScale = params.gradientOpacityScale;
    }
    if (params.lightingStrength !== undefined) this.lightingStrength = params.lightingStrength;
  }

  /**
   * Ray-march the volume.
   * @param options.clear - When `false`, preserve the current swapchain color and composite with
   *   alpha (empty rays transparent) so acrylic tanks / caustic floors drawn underneath show through.
   */
  public render(
    viewProj: Mat4,
    eye: { x: number; y: number; z: number },
    options: { clear?: boolean } = {},
  ): void {
    const { device, canvasContext } = this.ctx;
    const encoder = device.createCommandEncoder({ label: "volume-frame" });
    const pass = encoder.beginRenderPass({
      label: "volume-raymarch",
      colorAttachments: [
        {
          view: canvasContext.getCurrentTexture().createView(),
          clearValue: this.clearColor,
          loadOp: options.clear === false ? "load" : "clear",
          storeOp: "store",
        },
      ],
    });
    this.recordInto(pass, viewProj, eye, options);
    pass.end();
    device.queue.submit([encoder.finish()]);
  }

  /**
   * Record the ray-march draw into an already-begun render pass (no encoder/submit ownership), for
   * driving the volume renderer from a {@link RenderGraph}. Writes per-frame uniforms then issues the
   * single fullscreen draw. Requires {@link setVolume} and {@link setTransferFunction} first.
   */
  public recordInto(
    pass: GPURenderPassEncoder,
    viewProj: Mat4,
    eye: { x: number; y: number; z: number },
    options: { clear?: boolean } = {},
  ): void {
    if (!this.volumeTex || !this.tfTex) {
      throw new Error("VolumeRenderer: call setVolume and setTransferFunction before render()");
    }
    this.ensurePipeline();
    this.ensureBindGroup();

    this.invViewProj.copy(viewProj);
    if (!this.invViewProj.invert()) return;

    const lx = this.lightDirection[0];
    const ly = this.lightDirection[1];
    const lz = this.lightDirection[2];
    const llen = Math.hypot(lx, ly, lz) || 1;

    let flags = 0;
    if (this.sliceEnableX) flags |= 1;
    if (this.sliceEnableY) flags |= 2;
    if (this.sliceEnableZ) flags |= 4;
    if (this.showSlicePlanes) flags |= 8;
    flags |= (VIEW_MODE_ID[this.viewMode] & 3) << 4;

    const clear = options.clear !== false;
    const alphaComposite = clear ? 0 : 1;

    const d = this.frameData;
    this.invViewProj.toArray(d, 0);
    d[16] = eye.x;
    d[17] = eye.y;
    d[18] = eye.z;
    d[19] = this.frameIndex++;
    d[20] = this.stepSize;
    d[21] = this.densityScale;
    // Enough steps to march the full box diagonal at the current step size (+ jitter/rounding margin),
    // so the far side of the volume is never left unsampled ("backside clipping"). Bounded by the hard
    // cap for pathological step sizes.
    const diagonal =
      2 * Math.hypot(this.boxHalf[0], this.boxHalf[1], this.boxHalf[2]);
    const neededSteps = Math.ceil(diagonal / Math.max(this.stepSize, 5e-4)) + 8;
    d[22] = Math.min(this.maxSteps, neededSteps);
    d[23] = this.exposure;
    d[24] = lx / llen;
    d[25] = ly / llen;
    d[26] = lz / llen;
    d[27] = this.ambient;
    d[28] = this.lightColor[0];
    d[29] = this.lightColor[1];
    d[30] = this.lightColor[2];
    d[31] = this.specularPower;
    d[32] = this.boxHalf[0];
    d[33] = this.boxHalf[1];
    d[34] = this.boxHalf[2];
    d[35] = BLEND_MODE_ID[this.blendMode];
    d[36] = this.gradientOpacity;
    d[37] = this.gradientOpacityScale;
    d[38] = this.lightingStrength;
    d[39] = this.liquidEnabled ? 1 : 0;
    d[40] = this.cropMin[0];
    d[41] = this.cropMin[1];
    d[42] = this.cropMin[2];
    d[43] = 0;
    d[44] = this.cropMax[0];
    d[45] = this.cropMax[1];
    d[46] = this.cropMax[2];
    d[47] = 0;
    d[48] = this.sliceX;
    d[49] = this.sliceY;
    d[50] = this.sliceZ;
    d[51] = flags;
    d[52] = this.liquidIor;
    d[53] = this.liquidRoughness;
    d[54] = this.liquidEnvIntensity;
    d[55] = this.liquidAbsorptionScale;
    d[56] = alphaComposite;
    d[57] = this.linearOutput ? 1 : 0; // Frame.composite.y → linear-HDR output flag
    d[58] = 0;
    d[59] = 0;
    this.frameUniform!.write(d);

    pass.setPipeline(this.pipeline!);
    pass.setBindGroup(0, this.bindGroup!);
    pass.draw(3);
  }

  public dispose(): void {
    this.frameUniform?.dispose();
    this.tfTex?.dispose();
    this.frameUniform = undefined;
    this.tfTex = undefined;
    this.volumeTex = undefined;
    this.pipeline = undefined;
    this.bindGroup = undefined;
  }

  private ensurePipeline(): void {
    if (this.pipeline) return;
    const module = this.cache.getModule("volume-raymarch-hq-v4", VOLUME_RAYMARCH_WGSL);
    this.pipeline = this.cache.getRenderPipeline({
      label: "volume-raymarch-hq-v4",
      layout: "auto",
      vertex: { module, entryPoint: "vs_main" },
      fragment: {
        module,
        entryPoint: "fs_main",
        targets: [
          {
            format: this.colorFormat,
            blend: {
              color: {
                srcFactor: "src-alpha",
                dstFactor: "one-minus-src-alpha",
                operation: "add",
              },
              alpha: {
                srcFactor: "one",
                dstFactor: "one-minus-src-alpha",
                operation: "add",
              },
            },
          },
        ],
      },
      primitive: { topology: "triangle-list" },
    });
    this.frameUniform = new ManagedBuffer(
      this.ctx.device,
      GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      VOLUME_FRAME_UNIFORM_SIZE,
    );
    this.volumeSampler = this.ctx.device.createSampler({
      magFilter: "linear",
      minFilter: "linear",
      addressModeU: "clamp-to-edge",
      addressModeV: "clamp-to-edge",
      addressModeW: "clamp-to-edge",
    });
    this.tfSampler = this.ctx.device.createSampler({
      magFilter: "linear",
      minFilter: "linear",
      addressModeU: "clamp-to-edge",
      addressModeV: "clamp-to-edge",
    });
  }

  private ensureBindGroup(): void {
    if (this.bindGroup) return;
    this.bindGroup = this.ctx.device.createBindGroup({
      label: "volume",
      layout: this.pipeline!.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.frameUniform!.gpu } },
        { binding: 1, resource: this.volumeTex!.createView({ dimension: "3d" }) },
        { binding: 2, resource: this.volumeSampler! },
        { binding: 3, resource: this.tfTex!.createView({ dimension: "2d" }) },
        { binding: 4, resource: this.tfSampler! },
      ],
    });
  }
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
