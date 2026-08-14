/**
 * A reusable full-screen post-processing pass: a single oversized-triangle draw that samples one
 * input texture and writes one output attachment, with an optional small uniform block. Effects
 * supply only their fragment body; this helper owns the vertex stage, bindings, sampler, pipeline
 * caching (keyed by output format), and uniform upload.
 *
 * GPU execution is validated in the browser playground, not in the headless test suite; the pure
 * operators it composes ({@link "./tonemap-ops"}) and the graph wiring ({@link "./stack".PostStack})
 * are unit-tested independently.
 *
 * @packageDocumentation
 */

/** Configuration for a {@link FullscreenPass}. */
export interface FullscreenPassConfig {
  /** Debug label. */
  label: string;
  /** WGSL fragment body: a block ending in `return <vec4f>;`, with `uv`, `tex`, `samp`, `params` in scope. */
  fragment: string;
  /** WGSL fields of the `Params` uniform struct (without the `struct` keyword), if any. */
  paramsStruct?: string;
  /** Extra WGSL (helper functions) injected before the entry points. */
  extra?: string;
  /** Byte size of the uniform block (rounded up to 16). Default 16. */
  uniformBytes?: number;
  /** Sampler filtering. Default "linear". */
  filter?: GPUFilterMode;
}

const VERTEX_WGSL = /* wgsl */ `
struct VOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f };
@vertex fn vs(@builtin(vertex_index) vid: u32) -> VOut {
  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  var out: VOut;
  out.pos = vec4f(p[vid], 0.0, 1.0);
  out.uv = vec2f(0.5 * p[vid].x + 0.5, 0.5 - 0.5 * p[vid].y); // WebGPU top-left texel origin
  return out;
}`;

/** Owns the pipeline/sampler/uniform resources for one full-screen effect. */
export class FullscreenPass {
  readonly #device: GPUDevice;
  readonly #module: GPUShaderModule;
  readonly #sampler: GPUSampler;
  readonly #uniform: GPUBuffer;
  readonly #uniformBytes: number;
  readonly #pipelines = new Map<GPUTextureFormat, GPURenderPipeline>();

  public constructor(device: GPUDevice, config: FullscreenPassConfig) {
    this.#device = device;
    this.#uniformBytes = Math.max(16, Math.ceil((config.uniformBytes ?? 16) / 16) * 16);
    const code = `${VERTEX_WGSL}
struct Params { ${config.paramsStruct ?? "_pad: vec4f,"} }
@group(0) @binding(0) var samp: sampler;
@group(0) @binding(1) var tex: texture_2d<f32>;
@group(0) @binding(2) var<uniform> params: Params;
${config.extra ?? ""}
@fragment fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
${config.fragment}
}`;
    this.#module = device.createShaderModule({ label: config.label, code });
    this.#sampler = device.createSampler({
      magFilter: config.filter ?? "linear",
      minFilter: config.filter ?? "linear",
    });
    this.#uniform = device.createBuffer({
      size: this.#uniformBytes,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
  }

  #pipeline(format: GPUTextureFormat): GPURenderPipeline {
    let p = this.#pipelines.get(format);
    if (!p) {
      p = this.#device.createRenderPipeline({
        layout: "auto",
        vertex: { module: this.#module, entryPoint: "vs" },
        fragment: { module: this.#module, entryPoint: "fs", targets: [{ format }] },
        primitive: { topology: "triangle-list" },
      });
      this.#pipelines.set(format, p);
    }
    return p;
  }

  /** Upload uniform bytes for the next {@link run}. */
  public setParams(data: Float32Array | Uint32Array): void {
    this.#device.queue.writeBuffer(this.#uniform, 0, data.buffer, data.byteOffset, data.byteLength);
  }

  /** Record the pass: sample `inputView`, write `outputView` (of the given `format`). */
  public run(
    encoder: GPUCommandEncoder,
    inputView: GPUTextureView,
    outputView: GPUTextureView,
    format: GPUTextureFormat,
  ): void {
    this.runWithExtra(encoder, inputView, outputView, format, []);
  }

  /**
   * Like {@link run}, but binds additional bind-group entries (e.g. a second input texture at
   * binding 3, declared in the effect's `extra` WGSL).
   */
  public runWithExtra(
    encoder: GPUCommandEncoder,
    inputView: GPUTextureView,
    outputView: GPUTextureView,
    format: GPUTextureFormat,
    extra: readonly GPUBindGroupEntry[],
  ): void {
    const pipeline = this.#pipeline(format);
    const bindGroup = this.#device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: this.#sampler },
        { binding: 1, resource: inputView },
        { binding: 2, resource: { buffer: this.#uniform } },
        ...extra,
      ],
    });
    const pass = encoder.beginRenderPass({
      colorAttachments: [{ view: outputView, loadOp: "clear", storeOp: "store", clearValue: { r: 0, g: 0, b: 0, a: 1 } }],
    });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.draw(3);
    pass.end();
  }

  /** Release GPU resources. */
  public dispose(): void {
    this.#uniform.destroy();
  }
}
