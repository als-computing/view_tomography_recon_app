/**
 * A render graph (frame graph): declare passes and the transient resources they read/write; the
 * graph derives the correct execution order, culls passes whose outputs are never consumed, and
 * aliases memory between transient resources whose lifetimes do not overlap. This is the backbone of
 * Prism's multi-pass rendering (shadow → gbuffer → forward → volume → post).
 *
 * Compilation ({@link RenderGraph.compile}) is pure data-structure work — dependency analysis,
 * topological sort, lifetime computation, and slot assignment — and is independent of any
 * `GPUDevice`, so it is fully unit-testable. {@link RenderGraph.execute} then realizes the compiled
 * plan on the device: it pools one physical texture per memory slot, runs each live pass's callback
 * in order, and submits the frame. WebGPU inserts memory hazards between passes automatically, so the
 * graph's job is correct ordering and non-overlapping aliasing.
 *
 * @packageDocumentation
 */

import { PrismError } from "@zarr-viewer/core";

/** A handle to a transient or imported graph resource. */
export type ResourceHandle = number & { readonly __brand: "ResourceHandle" };

/** Description of a transient texture the graph allocates. */
export interface RenderGraphTextureDesc {
  size: readonly [number, number, number];
  format: GPUTextureFormat;
  usage: GPUTextureUsageFlags;
  dimension?: GPUTextureDimension;
  sampleCount?: number;
  mipLevelCount?: number;
}

/** Context passed to a pass's execute callback. */
export interface PassContext {
  readonly encoder: GPUCommandEncoder;
  /** Resolve a resource handle to its concrete GPU texture. */
  texture(handle: ResourceHandle): GPUTexture;
  /** The texture format of a resource (from its desc, or the hint given to {@link RenderGraph.importTexture}). */
  format(handle: ResourceHandle): GPUTextureFormat;
}

/** A single render/compute pass declaration. */
export interface PassDesc {
  name: string;
  reads?: readonly ResourceHandle[];
  writes?: readonly ResourceHandle[];
  execute(ctx: PassContext): void;
}

/** Half-open lifetime `[first, last]` of a resource in compiled-execution-order positions. */
export interface ResourceLifetime {
  /** Position (in the live execution order) of the first access, or `-1` if unused. */
  first: number;
  /** Position of the last access, or `-1` if unused. */
  last: number;
}

/** The result of {@link RenderGraph.compile} — a pure plan with no GPU objects. */
export interface CompiledGraph {
  /** Indices of the passes to execute, in dependency-correct order (culled passes removed). */
  order: number[];
  /** Per-pass liveness after dead-pass culling (indexed by original pass index). */
  live: boolean[];
  /** Physical memory slots; each hosts one or more non-overlapping transient resources. */
  slots: RenderGraphTextureDesc[];
  /** Resource handle → slot index, or `-1` for imported resources (not graph-allocated). */
  resourceSlot: number[];
  /** Per-resource lifetime in `order`-space. */
  lifetimes: ResourceLifetime[];
}

interface ResourceRecord {
  desc: RenderGraphTextureDesc | undefined;
  imported: boolean;
  importedTexture?: GPUTexture;
  formatHint?: GPUTextureFormat;
  output: boolean;
  name: string;
}

/**
 * The render graph builder + executor.
 *
 * @example
 * ```ts
 * const graph = new RenderGraph(device);
 * const hdr = graph.createTexture({ size: [w, h, 1], format: "rgba16float", usage: RENDER_ATTACHMENT });
 * const ldr = graph.importTexture(swapchainTexture);
 * graph.addPass({ name: "forward", writes: [hdr], execute: (ctx) => {  } });
 * graph.addPass({ name: "tonemap", reads: [hdr], writes: [ldr], execute: (ctx) => {  } });
 * graph.execute();
 * ```
 */
export class RenderGraph {
  readonly #resources: ResourceRecord[] = [];
  readonly #passes: PassDesc[] = [];
  /** Pool of reusable physical textures keyed by descriptor signature. */
  readonly #pool = new Map<string, GPUTexture[]>();

  public constructor(public readonly device: GPUDevice) {}

  /** Declare a transient texture resource (allocated lazily at {@link execute} time). */
  public createTexture(desc: RenderGraphTextureDesc): ResourceHandle {
    const handle = this.#resources.length as ResourceHandle;
    this.#resources.push({ desc, imported: false, output: false, name: `texture#${handle}` });
    return handle;
  }

  /**
   * Import an externally-owned texture (e.g. the swapchain) as a graph resource. Imported resources
   * are never aliased and act as culling roots (the passes that produce them are always kept).
   */
  public importTexture(
    texture: GPUTexture,
    name = "imported",
    format?: GPUTextureFormat,
  ): ResourceHandle {
    const handle = this.#resources.length as ResourceHandle;
    this.#resources.push({
      desc: undefined,
      imported: true,
      importedTexture: texture,
      formatHint: format,
      output: true,
      name,
    });
    return handle;
  }

  /** Mark a transient resource as a graph output so its producers survive culling. */
  public markOutput(handle: ResourceHandle): this {
    const r = this.#resources[handle];
    if (r) r.output = true;
    return this;
  }

  /** Register a pass. */
  public addPass(pass: PassDesc): void {
    this.#passes.push(pass);
  }

  /**
   * Clear all declared resources and passes while keeping the pooled physical textures, so a demo
   * can rebuild the graph every frame (import the fresh swapchain, re-declare transients, re-add
   * passes) without reallocating GPU memory. Call at the start of each frame before rebuilding.
   */
  public reset(): this {
    this.#resources.length = 0;
    this.#passes.length = 0;
    return this;
  }

  /**
   * Compile the graph into an execution plan: dependency ordering, dead-pass culling, resource
   * lifetimes, and memory-slot aliasing. Pure — touches no GPU state.
   *
   * @throws {PrismError} if the pass dependency graph contains a cycle.
   */
  public compile(): CompiledGraph {
    const passes = this.#passes;
    const n = passes.length;
    const resources = this.#resources;

    // --- Build the dependency DAG from resource read/write hazards, in insertion order. ---
    const edges: Set<number>[] = Array.from({ length: n }, () => new Set<number>());
    const inDegree = new Array<number>(n).fill(0);
    const addEdge = (from: number, to: number): void => {
      if (from === to || edges[from]!.has(to)) return;
      edges[from]!.add(to);
      inDegree[to]!++;
    };

    // Single-assignment frame-graph hazard model: a resource's readers depend on all of its
    // producers (RAW, order-independent so consumers can be declared before producers), and multiple
    // producers of the same resource are chained in insertion order (WAW). `touchedBy` records every
    // access for lifetime analysis below.
    const touchedBy: Map<number, number[]> = new Map();
    const writersOf: Map<number, number[]> = new Map();
    const readersOf: Map<number, number[]> = new Map();
    for (let p = 0; p < n; p++) {
      for (const h of passes[p]!.reads ?? []) {
        push(touchedBy, h, p);
        push(readersOf, h, p);
      }
      for (const h of passes[p]!.writes ?? []) {
        push(touchedBy, h, p);
        push(writersOf, h, p);
      }
    }
    for (let h = 0; h < resources.length; h++) {
      const writers = writersOf.get(h) ?? [];
      const readers = readersOf.get(h) ?? [];
      for (let i = 1; i < writers.length; i++) addEdge(writers[i - 1]!, writers[i]!); // WAW
      for (const r of readers) for (const w of writers) addEdge(w, r); // RAW
    }

    // --- Dead-pass culling: keep passes that produce an output resource, transitively. ---
    const hasRoots = resources.some((r) => r.imported || r.output);
    const live = new Array<boolean>(n).fill(!hasRoots);
    if (hasRoots) {
      const producers: Map<number, number[]> = new Map();
      for (let p = 0; p < n; p++) for (const h of passes[p]!.writes ?? []) push(producers, h, p);
      const stack: number[] = [];
      for (let p = 0; p < n; p++) {
        if ((passes[p]!.writes ?? []).some((h) => resources[h]?.imported || resources[h]?.output)) {
          if (!live[p]) {
            live[p] = true;
            stack.push(p);
          }
        }
      }
      while (stack.length > 0) {
        const p = stack.pop()!;
        for (const h of passes[p]!.reads ?? []) {
          for (const q of producers.get(h) ?? []) {
            if (!live[q]) {
              live[q] = true;
              stack.push(q);
            }
          }
        }
      }
    }

    // --- Kahn topological sort over live passes, insertion order as a stable tiebreak. ---
    const order: number[] = [];
    const deg = inDegree.slice();
    // Ready = live passes with no remaining live predecessors.
    const ready: number[] = [];
    for (let p = 0; p < n; p++) if (live[p] && deg[p] === 0) ready.push(p);
    const liveCount = live.filter(Boolean).length;
    while (ready.length > 0) {
      ready.sort((a, b) => a - b); // deterministic, insertion-ordered
      const p = ready.shift()!;
      order.push(p);
      for (const q of edges[p]!) {
        if (!live[q]) continue;
        deg[q] = deg[q]! - 1;
        if (deg[q] === 0) ready.push(q);
      }
    }
    if (order.length !== liveCount) {
      throw new PrismError("invalid_argument", "RenderGraph.compile: pass dependency cycle detected");
    }

    // --- Resource lifetimes in execution-order space. ---
    const position = new Array<number>(n).fill(-1);
    order.forEach((p, i) => (position[p] = i));
    const lifetimes: ResourceLifetime[] = resources.map(() => ({ first: -1, last: -1 }));
    for (const [h, ps] of touchedBy) {
      for (const p of ps) {
        const pos = position[p]!;
        if (pos < 0) continue; // pass was culled
        const lt = lifetimes[h]!;
        if (lt.first === -1 || pos < lt.first) lt.first = pos;
        if (pos > lt.last) lt.last = pos;
      }
    }

    // --- Greedy memory aliasing: reuse a slot once its resident resource's lifetime has ended. ---
    const slots: RenderGraphTextureDesc[] = [];
    const slotFreeAt: number[] = []; // slot becomes reusable at this order position
    const resourceSlot = new Array<number>(resources.length).fill(-1);
    const order2: number[] = [];
    for (let h = 0; h < resources.length; h++) {
      const r = resources[h]!;
      if (r.imported || !r.desc) continue; // imported: not graph-allocated
      if (lifetimes[h]!.first === -1) continue; // unused
      order2.push(h);
    }
    order2.sort((a, b) => lifetimes[a]!.first - lifetimes[b]!.first);
    for (const h of order2) {
      const desc = resources[h]!.desc!;
      const lt = lifetimes[h]!;
      const sig = descSignature(desc);
      let chosen = -1;
      for (let s = 0; s < slots.length; s++) {
        if (descSignature(slots[s]!) === sig && slotFreeAt[s]! <= lt.first) {
          chosen = s;
          break;
        }
      }
      if (chosen === -1) {
        chosen = slots.length;
        slots.push(desc);
        slotFreeAt.push(0);
      }
      slotFreeAt[chosen] = lt.last + 1;
      resourceSlot[h] = chosen;
    }

    return { order, live, slots, resourceSlot, lifetimes };
  }

  /**
   * Compile and run the graph on the device, then submit the frame. `beforeSubmit`, when given, runs
   * with the frame's encoder after every pass has recorded its commands but before `queue.submit` —
   * for work that must see the whole frame's recorded commands first (e.g. resolving a `GpuTimer`'s
   * query set, which needs every pass's `timestampWrites` to have already been recorded).
   */
  public execute(beforeSubmit?: (encoder: GPUCommandEncoder) => void): void {
    const compiled = this.compile();
    const acquired: { key: string; texture: GPUTexture }[] = [];
    const slotTextures = compiled.slots.map((desc) => {
      const key = descSignature(desc);
      const texture = this.#acquire(desc, key);
      acquired.push({ key, texture });
      return texture;
    });

    const encoder = this.device.createCommandEncoder();
    const ctx: PassContext = {
      encoder,
      texture: (handle: ResourceHandle): GPUTexture => {
        const r = this.#resources[handle];
        if (!r) throw new PrismError("invalid_argument", `unknown resource handle ${handle}`);
        if (r.imported) return r.importedTexture!;
        const slot = compiled.resourceSlot[handle]!;
        if (slot < 0) throw new PrismError("invalid_argument", `resource ${handle} was culled`);
        return slotTextures[slot]!;
      },
      format: (handle: ResourceHandle): GPUTextureFormat => {
        const r = this.#resources[handle];
        if (!r) throw new PrismError("invalid_argument", `unknown resource handle ${handle}`);
        const fmt = r.desc?.format ?? r.formatHint;
        if (!fmt) throw new PrismError("invalid_argument", `no format for imported resource ${handle}`);
        return fmt;
      },
    };

    for (const p of compiled.order) this.#passes[p]!.execute(ctx);
    beforeSubmit?.(encoder);
    this.device.queue.submit([encoder.finish()]);

    for (const { key, texture } of acquired) this.#release(key, texture);
  }

  /** Destroy all pooled textures. */
  public dispose(): void {
    for (const list of this.#pool.values()) for (const t of list) t.destroy();
    this.#pool.clear();
  }

  #acquire(desc: RenderGraphTextureDesc, key: string): GPUTexture {
    const free = this.#pool.get(key);
    const reused = free?.pop();
    if (reused) return reused;
    return this.device.createTexture({
      size: { width: desc.size[0], height: desc.size[1], depthOrArrayLayers: desc.size[2] },
      format: desc.format,
      usage: desc.usage,
      dimension: desc.dimension ?? "2d",
      sampleCount: desc.sampleCount ?? 1,
      mipLevelCount: desc.mipLevelCount ?? 1,
    });
  }

  #release(key: string, texture: GPUTexture): void {
    let list = this.#pool.get(key);
    if (!list) {
      list = [];
      this.#pool.set(key, list);
    }
    list.push(texture);
  }
}

function push(map: Map<number, number[]>, key: number, value: number): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

function descSignature(d: RenderGraphTextureDesc): string {
  return `${d.size[0]}x${d.size[1]}x${d.size[2]}:${d.format}:${d.usage}:${d.dimension ?? "2d"}:${d.sampleCount ?? 1}:${d.mipLevelCount ?? 1}`;
}
