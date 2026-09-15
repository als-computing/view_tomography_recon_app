/**
 * Render/compute pipeline creation with caching, plus shader-module deduplication.
 *
 * Pipelines are cached by their `label` (a stable, caller-supplied key). Give each distinct pipeline
 * configuration a unique label so repeated `get*` calls reuse the compiled pipeline instead of
 * recompiling every frame. The forward {@link "../renderer".Renderer} keys pipelines by MSAA count
 * (e.g. `forward-lit-msaa4`) so sample-count changes do not collide in the cache.
 *
 * @packageDocumentation
 */

/** A cache that deduplicates pipelines and shader modules by a structural key. */
export class PipelineCache {
  private readonly renderPipelines = new Map<string, GPURenderPipeline>();
  private readonly computePipelines = new Map<string, GPUComputePipeline>();
  private readonly modules = new Map<string, GPUShaderModule>();

  public constructor(public readonly device: GPUDevice) {}

  /** Get (or compile and cache) a shader module for `code`, keyed by `key`. */
  public getModule(key: string, code: string): GPUShaderModule {
    let mod = this.modules.get(key);
    if (!mod) {
      mod = this.device.createShaderModule({ label: key, code });
      this.modules.set(key, mod);
    }
    return mod;
  }

  /**
   * Get (or create and cache) a render pipeline for the given descriptor. Caching is keyed by
   * `descriptor.label`; descriptors without a label are always created fresh.
   */
  public getRenderPipeline(descriptor: GPURenderPipelineDescriptor): GPURenderPipeline {
    const key = descriptor.label;
    if (!key) return this.device.createRenderPipeline(descriptor);
    let pipeline = this.renderPipelines.get(key);
    if (!pipeline) {
      pipeline = this.device.createRenderPipeline(descriptor);
      this.renderPipelines.set(key, pipeline);
    }
    return pipeline;
  }

  /** Get (or create and cache) a compute pipeline, keyed by `descriptor.label`. */
  public getComputePipeline(descriptor: GPUComputePipelineDescriptor): GPUComputePipeline {
    const key = descriptor.label;
    if (!key) return this.device.createComputePipeline(descriptor);
    let pipeline = this.computePipelines.get(key);
    if (!pipeline) {
      pipeline = this.device.createComputePipeline(descriptor);
      this.computePipelines.set(key, pipeline);
    }
    return pipeline;
  }
}
