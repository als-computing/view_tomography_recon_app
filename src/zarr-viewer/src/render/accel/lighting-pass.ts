/**
 * Milestone 6 (B3) step 5: half-resolution "heavy" lighting pass (shadow/AO/multi-scatter), evaluated
 * once per half-res pixel from the full-res G-buffer (`surfacePos`/`surfaceNormal`/`surfaceAlbedo`,
 * see `volume-raymarch.ts`'s `FragOut`) instead of once per full-res raymarch sample. Structured as a
 * fullscreen-triangle render pass, mirroring {@link "./taau".TemporalAccumulator}'s pattern exactly
 * (owned plain `GPUTexture` output, `graph.importTexture` + `graph.addPass` in `resolve()`).
 *
 * Debug-only for now (Step 5): callers read the returned `lightAdd` handle for a visual sanity check.
 * Step 6 will bilateral-upsample it back to full-res and composite it into the final image.
 *
 * @packageDocumentation
 */

import { PipelineCache } from "../resources/pipeline.js";
import type { RenderGraph, ResourceHandle } from "../graph/render-graph.js";
import { LIGHT_STRUCT_WGSL } from "../shaders/lights.js";
import { VOLUME_LIGHTING_SHARED_WGSL } from "../shaders/volume-lighting-shared.js";

/** Output format of the half-res `lightAdd` texture: rgb = diffuseSpec, a = ambient-occlusion term. */
export const LIGHT_ADD_FORMAT: GPUTextureFormat = "rgba16float";

const LIGHTING_PASS_WGSL = /* wgsl */ `
// Must byte-match volume-raymarch.ts's Frame struct - both bind the same uniform buffer.
struct Frame {
  invViewProj: mat4x4<f32>,
  eye: vec4<f32>,
  params: vec4<f32>,
  light: vec4<f32>,
  shade: vec4<f32>,
  boxHalf: vec4<f32>,
  quality: vec4<f32>,
  cropMin: vec4<f32>,
  cropMax: vec4<f32>,
  slices: vec4<f32>,
  liquid: vec4<f32>,
  composite: vec4<f32>,
  lightCtl0: vec4<f32>,
  lightCtl1: vec4<f32>,
  lightCtl2: vec4<f32>,
  measurePlane: vec4<f32>,
  measureFwd: vec4<f32>,
  brickMin: vec4<f32>,
  brickMax: vec4<f32>,
  accelOcc: vec4<f32>,
  visGrid: vec4<f32>,
  screen: vec4<f32>,
  worldToLight: mat4x4<f32>,
  shadowCtl: vec4<f32>,
  camRight: vec4<f32>,
  camUp: vec4<f32>,
};

${LIGHT_STRUCT_WGSL}

@group(0) @binding(0) var<uniform> frame: Frame;
@group(0) @binding(1) var volumeTex: texture_3d<f32>;
@group(0) @binding(2) var volumeSampler: sampler;
@group(0) @binding(3) var tfTex: texture_2d<f32>;
@group(0) @binding(4) var tfSampler: sampler;
@group(0) @binding(5) var<storage, read> lights: array<Light>;
@group(0) @binding(6) var brickTex: texture_3d<f32>;
@group(0) @binding(7) var shadowTex: texture_3d<f32>;
@group(0) @binding(8) var surfacePosTex: texture_2d<f32>;
@group(0) @binding(9) var surfaceNormalTex: texture_2d<f32>;
@group(0) @binding(10) var surfaceAlbedoTex: texture_2d<f32>;

// Multi-scatter octaves are a quality-only enhancement (Milestone 7.3); this pass doesn't yet know
// which shader config is active, so it's off here - a known limitation of the debug-only Step 5 pass.
const MS_OCTAVES: u32 = 0u;

fn ign(p: vec2<f32>) -> f32 {
  return fract(52.9829189 * fract(dot(p, vec2<f32>(0.06711056, 0.00583715))));
}

// Small helpers duplicated from volume-raymarch.ts (must match) - see that file's own precedent of
// tolerating small duplicated blocks (e.g. VOLUME_BACKGROUND_WGSL's Frame struct) rather than adding
// native-WGSL-import machinery that doesn't exist.
fn inCrop(uvw: vec3<f32>) -> bool {
  let mn = frame.cropMin.xyz;
  let mx = frame.cropMax.xyz;
  return all(uvw >= mn) && all(uvw <= mx);
}

fn sampleDensity(uvw: vec3<f32>) -> f32 {
  let coarse = textureSampleLevel(volumeTex, volumeSampler, uvw, 0.0).r;
  if (frame.brickMin.w < 0.5) { return coarse; }
  let halfExt = max(frame.boxHalf.xyz, vec3<f32>(1e-6));
  let p = uvw * (2.0 * halfExt) - halfExt;
  let bUvw = (p - frame.brickMin.xyz) / max(frame.brickMax.xyz - frame.brickMin.xyz, vec3<f32>(1e-6));
  if (any(bUvw < vec3<f32>(0.0)) || any(bUvw > vec3<f32>(1.0))) { return coarse; }
  let fine = textureSampleLevel(brickTex, volumeSampler, bUvw, 0.0).r;
  let e = min(min(min(bUvw.x, 1.0 - bUvw.x), min(bUvw.y, 1.0 - bUvw.y)), min(bUvw.z, 1.0 - bUvw.z));
  let w = clamp(frame.brickMax.w, 0.0, 1.0) * smoothstep(0.0, 0.06, e) * smoothstep(0.02, 0.08, coarse);
  return mix(coarse, max(coarse, fine), w);
}

fn sampleTf(density: f32) -> vec4<f32> {
  return textureSampleLevel(tfTex, tfSampler, vec2<f32>(density, 0.5), 0.0);
}

${VOLUME_LIGHTING_SHARED_WGSL}

struct VSOut { @builtin(position) clip: vec4<f32>, @location(0) uv: vec2<f32> }

@vertex
fn vs_main(@builtin(vertex_index) vi: u32) -> VSOut {
  var p = array<vec2<f32>, 3>(vec2<f32>(-1.0, -1.0), vec2<f32>(3.0, -1.0), vec2<f32>(-1.0, 3.0));
  var out: VSOut;
  out.clip = vec4<f32>(p[vi], 0.0, 1.0);
  out.uv = p[vi] * 0.5 + 0.5;
  return out;
}

@fragment
fn fs_main(in: VSOut) -> @location(0) vec4<f32> {
  // Matches taau.ts's BLEND_WGSL: the G-buffer targets were written by the volume pass's own fullscreen
  // triangle, whose uv convention needs this same flip before it addresses those targets correctly.
  let suv = vec2<f32>(in.uv.x, 1.0 - in.uv.y);
  let posS = textureSampleLevel(surfacePosTex, volumeSampler, suv, 0.0);
  if (posS.w < 1e-4) {
    return vec4<f32>(0.0, 0.0, 0.0, 0.0); // no volume hit at this pixel
  }
  let normS = textureSampleLevel(surfaceNormalTex, volumeSampler, suv, 0.0);
  let albS = textureSampleLevel(surfaceAlbedoTex, volumeSampler, suv, 0.0);
  let pWorld = posS.xyz;
  let n = normalize(normS.xyz);
  let density = normS.w;
  let base = albS.rgb;
  let viewDir = normalize(frame.eye.xyz - pWorld);
  let densityScale = frame.params.y;
  let numLights = i32(frame.lightCtl0.x);
  let specStrength = frame.lightCtl0.z;
  let shininess = mix(256.0, 8.0, clamp(frame.lightCtl0.w, 0.0, 1.0));
  let shadowOn = frame.lightCtl1.x > 0.5;
  let aoOn = frame.lightCtl2.x > 0.5;
  let seed = ign(in.clip.xy + vec2<f32>(frame.eye.w * 1.7, frame.eye.w * 0.37));
  let lightRes = evaluateLighting(
    base, n, viewDir, pWorld, density, densityScale, seed, true,
    numLights, specStrength, shininess, aoOn, shadowOn,
  );
  return vec4<f32>(lightRes.diffuseSpec, lightRes.ao);
}
`;

/** Gbuffer resource handles the caller reads from the just-recorded volume pass. */
export interface LightingPassGbuffer {
  surfacePos: ResourceHandle;
  surfaceNormal: ResourceHandle;
  surfaceAlbedo: ResourceHandle;
}

/** GPU resources this pass reads, all owned/written elsewhere (by `VolumeRenderer`) this frame. */
export interface LightingPassInputs {
  frameUniform: GPUBuffer;
  volumeTex: GPUTexture;
  volumeSampler: GPUSampler;
  tfTex: GPUTexture;
  tfSampler: GPUSampler;
  lightsBuffer: GPUBuffer;
  brickTex: GPUTexture;
  shadowTex: GPUTexture;
  surfacePos: ResourceHandle;
  surfaceNormal: ResourceHandle;
  surfaceAlbedo: ResourceHandle;
  /** Full-res dimensions; the pass itself renders at half this (min 1). */
  fullWidth: number;
  fullHeight: number;
}

/** Evaluates `evaluateLighting()` once per half-res pixel from the G-buffer. Debug-only (Step 5). */
export class LightingPass {
  #w = 0;
  #h = 0;
  #texture: GPUTexture | undefined;
  #pipeline: GPURenderPipeline | undefined;
  #layout: GPUBindGroupLayout | undefined;
  readonly #cache: PipelineCache;

  public constructor(private readonly device: GPUDevice) {
    this.#cache = new PipelineCache(device);
  }

  /** Half-res dimensions of the current `lightAdd` texture (0 before the first {@link resolve}). */
  public get width(): number {
    return this.#w;
  }

  public get height(): number {
    return this.#h;
  }

  /** Add the lighting pass to `graph` and return the handle to the half-res `lightAdd` result. */
  public resolve(graph: RenderGraph, inputs: LightingPassInputs): ResourceHandle {
    const hw = Math.max(1, Math.round(inputs.fullWidth / 2));
    const hh = Math.max(1, Math.round(inputs.fullHeight / 2));
    this.#ensureTexture(hw, hh);
    this.#ensurePipeline();

    const outH = graph.importTexture(this.#texture!, "light-add", LIGHT_ADD_FORMAT);
    const device = this.device;
    const pipeline = this.#pipeline!;
    const layout = this.#layout!;
    const { surfacePos, surfaceNormal, surfaceAlbedo } = inputs;
    graph.addPass({
      name: "lighting-pass",
      reads: [surfacePos, surfaceNormal, surfaceAlbedo],
      writes: [outH],
      execute(ctx): void {
        const bg = device.createBindGroup({
          layout,
          entries: [
            { binding: 0, resource: { buffer: inputs.frameUniform } },
            { binding: 1, resource: inputs.volumeTex.createView({ dimension: "3d" }) },
            { binding: 2, resource: inputs.volumeSampler },
            { binding: 3, resource: inputs.tfTex.createView() },
            { binding: 4, resource: inputs.tfSampler },
            { binding: 5, resource: { buffer: inputs.lightsBuffer } },
            { binding: 6, resource: inputs.brickTex.createView({ dimension: "3d" }) },
            { binding: 7, resource: inputs.shadowTex.createView({ dimension: "3d" }) },
            { binding: 8, resource: ctx.texture(surfacePos).createView() },
            { binding: 9, resource: ctx.texture(surfaceNormal).createView() },
            { binding: 10, resource: ctx.texture(surfaceAlbedo).createView() },
          ],
        });
        const pass = ctx.encoder.beginRenderPass({
          label: "lighting-pass",
          colorAttachments: [
            {
              view: ctx.texture(outH).createView(),
              clearValue: { r: 0, g: 0, b: 0, a: 0 },
              loadOp: "clear",
              storeOp: "store",
            },
          ],
        });
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, bg);
        pass.draw(3);
        pass.end();
      },
    });

    return outH;
  }

  public dispose(): void {
    this.#texture?.destroy();
    this.#texture = undefined;
  }

  #ensureTexture(w: number, h: number): void {
    if (this.#w === w && this.#h === h && this.#texture) return;
    this.#texture?.destroy();
    this.#texture = this.device.createTexture({
      label: "light-add",
      size: [w, h, 1],
      format: LIGHT_ADD_FORMAT,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    this.#w = w;
    this.#h = h;
  }

  #ensurePipeline(): void {
    if (this.#pipeline) return;
    this.#layout = this.device.createBindGroupLayout({
      label: "lighting-pass",
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float", viewDimension: "3d" } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float", viewDimension: "2d" } },
        { binding: 4, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } },
        { binding: 5, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "read-only-storage" } },
        { binding: 6, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float", viewDimension: "3d" } },
        { binding: 7, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float", viewDimension: "3d" } },
        { binding: 8, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float", viewDimension: "2d" } },
        { binding: 9, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float", viewDimension: "2d" } },
        { binding: 10, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float", viewDimension: "2d" } },
      ],
    });
    const mod = this.#cache.getModule("lighting-pass", LIGHTING_PASS_WGSL);
    this.#pipeline = this.#cache.getRenderPipeline({
      label: "lighting-pass",
      layout: this.device.createPipelineLayout({ bindGroupLayouts: [this.#layout] }),
      vertex: { module: mod, entryPoint: "vs_main" },
      fragment: { module: mod, entryPoint: "fs_main", targets: [{ format: LIGHT_ADD_FORMAT }] },
      primitive: { topology: "triangle-list" },
    });
  }
}
