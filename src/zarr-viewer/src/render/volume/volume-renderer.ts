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
  VOLUME_BACKGROUND_WGSL,
  volumeRaymarchWgsl,
} from "../shaders/volume-raymarch.js";
import { LightingEnvironment, type GpuLight } from "../lighting/index.js";
import {
  type ShaderConfigName,
  specializationFor,
  approximateShadingLabel,
} from "../accel/shader-config.js";
import { hashTransferFunction, type RenderProvenance } from "../accel/provenance.js";
import { VisibilityFeedback, VIS_GRID_DEFAULT } from "../accel/visibility.js";
import { OccupancyGrid } from "../accel/occupancy.js";
import { TileCompactor, TILE_SIZE } from "../accel/tiles.js";
import { ShadowMap } from "../accel/shadow-map.js";

/**
 * Second render target of the volume pass (Milestone 5.1): the transmittance-weighted depth centroid,
 * normalized by the far plane. Consumed by TAAU reprojection; a single filterable channel is enough.
 */
export const VOLUME_DEPTH_FORMAT: GPUTextureFormat = "r16float";

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
  /** Named shader config (default `"baseline"`). Occupancy/tiles compile in `"fast"` / `"quality"`. */
  shaderConfig?: ShaderConfigName;
  /** Early-ray-termination alpha threshold (default `0.995`). */
  earlyRayTermination?: number;
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
  private shaderConfig: ShaderConfigName = "baseline";
  private earlyRayTermination = 0.995;
  private visEnabled = false;
  private internalWidth = 1;
  private internalHeight = 1;
  private lastLut: Uint8Array | undefined;
  private lastLutSize = 512;
  private tfHash = "lut:00000000";
  private dirtyOccMinMax = true;
  private dirtyOccTf = true;
  private bindGroupLayout: GPUBindGroupLayout | undefined;
  private pipelineLayout: GPUPipelineLayout | undefined;
  private bgPipeline: GPURenderPipeline | undefined;
  private bgBindGroup: GPUBindGroup | undefined;
  private occupancy: OccupancyGrid | undefined;
  private readonly vis: VisibilityFeedback;
  private readonly tiles: TileCompactor;
  private dummyOcc: ManagedBuffer;
  private dummyPrefix: ManagedBuffer;
  private dummyTiles: ManagedBuffer;
  // Milestone 3.1 pre-integration: cumulative-extinction LUT (rebuilt with the TF); dummy when unused.
  private tPreintBuffer: ManagedBuffer | undefined;
  private dummyPreint: ManagedBuffer;
  // Milestone 7.1: light-space opacity shadow map (rebuilt on demand from TF / density / light dir).
  private readonly shadowMap: ShadowMap;
  private shadowMapEnabled = false;
  private shadowMapBuilt = false;
  private dirtyShadow = true;
  private shadowLightDir: [number, number, number] = [0.45, 0.85, 0.35];
  private readonly worldToLight = new Float32Array(16);
  // Far-plane distance used to normalize the depth-centroid output (Milestone 5.1 TAAU reprojection).
  private reprojectFar = 1;

  // Multi-light shading (prism lighting library). The light list is rebuilt per frame by the viewer
  // (global / camera flashlight / stage) and uploaded to this storage buffer; the control params
  // below drive the shader's shadow-ray and ambient-occlusion marching.
  private lightEnv: LightingEnvironment | undefined;
  private numLights = 0;
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

  private pipeline: GPURenderPipeline | undefined;
  private frameUniform: ManagedBuffer | undefined;
  private bindGroup: GPUBindGroup | undefined;
  private volumeTex: ManagedTexture | undefined;
  private tfTex: ManagedTexture | undefined;
  private volumeSampler: GPUSampler | undefined;
  private tfSampler: GPUSampler | undefined;
  // High-res ROI brick composited over the coarse volume (null = none; coarse tex is bound as a dummy).
  private brickTex: ManagedTexture | undefined;
  private brickEnabled = false;
  private brickBlend = 1; // fade weight [0,1] for smooth zoom-out
  private brickMin: [number, number, number] = [0, 0, 0];
  private brickMax: [number, number, number] = [0, 0, 0];

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
    // Storage buffer of packed lights (bound at binding 5). Small capacity: this viewer uses at most
    // ~6 procedural lights (1 global + 1 flashlight + 4 stage).
    this.lightEnv = new LightingEnvironment(ctx.device, 16);
    if (options.liquidShading) this.setLiquidShading(options.liquidShading);
    this.vis = new VisibilityFeedback(ctx.device, [
      VIS_GRID_DEFAULT,
      VIS_GRID_DEFAULT,
      VIS_GRID_DEFAULT,
    ]);
    this.tiles = new TileCompactor(ctx.device);
    this.dummyOcc = OccupancyGrid.dummy(ctx.device);
    this.dummyPrefix = OccupancyGrid.dummyPrefix(ctx.device);
    this.dummyTiles = TileCompactor.dummyTiles(ctx.device);
    this.dummyPreint = new ManagedBuffer(
      ctx.device,
      GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      8,
    );
    this.shadowMap = new ShadowMap(ctx.device);
  }

  public setVolume(texture: ManagedTexture): void {
    this.volumeTex = texture;
    this.bindGroup = undefined;
    const size = texture.desc.size;
    const same =
      this.occupancy &&
      this.occupancy.grid[0] === Math.max(1, Math.ceil(size[0] / this.occupancy.cellSize)) &&
      this.occupancy.grid[1] === Math.max(1, Math.ceil(size[1] / this.occupancy.cellSize)) &&
      this.occupancy.grid[2] === Math.max(1, Math.ceil(size[2] / this.occupancy.cellSize));
    if (!same) {
      this.occupancy?.dispose();
      this.occupancy = new OccupancyGrid(this.ctx.device, size);
    }
    this.dirtyOccMinMax = true;
    this.dirtyOccTf = true;
    this.dirtyShadow = true;
  }

  /**
   * Enable/point the opacity shadow map (Milestone 7.1). `lightDir` is a unit vector toward the primary
   * shadow-casting light. A meaningful change of direction (or the enable) marks the map dirty so it
   * rebuilds on the next pre-pass; unchanged inputs cost nothing.
   */
  public setShadowMap(enabled: boolean, lightDir: readonly [number, number, number]): void {
    const dot =
      lightDir[0] * this.shadowLightDir[0] +
      lightDir[1] * this.shadowLightDir[1] +
      lightDir[2] * this.shadowLightDir[2];
    if (enabled !== this.shadowMapEnabled || dot < 0.9995) this.dirtyShadow = true;
    this.shadowMapEnabled = enabled;
    this.shadowLightDir = [lightDir[0], lightDir[1], lightDir[2]];
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
    this.bindGroup = undefined; // texture binding changed
  }

  /** Fade weight [0,1] for the brick (drives smooth zoom-out); no bind-group rebuild. */
  public setBrickBlend(weight: number): void {
    this.brickBlend = Math.min(1, Math.max(0, weight));
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
    this.dirtyOccTf = true;
    this.dirtyShadow = true;
    // Milestone 3.1: cumulative extinction LUT T(d) = ∫₀^d α(x) dx (trapezoidal), kept f32 for the
    // cancellation-prone ratio form. Rebuilt with the TF; consumed by the quality shader's pre-integration.
    const tCurve = new Float32Array(lutSize);
    const dd = 1 / Math.max(1, lutSize - 1);
    let acc = 0;
    let prevA = (lut[3] ?? 0) / 255;
    for (let i = 1; i < lutSize; i++) {
      const a = (lut[i * 4 + 3] ?? 0) / 255;
      acc += 0.5 * (prevA + a) * dd;
      tCurve[i] = acc;
      prevA = a;
    }
    this.tPreintBuffer?.dispose();
    this.tPreintBuffer = ManagedBuffer.fromData(this.ctx.device, GPUBufferUsage.STORAGE, tCurve);
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

  /**
   * Replace the light list (uploaded to the GPU storage buffer). Rebuilt each frame by the viewer
   * from the enabled lighting modes + camera basis. The first directional light also drives the
   * procedural studio environment (`envRadiance`/`background`).
   */
  public setLights(lights: readonly GpuLight[]): void {
    this.lightEnv!.setLights(lights);
    this.numLights = this.lightEnv!.lightCount;
  }

  /**
   * Camera-linked measure plane: a fronto-parallel grey sheet composited in depth with the volume.
   * `depth` is world distance from the eye along `forward` (a unit view-axis vector); `gray`/`alpha` in
   * [0,1]. Call each frame with the current camera forward so the plane tracks the view.
   */
  public setMeasurePlane(params: {
    enabled: boolean;
    depth: number;
    gray: number;
    alpha: number;
    forward: readonly [number, number, number];
  }): void {
    this.measurePlaneEnabled = params.enabled;
    this.measurePlaneDepth = params.depth;
    this.measurePlaneGray = params.gray;
    this.measurePlaneAlpha = params.alpha;
    this.measureForward = [params.forward[0], params.forward[1], params.forward[2]];
  }

  /** Shadow / AO / master-ambient / specular controls for the multi-light path. */
  public setLightingParams(params: {
    masterAmbient?: number;
    specStrength?: number;
    roughness?: number;
    shadowEnable?: boolean;
    shadowSteps?: number;
    shadowStrength?: number;
    shadowSoftness?: number;
    aoEnable?: boolean;
    aoRadius?: number;
    aoIntensity?: number;
    aoSamples?: number;
  }): void {
    if (params.masterAmbient !== undefined) this.masterAmbient = params.masterAmbient;
    if (params.specStrength !== undefined) this.specStrength = params.specStrength;
    if (params.roughness !== undefined) this.roughnessL = params.roughness;
    if (params.shadowEnable !== undefined) this.shadowEnable = params.shadowEnable;
    if (params.shadowSteps !== undefined) this.shadowSteps = Math.max(0, Math.round(params.shadowSteps));
    if (params.shadowStrength !== undefined) this.shadowStrength = params.shadowStrength;
    if (params.shadowSoftness !== undefined) this.shadowSoftness = params.shadowSoftness;
    if (params.aoEnable !== undefined) this.aoEnable = params.aoEnable;
    if (params.aoRadius !== undefined) this.aoRadius = params.aoRadius;
    if (params.aoIntensity !== undefined) this.aoIntensity = params.aoIntensity;
    if (params.aoSamples !== undefined) this.aoSamples = Math.max(0, Math.round(params.aoSamples));
  }

  public setBlendMode(mode: VolumeBlendMode): void {
    this.blendMode = mode;
  }

  /** Named shader config. `"baseline"` (default) has occupancy/tiles compiled out. */
  public setShaderConfig(name: ShaderConfigName): void {
    if (this.shaderConfig === name) return;
    this.shaderConfig = name;
    this.pipeline = undefined;
    this.bindGroup = undefined;
  }

  public getShaderConfig(): ShaderConfigName {
    return this.shaderConfig;
  }

  /** Enable ray-guided vis-bin accumulation (default off). */
  public setVisibilityFeedback(enabled: boolean): void {
    this.visEnabled = enabled;
    this.vis.enabled = enabled;
  }

  /** Latest decoded vis-bin weights, or `undefined` before the first readback. */
  public get visibility(): VisibilityFeedback {
    return this.vis;
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
    this.ensurePipeline();
    this.writeUniforms(viewProj, eye, { clear: true });
    if (spec.occupancy && this.occupancy && this.volumeTex) {
      if (this.dirtyOccMinMax) {
        this.occupancy.rebuildMinMax(encoder, this.volumeTex);
        this.dirtyOccMinMax = false;
        this.dirtyOccTf = true;
      }
      if (this.dirtyOccTf && this.lastLut) {
        this.occupancy.rebuildForTransferFunction(encoder, this.lastLut, this.lastLutSize);
        this.dirtyOccTf = false;
        this.bindGroup = undefined;
      }
    }
    if (spec.tiles && this.frameUniform) {
      const bbox = this.aabbScreenBbox(viewProj, this.internalWidth, this.internalHeight);
      const rebuilt = this.tiles.record(
        encoder,
        this.frameUniform.gpu,
        spec.occupancy ? this.occupancy : undefined,
        this.dummyOcc.gpu,
        this.internalWidth,
        this.internalHeight,
        bbox,
      );
      if (rebuilt) this.bindGroup = undefined;
    }
    // Milestone 7.1: rebuild the opacity shadow map only when dirty (TF / density / light dir changed)
    // and shadows are on. Render-on-demand keeps this off the idle path.
    if (
      this.shadowMapEnabled &&
      this.shadowEnable &&
      this.dirtyShadow &&
      this.volumeTex &&
      this.tfTex &&
      this.tfSampler
    ) {
      const t = this.shadowMap.rebuild(encoder, this.volumeTex, this.tfTex, this.tfSampler, {
        lightDir: this.shadowLightDir,
        boxHalf: this.boxHalf,
        densityScale: this.densityScale,
        sigmaMul: 12,
        cropMin: this.cropMin,
        cropMax: this.cropMax,
      });
      this.worldToLight.set(t.worldToLightUvw);
      this.shadowMapBuilt = true;
      this.dirtyShadow = false;
    }
    this.vis.recordCopy(encoder);
  }

  /**
   * Screen-space pixel bounding box of the volume AABB, for conservative tile classification. Projects
   * the 8 box corners with `viewProj`; returns `null` when any corner is at/behind the camera (the box
   * can't be reliably bounded on screen → the caller keeps every tile that frame). Padded by one tile.
   */
  private aabbScreenBbox(
    viewProj: Mat4,
    w: number,
    h: number,
  ): { minX: number; minY: number; maxX: number; maxY: number } | null {
    const e = viewProj.elements;
    const [hx, hy, hz] = this.boxHalf;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < 8; i++) {
      const x = i & 1 ? hx : -hx;
      const y = i & 2 ? hy : -hy;
      const z = i & 4 ? hz : -hz;
      const cx = e[0]! * x + e[4]! * y + e[8]! * z + e[12]!;
      const cy = e[1]! * x + e[5]! * y + e[9]! * z + e[13]!;
      const cw = e[3]! * x + e[7]! * y + e[11]! * z + e[15]!;
      if (cw <= 1e-6) return null; // corner at/behind the camera — can't bound; keep all tiles
      const px = ((cx / cw) * 0.5 + 0.5) * w;
      // The fragment shader reconstructs rays with ndc.y = 2·py/h − 1 (y-flipped from standard clip),
      // so a point renders at py = (ndc.y + 1)/2·h — match that, or the bbox is vertically mirrored.
      const py = ((cy / cw) * 0.5 + 0.5) * h;
      minX = Math.min(minX, px);
      maxX = Math.max(maxX, px);
      minY = Math.min(minY, py);
      maxY = Math.max(maxY, py);
    }
    const pad = TILE_SIZE; // never clip at the very edge
    return {
      minX: Math.max(0, minX - pad),
      minY: Math.max(0, minY - pad),
      maxX: Math.min(w, maxX + pad),
      maxY: Math.min(h, maxY + pad),
    };
  }

  /** Map pending vis-bin readback. Must run after the encoder that copied it has been submitted. */
  public afterSubmit(): void {
    this.vis.afterSubmit();
  }

  /** Provenance block for PNG export / screenshot stamping. */
  public provenance(renderScale: number, extras?: Partial<RenderProvenance>): RenderProvenance {
    const spec = specializationFor(this.shaderConfig);
    return {
      shaderConfig: this.shaderConfig,
      multiScatterOctaves: spec.multiScatterOctaves,
      taauFrames: 0,
      shadowMode: this.shadowEnable ? "macrocell-sweep" : "none",
      transferFunction: this.tfHash,
      renderScale,
      ...extras,
    };
  }

  /** Visible approximate-shading banner, or `null` when none is active. */
  public approximateShadingBanner(): string | null {
    return approximateShadingLabel(specializationFor(this.shaderConfig));
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
      this.dirtyShadow = true;
    }
    this.cropMin = nmin;
    this.cropMax = nmax;
  }

  public resetCrop(): void {
    if (this.cropMin[0] !== 0 || this.cropMin[1] !== 0 || this.cropMin[2] !== 0) this.dirtyShadow = true;
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
      this.dirtyShadow = true; // τ scales with density → the shadow map must rebuild
    }
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
      // Not ready yet (volume/TF still uploading) — skip this frame instead of throwing every tick.
      return;
    }
    this.ensurePipeline();
    this.frameIndex++;
    this.writeUniforms(viewProj, eye, options);
    this.ensureBindGroup();

    const spec = specializationFor(this.shaderConfig);
    if (spec.tiles && this.bgPipeline && this.bgBindGroup) {
      pass.setPipeline(this.bgPipeline);
      pass.setBindGroup(0, this.bgBindGroup);
      pass.draw(3);
    }
    pass.setPipeline(this.pipeline!);
    pass.setBindGroup(0, this.bindGroup!);
    if (spec.tiles) {
      pass.drawIndirect(this.tiles.drawIndirectBuffer, 0);
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

    // Key light for the procedural studio env (background / dielectric): the first directional in
    // the light list, or a sensible default when none is set.
    const keyDir = this.lightEnv!.keyLightDirection;
    const keyRad = this.lightEnv!.keyLightRadiance;
    const klen = Math.hypot(keyDir[0], keyDir[1], keyDir[2]) || 1;

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
    d[19] = this.frameIndex;
    // Never let the step be so fine that the hard iteration cap can't cross the volume — otherwise the
    // far side is left unsampled and the volume appears to vanish. Floor the step at the budget-limited
    // minimum (diagonal / usable steps) so the ray always reaches the far face; a requested step finer
    // than that is clamped up (as fine as the budget allows). This makes any caller-set step (e.g. the
    // fine ROI-brick step) safe regardless of box size / sample-distance.
    const diagonal =
      2 * Math.hypot(this.boxHalf[0], this.boxHalf[1], this.boxHalf[2]);
    const minStep = diagonal / Math.max(this.maxSteps - 8, 1);
    const effStep = Math.max(this.stepSize, minStep, 5e-4);
    d[20] = effStep;
    d[21] = this.densityScale;
    const neededSteps = Math.ceil(diagonal / effStep) + 8;
    d[22] = Math.min(this.maxSteps, neededSteps);
    d[23] = this.exposure;
    d[24] = keyDir[0] / klen;
    d[25] = keyDir[1] / klen;
    d[26] = keyDir[2] / klen;
    d[27] = this.masterAmbient;
    d[28] = keyRad[0];
    d[29] = keyRad[1];
    d[30] = keyRad[2];
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
    d[58] = this.earlyRayTermination;
    d[59] = 0;
    // lightCtl0: numLights, masterAmbient, specStrength, roughness
    d[60] = this.numLights;
    d[61] = this.masterAmbient;
    d[62] = this.specStrength;
    d[63] = this.roughnessL;
    // lightCtl1: shadowEnable, shadowSteps, shadowStrength, shadowSoftness
    d[64] = this.shadowEnable ? 1 : 0;
    d[65] = this.shadowSteps;
    d[66] = this.shadowStrength;
    d[67] = this.shadowSoftness;
    // lightCtl2: aoEnable, aoRadius, aoIntensity, aoSamples
    d[68] = this.aoEnable ? 1 : 0;
    d[69] = this.aoRadius;
    d[70] = this.aoIntensity;
    d[71] = this.aoSamples;
    // measurePlane: enable, depth (world along view axis), gray, alpha
    d[72] = this.measurePlaneEnabled ? 1 : 0;
    d[73] = this.measurePlaneDepth;
    d[74] = this.measurePlaneGray;
    d[75] = this.measurePlaneAlpha;
    // measureFwd: camera forward (world, unit)
    d[76] = this.measureForward[0];
    d[77] = this.measureForward[1];
    d[78] = this.measureForward[2];
    d[79] = 0;
    // brickMin: ROI brick world min, w = enable
    d[80] = this.brickMin[0];
    d[81] = this.brickMin[1];
    d[82] = this.brickMin[2];
    d[83] = this.brickEnabled ? 1 : 0;
    // brickMax: ROI brick world max, w = brickBlend fade weight
    d[84] = this.brickMax[0];
    d[85] = this.brickMax[1];
    d[86] = this.brickMax[2];
    d[87] = this.brickBlend;
    const occ = this.occupancy?.grid ?? [1, 1, 1];
    d[88] = occ[0]!;
    d[89] = occ[1]!;
    d[90] = occ[2]!;
    d[91] = 0;
    d[92] = this.vis.grid[0];
    d[93] = this.vis.grid[1];
    d[94] = this.vis.grid[2];
    d[95] = this.visEnabled ? 1 : 0;
    d[96] = this.internalWidth;
    d[97] = this.internalHeight;
    d[98] = TILE_SIZE;
    d[99] = 0;
    // worldToLight mat4 (Milestone 7.1) at floats 100..115, then shadowCtl at 116.
    for (let k = 0; k < 16; k++) d[100 + k] = this.worldToLight[k]!;
    d[116] = this.shadowMapEnabled && this.shadowMapBuilt ? 1 : 0;
    d[117] = this.reprojectFar; // shadowCtl.y → depth-centroid normalization (TAAU)
    d[118] = 0;
    d[119] = 0;
    // camRight: camera right axis (world, unit), w = tan(halfFovY) * aspect (horizontal half-extent)
    d[120] = this.camRight[0];
    d[121] = this.camRight[1];
    d[122] = this.camRight[2];
    d[123] = this.tanHalfFovY * this.camAspect;
    // camUp: camera up axis (world, unit), w = tan(halfFovY) (vertical half-extent)
    d[124] = this.camUp[0];
    d[125] = this.camUp[1];
    d[126] = this.camUp[2];
    d[127] = this.tanHalfFovY;
    this.frameUniform!.write(d);
  }

  public dispose(): void {
    this.frameUniform?.dispose();
    this.tfTex?.dispose();
    this.lightEnv?.dispose();
    this.occupancy?.dispose();
    this.vis.dispose();
    this.tiles.dispose();
    this.dummyOcc.dispose();
    this.dummyPrefix.dispose();
    this.dummyTiles.dispose();
    this.tPreintBuffer?.dispose();
    this.dummyPreint.dispose();
    this.shadowMap.dispose();
    this.frameUniform = undefined;
    this.tfTex = undefined;
    this.lightEnv = undefined;
    this.volumeTex = undefined;
    this.pipeline = undefined;
    this.bindGroup = undefined;
    this.occupancy = undefined;
  }

  private ensurePipeline(): void {
    if (!this.bindGroupLayout) {
      const visFrag = GPUShaderStage.FRAGMENT;
      const visVert = GPUShaderStage.VERTEX;
      this.bindGroupLayout = this.ctx.device.createBindGroupLayout({
        label: "volume-raymarch",
        entries: [
          { binding: 0, visibility: visVert | visFrag, buffer: { type: "uniform" } },
          { binding: 1, visibility: visFrag, texture: { sampleType: "float", viewDimension: "3d" } },
          { binding: 2, visibility: visFrag, sampler: { type: "filtering" } },
          { binding: 3, visibility: visFrag, texture: { sampleType: "float", viewDimension: "2d" } },
          { binding: 4, visibility: visFrag, sampler: { type: "filtering" } },
          { binding: 5, visibility: visFrag, buffer: { type: "read-only-storage" } },
          { binding: 6, visibility: visFrag, texture: { sampleType: "float", viewDimension: "3d" } },
          { binding: 7, visibility: visFrag, buffer: { type: "storage" } },
          { binding: 8, visibility: visVert | visFrag, buffer: { type: "read-only-storage" } },
          { binding: 9, visibility: visFrag, buffer: { type: "read-only-storage" } },
          { binding: 10, visibility: visVert | visFrag, buffer: { type: "read-only-storage" } },
          { binding: 11, visibility: visFrag, buffer: { type: "read-only-storage" } },
          { binding: 12, visibility: visFrag, texture: { sampleType: "float", viewDimension: "3d" } },
        ],
      });
      this.pipelineLayout = this.ctx.device.createPipelineLayout({
        bindGroupLayouts: [this.bindGroupLayout],
      });
    }
    if (!this.frameUniform) {
      this.frameUniform = new ManagedBuffer(
        this.ctx.device,
        GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        VOLUME_FRAME_UNIFORM_SIZE,
      );
    }
    if (!this.volumeSampler) {
      this.volumeSampler = this.ctx.device.createSampler({
        magFilter: "linear",
        minFilter: "linear",
        addressModeU: "clamp-to-edge",
        addressModeV: "clamp-to-edge",
        addressModeW: "clamp-to-edge",
      });
    }
    if (!this.tfSampler) {
      this.tfSampler = this.ctx.device.createSampler({
        magFilter: "linear",
        minFilter: "linear",
        addressModeU: "clamp-to-edge",
        addressModeV: "clamp-to-edge",
      });
    }
    if (!this.bgPipeline) {
      const bgLayout = this.ctx.device.createBindGroupLayout({
        label: "volume-bg",
        entries: [
          { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
        ],
      });
      const bgMod = this.cache.getModule("volume-background", VOLUME_BACKGROUND_WGSL);
      this.bgPipeline = this.cache.getRenderPipeline({
        label: "volume-background",
        layout: this.ctx.device.createPipelineLayout({ bindGroupLayouts: [bgLayout] }),
        vertex: { module: bgMod, entryPoint: "vs_main" },
        fragment: {
          module: bgMod,
          entryPoint: "fs_main",
          targets: [{ format: this.colorFormat }, { format: VOLUME_DEPTH_FORMAT }],
        },
        primitive: { topology: "triangle-list" },
      });
      this.bgBindGroup = this.ctx.device.createBindGroup({
        layout: bgLayout,
        entries: [{ binding: 0, resource: { buffer: this.frameUniform.gpu } }],
      });
    }
    if (this.pipeline) return;
    const spec = specializationFor(this.shaderConfig);
    const key = `volume-raymarch-${this.shaderConfig}`;
    const wgsl = volumeRaymarchWgsl(spec);
    const module = this.cache.getModule(key, wgsl);
    const blend = {
      color: {
        srcFactor: "src-alpha" as GPUBlendFactor,
        dstFactor: "one-minus-src-alpha" as GPUBlendFactor,
        operation: "add" as GPUBlendOperation,
      },
      alpha: {
        srcFactor: "one" as GPUBlendFactor,
        dstFactor: "one-minus-src-alpha" as GPUBlendFactor,
        operation: "add" as GPUBlendOperation,
      },
    };
    this.pipeline = this.cache.getRenderPipeline({
      label: key,
      layout: this.pipelineLayout!,
      vertex: { module, entryPoint: "vs_main" },
      fragment: {
        module,
        entryPoint: "fs_main",
        targets: [{ format: this.colorFormat, blend }, { format: VOLUME_DEPTH_FORMAT }],
      },
      primitive: { topology: "triangle-list" },
    });
    // Warm the other named configs asynchronously so a mid-session switch doesn't hitch.
    for (const name of ["fast", "quality"] as const) {
      if (name === this.shaderConfig) continue;
      const nSpec = specializationFor(name);
      const nKey = `volume-raymarch-${name}`;
      const nWgsl = volumeRaymarchWgsl(nSpec);
      const nMod = this.cache.getModule(nKey, nWgsl);
      void this.ctx.device.createRenderPipelineAsync({
        label: nKey,
        layout: this.pipelineLayout!,
        vertex: { module: nMod, entryPoint: "vs_main" },
        fragment: {
          module: nMod,
          entryPoint: "fs_main",
          targets: [{ format: this.colorFormat, blend }, { format: VOLUME_DEPTH_FORMAT }],
        },
        primitive: { topology: "triangle-list" },
      }).catch(() => {
        /* warm compile is best-effort */
      });
    }
  }

  private ensureBindGroup(): void {
    if (this.bindGroup) return;
    const spec = specializationFor(this.shaderConfig);
    const occBuf = spec.occupancy && this.occupancy ? this.occupancy.cellsGpu : this.dummyOcc.gpu;
    const prefixBuf =
      spec.occupancy && this.occupancy?.prefixGpu ? this.occupancy.prefixGpu : this.dummyPrefix.gpu;
    const tileBuf = spec.tiles ? this.tiles.compactedBuffer : this.dummyTiles.gpu;
    this.bindGroup = this.ctx.device.createBindGroup({
      label: "volume",
      layout: this.bindGroupLayout!,
      entries: [
        { binding: 0, resource: { buffer: this.frameUniform!.gpu } },
        { binding: 1, resource: this.volumeTex!.createView({ dimension: "3d" }) },
        { binding: 2, resource: this.volumeSampler! },
        { binding: 3, resource: this.tfTex!.createView({ dimension: "2d" }) },
        { binding: 4, resource: this.tfSampler! },
        { binding: 5, resource: { buffer: this.lightEnv!.gpu } },
        {
          binding: 6,
          resource: (this.brickTex ?? this.volumeTex!).createView({ dimension: "3d" }),
        },
        { binding: 7, resource: { buffer: this.vis.writeBuffer } },
        { binding: 8, resource: { buffer: occBuf } },
        { binding: 9, resource: { buffer: prefixBuf } },
        { binding: 10, resource: { buffer: tileBuf } },
        { binding: 11, resource: { buffer: (this.tPreintBuffer ?? this.dummyPreint).gpu } },
        { binding: 12, resource: this.shadowMap.texture.createView({ dimension: "3d" }) },
      ],
    });
  }
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
