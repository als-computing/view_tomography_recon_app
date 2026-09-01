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
import { ManagedTexture } from "../resources/texture.js";
import { toGpuColor } from "../color.js";
import { TransferFunction } from "./transfer-function.js";
import { VOLUME_FRAME_UNIFORM_SIZE } from "../shaders/volume-raymarch.js";
import type { GpuLight } from "../lighting/index.js";
import { type ShaderConfigName, specializationFor } from "../accel/shader-config.js";
import { hashTransferFunction, type RenderProvenance } from "../accel/provenance.js";
import type { VisibilityFeedback } from "../accel/visibility.js";
import { VolumeAcceleration } from "../accel/volume-acceleration.js";
import { LightingPass, type LightingPassGbuffer } from "../accel/lighting-pass.js";
import type { RenderGraph, ResourceHandle } from "../graph/render-graph.js";
import { computeProvenance } from "./volume-provenance.js";
import {
  applyLiquidShading,
  applyMeasurePlane,
  applyLegacyLight,
  type LiquidShadingParams,
  type MeasurePlaneParams,
} from "./volume-shading-params.js";
import { applyVolumeLighting, type VolumeLightingParams } from "./volume-lighting.js";
import {
  writeVolumeFrameUniform,
  type VolumeBlendMode,
  type VolumeViewMode,
} from "./volume-uniforms.js";
import { VolumePipeline, VOLUME_DEPTH_FORMAT } from "./volume-pipeline.js";
import { VolumeBindings } from "./volume-bindings.js";
import { buildGaussianPreintegrationTable, defaultSigmaBuckets } from "./preintegration-2d.js";
import { floatToHalf } from "./volume-texture.js";

/** One mask/annotation slot's GPU-side state (item 7 Phase B). */
interface MaskSlot {
  tex: ManagedTexture | undefined;
  paletteTex: ManagedTexture | undefined;
  enabled: boolean;
}

export type { VolumeBlendMode, VolumeViewMode } from "./volume-uniforms.js";
export { VOLUME_DEPTH_FORMAT } from "./volume-pipeline.js";

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
  /** Named shader config (default `"baseline"`). Occupancy/tiles compile in `"fast"` / `"quality"`. */
  shaderConfig?: ShaderConfigName;
  /** Early-ray-termination alpha threshold (default `0.995`). */
  earlyRayTermination?: number;
}

/**
 * Ray-marches a volume each frame from an explicit view/projection.
 */
export class VolumeRenderer implements Disposable {
  private readonly pipelineMgr: VolumePipeline;
  private readonly bindings: VolumeBindings;
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
  private shaderConfig: ShaderConfigName = "baseline";
  private earlyRayTermination = 0.995;
  private visEnabled = false;
  private internalWidth = 1;
  private internalHeight = 1;
  private lastLut: Uint8Array | undefined;
  private lastLutSize = 512;
  private tfHash = "lut:00000000";
  // Occupancy grid, tile compactor, visibility feedback, opacity shadow map, and the multi-light
  // storage buffer, plus their rebuild bookkeeping — see render/accel/volume-acceleration.ts.
  private readonly acceleration: VolumeAcceleration;
  // Milestone 3.1/3.2 pre-integration: cumulative-extinction LUT texture (rebuilt with the TF);
  // dummy when unused. `r32float`, width = LUT size, height = sigma-bucket count (1 for now).
  private tPreintTex: ManagedTexture | undefined;
  private readonly dummyPreint: ManagedTexture;
  // Far-plane distance used to normalize the depth-centroid output (Milestone 5.1 TAAU reprojection).
  private reprojectFar = 1;

  private disposed = false;
  // Multi-light shading (prism lighting library) formula params: the light list itself lives on
  // `acceleration`; these scalars drive the shader's shadow-ray and ambient-occlusion marching.
  private masterAmbient = 0.22;
  private specStrength = 0.4;
  private roughnessL = 0.6;
  private shadowEnable = false;
  private shadowSteps = 24;
  private shadowStrength = 0.85;
  private shadowSoftness = 0;
  private aoEnable = false;
  private aoRadius = 0.08;
  private aoIntensity = 0.7;
  private aoSamples = 6;
  // Measure plane: a camera-linked fronto-parallel grey sheet composited in depth with the volume.
  private measurePlaneEnabled = false;
  private measurePlaneDepth = 0; // world units along the view axis (from the eye)
  private measurePlaneGray = 0.5;
  private measurePlaneAlpha = 0.35;
  private measureForward: [number, number, number] = [0, 0, 1];
  // Camera basis + FOV for the primary ray direction (see marchColor). Passed explicitly so the shader
  // never reconstructs the ray via invViewProj, which loses precision at large zoom-out and makes the
  // volume vanish / invert. Defaults frame a unit camera looking down -Z until setCameraBasis runs.
  private camRight: [number, number, number] = [1, 0, 0];
  private camUp: [number, number, number] = [0, 1, 0];
  private tanHalfFovY = Math.tan((42 * Math.PI) / 180 / 2);
  private camAspect = 1;

  private volumeTex: ManagedTexture | undefined;
  private tfTex: ManagedTexture | undefined;
  // High-res ROI brick composited over the coarse volume (null = none; coarse tex is bound as a dummy).
  private brickTex: ManagedTexture | undefined;
  private brickEnabled = false;
  private brickBlend = 1; // fade weight [0,1] for smooth zoom-out
  private brickMin: [number, number, number] = [0, 0, 0];
  private brickMax: [number, number, number] = [0, 0, 0];

  // Mask/annotation layers (item 7 Phase B): two independent, fixed slots (not generalized to N — see
  // the task this was extended for), each a same-grid r8uint class-id volume + its rgba8unorm palette
  // (class id → color+opacity). Dummies are genuinely valid r8uint/rgba8unorm textures (unlike
  // brickTex, nothing else bound has a compatible format to reuse as a fallback — see
  // volume-bindings.ts) and are shared across both slots (an empty stand-in needs no per-slot identity).
  private readonly masks: [MaskSlot, MaskSlot] = [
    { tex: undefined, paletteTex: undefined, enabled: false },
    { tex: undefined, paletteTex: undefined, enabled: false },
  ];
  private readonly dummyMaskTex: ManagedTexture;
  private readonly dummyMaskPalette: ManagedTexture;

  private readonly frameData = new Float32Array(VOLUME_FRAME_UNIFORM_SIZE / 4);
  private readonly invViewProj = new Mat4();
  private readonly lightingPass: LightingPass;

  public constructor(
    public readonly ctx: GpuContext,
    options: VolumeRendererOptions = {},
  ) {
    this.pipelineMgr = new VolumePipeline(ctx);
    this.bindings = new VolumeBindings(ctx.device);
    this.clearColor = toGpuColor(options.clearColor ?? [0.02, 0.03, 0.05, 1]);
    this.colorFormat = options.colorFormat ?? ctx.format;
    this.linearOutput = options.linearOutput ?? false;
    this.shaderConfig = options.shaderConfig ?? "baseline";
    this.earlyRayTermination = options.earlyRayTermination ?? 0.995;
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
    this.masterAmbient = this.ambient;
    this.acceleration = new VolumeAcceleration(ctx.device);
    this.lightingPass = new LightingPass(ctx.device);
    if (options.liquidShading) this.setLiquidShading(options.liquidShading);
    this.dummyPreint = new ManagedTexture(ctx.device, {
      size: [1, 1, 1],
      format: "r16float",
      dimension: "2d",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    this.dummyMaskTex = new ManagedTexture(ctx.device, {
      size: [1, 1, 1],
      format: "r8uint",
      dimension: "3d",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    this.dummyMaskPalette = new ManagedTexture(ctx.device, {
      size: [1, 1, 1],
      format: "rgba8unorm",
      dimension: "2d",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
  }

  public setVolume(texture: ManagedTexture): void {
    this.volumeTex = texture;
    this.bindings.invalidate();
    this.acceleration.notifyVolumeChanged(texture.desc.size);
  }

  /**
   * Enable/point the opacity shadow map (Milestone 7.1). `lightDir` is a unit vector toward the primary
   * shadow-casting light. A meaningful change of direction (or the enable) marks the map dirty so it
   * rebuilds on the next pre-pass; unchanged inputs cost nothing.
   */
  public setShadowMap(enabled: boolean, lightDir: readonly [number, number, number]): void {
    this.acceleration.setShadowMap(enabled, lightDir);
  }

  /**
   * Set (or clear with `null`) the high-res ROI brick composited over the coarse volume. `worldMin`/
   * `worldMax` are the world (sim-unit) box the brick texture's `[0,1]³` maps onto. When cleared, the
   * coarse texture is bound as a dummy for binding 6 and compositing is disabled.
   */
  public setBrick(
    texture: ManagedTexture | null,
    worldMin?: readonly [number, number, number],
    worldMax?: readonly [number, number, number],
  ): void {
    this.brickTex = texture ?? undefined;
    this.brickEnabled = texture !== null;
    if (worldMin && worldMax) {
      this.brickMin = [worldMin[0], worldMin[1], worldMin[2]];
      this.brickMax = [worldMax[0], worldMax[1], worldMax[2]];
    }
    this.bindings.invalidate(); // texture binding changed
  }

  /** Fade weight [0,1] for the brick (drives smooth zoom-out); no bind-group rebuild. */
  public setBrickBlend(weight: number): void {
    this.brickBlend = Math.min(1, Math.max(0, weight));
  }

  /**
   * Set (or clear with `null`) mask/annotation slot `slot`'s density texture (`r8uint`, item 7 Phase
   * B — exactly two independent slots, fixed). Assumed to share the primary volume's own world box (no
   * separate world-AABB/translation handling) — see the plan's Phase B design note for why that's a
   * safe assumption for an annotation of this scan.
   */
  public setMask(slot: 0 | 1, texture: ManagedTexture | null): void {
    const s = this.masks[slot];
    s.tex = texture ?? undefined;
    s.enabled = texture !== null;
    this.bindings.invalidate();
  }

  /** Replace mask slot `slot`'s palette (class id → color+opacity, `rgba8unorm`, one row). */
  public setMaskPalette(slot: 0 | 1, paletteTexture: ManagedTexture): void {
    this.masks[slot].paletteTex = paletteTexture;
    this.bindings.invalidate();
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
    this.lastLut = lut;
    this.lastLutSize = lutSize;
    this.tfHash = hashTransferFunction(lut);
    this.acceleration.markOccupancyTfDirty();
    this.acceleration.markShadowDirty();
    // Milestone 3.1/3.2: cumulative extinction LUT T(d, sigma) = the TF alpha curve blurred by `sigma`
    // then integrated 0..d (Gaussian-extended pre-integration). `r16float` is plenty of precision for
    // this monotonic [0,1]-ish curve (unlike the density-pyramid mean/meanSq moments, this isn't a
    // near-equal-value subtraction) and is filterable in core WebGPU, letting the shader use hardware
    // bilinear sampling on both axes instead of a manual lerp. Rebuilt with the TF; `sigma` (the row
    // axis) is a fixed, uniformly-spaced set of buckets — `preintAvgAlpha` in the shader picks the
    // per-sample row from the density pyramid's local variance at the current LOD.
    const alphaCurve = new Float32Array(lutSize);
    for (let i = 0; i < lutSize; i++) alphaCurve[i] = (lut[i * 4 + 3] ?? 0) / 255;
    const sigmaBuckets = defaultSigmaBuckets();
    const tTable = buildGaussianPreintegrationTable(alphaCurve, sigmaBuckets);
    this.tPreintTex?.dispose();
    this.tPreintTex = new ManagedTexture(this.ctx.device, {
      size: [lutSize, sigmaBuckets.length, 1],
      format: "r16float",
      dimension: "2d",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    const preintBytesPerRow = Math.max(256, Math.ceil((lutSize * 2) / 256) * 256);
    const preintPadded = new Uint8Array(preintBytesPerRow * sigmaBuckets.length);
    const preintView = new DataView(preintPadded.buffer);
    for (let row = 0; row < sigmaBuckets.length; row++) {
      const rowOffset = row * preintBytesPerRow;
      for (let i = 0; i < lutSize; i++) {
        preintView.setUint16(rowOffset + i * 2, floatToHalf(tTable[row * lutSize + i] ?? 0), true);
      }
    }
    this.ctx.device.queue.writeTexture(
      { texture: this.tPreintTex.gpu },
      preintPadded,
      { bytesPerRow: preintBytesPerRow, rowsPerImage: sigmaBuckets.length },
      { width: lutSize, height: sigmaBuckets.length, depthOrArrayLayers: 1 },
    );
    this.bindings.invalidate();
  }

  /**
   * Enable CGI-style dielectric liquid shading (Fresnel free-surface, procedural env reflection,
   * Beer–Lambert absorption). When disabled, uses the legacy TF Blinn-Phong path.
   */
  public setLiquidShading(params: LiquidShadingParams): void {
    const next = applyLiquidShading(
      {
        enabled: this.liquidEnabled,
        ior: this.liquidIor,
        roughness: this.liquidRoughness,
        envIntensity: this.liquidEnvIntensity,
        absorptionScale: this.liquidAbsorptionScale,
      },
      params,
    );
    this.liquidEnabled = next.enabled;
    this.liquidIor = next.ior;
    this.liquidRoughness = next.roughness;
    this.liquidEnvIntensity = next.envIntensity;
    this.liquidAbsorptionScale = next.absorptionScale;
  }

  /**
   * Replace the light list (uploaded to the GPU storage buffer). Rebuilt each frame by the viewer
   * from the enabled lighting modes + camera basis. The first directional light also drives the
   * procedural studio environment (`envRadiance`/`background`).
   */
  public setLights(lights: readonly GpuLight[]): void {
    this.acceleration.setLights(lights);
  }

  /**
   * Camera-linked measure plane: a fronto-parallel grey sheet composited in depth with the volume.
   * `depth` is world distance from the eye along `forward` (a unit view-axis vector); `gray`/`alpha` in
   * [0,1]. Call each frame with the current camera forward so the plane tracks the view.
   */
  public setMeasurePlane(params: MeasurePlaneParams): void {
    const next = applyMeasurePlane(params);
    this.measurePlaneEnabled = next.enabled;
    this.measurePlaneDepth = next.depth;
    this.measurePlaneGray = next.gray;
    this.measurePlaneAlpha = next.alpha;
    this.measureForward = next.forward;
  }

  /** Shadow / AO / master-ambient / specular controls for the multi-light path. */
  public setLightingParams(params: VolumeLightingParams): void {
    const next = applyVolumeLighting(
      {
        masterAmbient: this.masterAmbient,
        specStrength: this.specStrength,
        roughnessL: this.roughnessL,
        shadowEnable: this.shadowEnable,
        shadowSteps: this.shadowSteps,
        shadowStrength: this.shadowStrength,
        shadowSoftness: this.shadowSoftness,
        aoEnable: this.aoEnable,
        aoRadius: this.aoRadius,
        aoIntensity: this.aoIntensity,
        aoSamples: this.aoSamples,
      },
      params,
    );
    this.masterAmbient = next.masterAmbient;
    this.specStrength = next.specStrength;
    this.roughnessL = next.roughnessL;
    this.shadowEnable = next.shadowEnable;
    this.shadowSteps = next.shadowSteps;
    this.shadowStrength = next.shadowStrength;
    this.shadowSoftness = next.shadowSoftness;
    this.aoEnable = next.aoEnable;
    this.aoRadius = next.aoRadius;
    this.aoIntensity = next.aoIntensity;
    this.aoSamples = next.aoSamples;
  }

  public setBlendMode(mode: VolumeBlendMode): void {
    this.blendMode = mode;
  }

  /** Named shader config. `"baseline"` (default) has occupancy/tiles compiled out. */
  public setShaderConfig(name: ShaderConfigName): void {
    if (this.shaderConfig === name) return;
    this.shaderConfig = name;
    this.pipelineMgr.invalidatePipeline();
    this.bindings.invalidate();
  }

  public getShaderConfig(): ShaderConfigName {
    return this.shaderConfig;
  }

  /** Enable ray-guided vis-bin accumulation (default off). */
  public setVisibilityFeedback(enabled: boolean): void {
    this.visEnabled = enabled;
    this.acceleration.setVisibilityEnabled(enabled);
  }

  /** Latest decoded vis-bin weights, or `undefined` before the first readback. */
  public get visibility(): VisibilityFeedback {
    return this.acceleration.visibilityFeedback;
  }

  /** Early-ray-termination alpha threshold in `(0, 1]` (default `0.995`). */
  public setEarlyRayTermination(threshold: number): void {
    this.earlyRayTermination = Math.min(1, Math.max(0.5, threshold));
  }

  /** Internal HDR size the volume pass renders into (for tile compaction). */
  public setInternalSize(width: number, height: number): void {
    this.internalWidth = Math.max(1, width);
    this.internalHeight = Math.max(1, height);
  }

  /** Far-plane distance used to normalize the depth-centroid output for TAAU reprojection. */
  public setReprojectFar(far: number): void {
    this.reprojectFar = Math.max(1e-6, far);
  }

  /**
   * Camera basis + FOV for building the primary ray direction in the shader (see marchColor). Supplying
   * the unit right/up/forward axes and FOV lets the ray-march reconstruct directions without invViewProj,
   * which degrades in float32 at large zoom-out (volume vanishing / inverting). `right`/`up`/`forward`
   * must be unit and orthonormal; `fovYRadians` is the vertical FOV and `aspect` = width/height.
   */
  public setCameraBasis(
    right: [number, number, number],
    up: [number, number, number],
    forward: [number, number, number],
    fovYRadians: number,
    aspect: number,
  ): void {
    this.camRight = right;
    this.camUp = up;
    this.tanHalfFovY = Math.tan(Math.max(1e-3, fovYRadians) * 0.5);
    this.camAspect = Math.max(1e-3, aspect);
    // The shader reads the camera forward from the measureFwd slot (also what the measure plane needs);
    // keep it in sync so the ray forward is fresh every frame even if setMeasurePlane isn't called.
    this.measureForward = forward;
  }

  /**
   * Occupancy rebuild + tile classify + vis-bin copy. Call on the same encoder, before the volume
   * render pass, when the current shader config uses those structures.
   */
  public recordPrePasses(
    encoder: GPUCommandEncoder,
    viewProj: Mat4,
    eye: { x: number; y: number; z: number },
  ): void {
    const spec = specializationFor(this.shaderConfig);
    this.pipelineMgr.ensure(this.shaderConfig, this.colorFormat);
    this.writeUniforms(viewProj, eye, { clear: true });
    const bindGroupDirty = this.acceleration.runPrePasses(encoder, {
      viewProj,
      spec,
      volumeTex: this.volumeTex,
      lastLut: this.lastLut,
      lastLutSize: this.lastLutSize,
      frameUniformGpu: this.pipelineMgr.uniformBuffer.gpu,
      internalWidth: this.internalWidth,
      internalHeight: this.internalHeight,
      boxHalf: this.boxHalf,
      tfTex: this.tfTex,
      tfSampler: this.pipelineMgr.tfSamplerHandle,
      shadowEnable: this.shadowEnable,
      densityScale: this.densityScale,
      cropMin: this.cropMin,
      cropMax: this.cropMax,
    });
    if (bindGroupDirty) this.bindings.invalidate();
  }

  /** Map pending vis-bin readback. Must run after the encoder that copied it has been submitted. */
  public afterSubmit(): void {
    this.acceleration.afterSubmit();
  }

  /**
   * Provenance block for PNG export / screenshot stamping. `taauFrames` must be supplied by the
   * caller — this renderer doesn't own the TAAU accumulator (it lives in the viewer, rebuilt per
   * frame from the camera).
   */
  public provenance(
    renderScale: number,
    taauFrames: number,
    extras?: Partial<RenderProvenance>,
  ): RenderProvenance {
    return computeProvenance(
      this.shaderConfig,
      this.tfHash,
      renderScale,
      taauFrames,
      this.shadowEnable,
      extras,
    );
  }

  public setViewMode(mode: VolumeViewMode): void {
    this.viewMode = mode;
  }

  /** Crop region in normalized volume UVW `[0,1]^3`. */
  public setCrop(min: readonly [number, number, number], max: readonly [number, number, number]): void {
    const nmin: [number, number, number] = [
      Math.min(min[0], max[0]),
      Math.min(min[1], max[1]),
      Math.min(min[2], max[2]),
    ];
    const nmax: [number, number, number] = [
      Math.max(min[0], max[0]),
      Math.max(min[1], max[1]),
      Math.max(min[2], max[2]),
    ];
    // The shadow map excludes cropped-away material, so a crop change invalidates it (only when it
    // actually changed — setCrop is re-called every applyRender).
    if (nmin.some((v, i) => v !== this.cropMin[i]) || nmax.some((v, i) => v !== this.cropMax[i])) {
      this.acceleration.markShadowDirty();
    }
    this.cropMin = nmin;
    this.cropMax = nmax;
  }

  public resetCrop(): void {
    if (this.cropMin[0] !== 0 || this.cropMin[1] !== 0 || this.cropMin[2] !== 0) {
      this.acceleration.markShadowDirty();
    }
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
    if (params.densityScale !== undefined && params.densityScale !== this.densityScale) {
      this.densityScale = params.densityScale;
      this.acceleration.markShadowDirty(); // τ scales with density → the shadow map must rebuild
    }
    if (params.maxSteps !== undefined) this.maxSteps = params.maxSteps;
    if (params.exposure !== undefined) this.exposure = params.exposure;
    const nextLight = applyLegacyLight(
      {
        ambient: this.ambient,
        specularPower: this.specularPower,
        lightDirection: this.lightDirection,
        lightColor: this.lightColor,
      },
      params,
    );
    this.ambient = nextLight.ambient;
    this.specularPower = nextLight.specularPower;
    this.lightDirection = nextLight.lightDirection;
    this.lightColor = nextLight.lightColor;
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
    const volumeTex = this.volumeTex;
    const tfTex = this.tfTex;
    if (!volumeTex || !tfTex) {
      // Not ready yet (volume/TF still uploading) — skip this frame instead of throwing every tick.
      return;
    }
    this.pipelineMgr.ensure(this.shaderConfig, this.colorFormat);
    this.frameIndex++;
    this.writeUniforms(viewProj, eye, options);

    const spec = specializationFor(this.shaderConfig);
    const bindGroup = this.bindings.ensure({
      layout: this.pipelineMgr.layout,
      frameUniform: this.pipelineMgr.uniformBuffer,
      volumeTex,
      volumeSampler: this.pipelineMgr.sampler,
      tfTex,
      tfSampler: this.pipelineMgr.tfSamplerHandle,
      brickTex: this.brickTex,
      preintTex: this.tPreintTex ?? this.dummyPreint,
      spec,
      acceleration: this.acceleration,
      maskTex: [
        this.masks[0].tex ?? this.dummyMaskTex,
        this.masks[1].tex ?? this.dummyMaskTex,
      ],
      maskPaletteTex: [
        this.masks[0].paletteTex ?? this.dummyMaskPalette,
        this.masks[1].paletteTex ?? this.dummyMaskPalette,
      ],
    });

    const background = this.pipelineMgr.background;
    if (spec.tiles && background) {
      pass.setPipeline(background.pipeline);
      pass.setBindGroup(0, background.bindGroup);
      pass.draw(3);
    }
    pass.setPipeline(this.pipelineMgr.renderPipeline);
    pass.setBindGroup(0, bindGroup);
    if (spec.tiles) {
      pass.drawIndirect(this.acceleration.tileDrawIndirectBuffer, 0);
    } else {
      pass.draw(3);
    }
  }

  private writeUniforms(
    viewProj: Mat4,
    eye: { x: number; y: number; z: number },
    options: { clear?: boolean } = {},
  ): void {
    this.invViewProj.copy(viewProj);
    if (!this.invViewProj.invert()) return;

    writeVolumeFrameUniform(this.frameData, this.invViewProj, this.acceleration, {
      eye,
      clear: options.clear !== false,
      frameIndex: this.frameIndex,
      boxHalf: this.boxHalf,
      maxSteps: this.maxSteps,
      stepSize: this.stepSize,
      densityScale: this.densityScale,
      exposure: this.exposure,
      masterAmbient: this.masterAmbient,
      specularPower: this.specularPower,
      blendMode: this.blendMode,
      gradientOpacity: this.gradientOpacity,
      gradientOpacityScale: this.gradientOpacityScale,
      lightingStrength: this.lightingStrength,
      liquidEnabled: this.liquidEnabled,
      liquidIor: this.liquidIor,
      liquidRoughness: this.liquidRoughness,
      liquidEnvIntensity: this.liquidEnvIntensity,
      liquidAbsorptionScale: this.liquidAbsorptionScale,
      cropMin: this.cropMin,
      cropMax: this.cropMax,
      sliceX: this.sliceX,
      sliceY: this.sliceY,
      sliceZ: this.sliceZ,
      sliceEnableX: this.sliceEnableX,
      sliceEnableY: this.sliceEnableY,
      sliceEnableZ: this.sliceEnableZ,
      showSlicePlanes: this.showSlicePlanes,
      viewMode: this.viewMode,
      linearOutput: this.linearOutput,
      earlyRayTermination: this.earlyRayTermination,
      specStrength: this.specStrength,
      roughnessL: this.roughnessL,
      shadowEnable: this.shadowEnable,
      shadowSteps: this.shadowSteps,
      shadowStrength: this.shadowStrength,
      shadowSoftness: this.shadowSoftness,
      aoEnable: this.aoEnable,
      aoRadius: this.aoRadius,
      aoIntensity: this.aoIntensity,
      aoSamples: this.aoSamples,
      measurePlaneEnabled: this.measurePlaneEnabled,
      measurePlaneDepth: this.measurePlaneDepth,
      measurePlaneGray: this.measurePlaneGray,
      measurePlaneAlpha: this.measurePlaneAlpha,
      measureForward: this.measureForward,
      brickMin: this.brickMin,
      brickMax: this.brickMax,
      brickEnabled: this.brickEnabled,
      brickBlend: this.brickBlend,
      visEnabled: this.visEnabled,
      internalWidth: this.internalWidth,
      internalHeight: this.internalHeight,
      reprojectFar: this.reprojectFar,
      camRight: this.camRight,
      camUp: this.camUp,
      camAspect: this.camAspect,
      tanHalfFovY: this.tanHalfFovY,
      masks: [
        { enabled: this.masks[0].enabled, dims: this.masks[0].tex?.desc.size ?? [1, 1, 1] },
        { enabled: this.masks[1].enabled, dims: this.masks[1].tex?.desc.size ?? [1, 1, 1] },
      ],
    });
    this.pipelineMgr.uniformBuffer.write(this.frameData);
  }

  /**
   * Milestone 6 (B3) Step 5, debug-only: add the half-res lighting pass to `graph`, reading `gbuffer`
   * (the just-recorded volume pass's `surfacePos`/`surfaceNormal`/`surfaceAlbedo` targets), and return
   * the `lightAdd` handle for {@link "../post/fx-pipeline".FxPipeline.render}'s debug blit. `undefined`
   * before the volume/TF are loaded.
   */
  public recordLightingDebug(
    graph: RenderGraph,
    gbuffer: LightingPassGbuffer,
    width: number,
    height: number,
  ): ResourceHandle | undefined {
    const volumeTex = this.volumeTex;
    const tfTex = this.tfTex;
    if (!volumeTex || !tfTex) return undefined;
    return this.lightingPass.resolve(graph, {
      frameUniform: this.pipelineMgr.uniformBuffer.gpu,
      volumeTex: volumeTex.gpu,
      volumeSampler: this.pipelineMgr.sampler,
      tfTex: tfTex.gpu,
      tfSampler: this.pipelineMgr.tfSamplerHandle,
      lightsBuffer: this.acceleration.lightBuffer,
      brickTex: (this.brickTex ?? volumeTex).gpu,
      shadowTex: this.acceleration.shadowMapTexture.gpu,
      surfacePos: gbuffer.surfacePos,
      surfaceNormal: gbuffer.surfaceNormal,
      surfaceAlbedo: gbuffer.surfaceAlbedo,
      fullWidth: width,
      fullHeight: height,
    });
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.pipelineMgr.dispose();
    this.tfTex?.dispose();
    this.acceleration.dispose();
    this.lightingPass.dispose();
    this.tPreintTex?.dispose();
    this.dummyPreint.dispose();
    this.dummyMaskTex.dispose();
    this.dummyMaskPalette.dispose();
    this.tfTex = undefined;
    this.volumeTex = undefined;
    this.bindings.invalidate();
  }

}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
