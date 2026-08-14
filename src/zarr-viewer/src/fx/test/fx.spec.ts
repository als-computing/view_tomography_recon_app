/**
 * Post-processing: tone-map operators (pure, validated against known values) and PostStack graph
 * wiring (device-free — the effects' addPass only builds graph nodes, and RenderGraph.compile needs
 * no GPU). The GPU fragment passes themselves are validated in the browser playground.
 */
import { describe, it, expect } from "vitest";
import { RenderGraph, type ResourceHandle } from "@prism/render";
import {
  PostStack,
  tonemap,
  fxaa,
  bloom,
  acesFilmic,
  reinhard,
  reinhardExtended,
  applyExposure,
  luminance,
  linearToSrgb,
  srgbToLinear,
  type Effect,
} from "@prism/fx";

const nullDevice = null as unknown as GPUDevice;
const RT_TB = 0x10 | 0x04;
const target = { size: [128, 128, 1] as const, format: "rgba16float" as GPUTextureFormat };

describe("tone-map operators", () => {
  it("ACES is bounded, monotonic, and matches the fitted mid value", () => {
    expect(acesFilmic(0)).toBe(0);
    expect(acesFilmic(1)).toBeCloseTo(0.8038, 3); // Narkowicz curve at x=1
    expect(acesFilmic(1000)).toBeLessThanOrEqual(1); // never exceeds display range
    expect(acesFilmic(2)).toBeGreaterThan(acesFilmic(1)); // monotonic increasing
  });

  it("Reinhard variants compress highlights", () => {
    expect(reinhard(0)).toBe(0);
    expect(reinhard(1)).toBeCloseTo(0.5, 12);
    expect(reinhard(1e6)).toBeLessThan(1);
    // Extended Reinhard maps the white point exactly to 1.
    expect(reinhardExtended(4, 4)).toBeCloseTo(1, 12);
  });

  it("exposure and luminance behave", () => {
    expect(applyExposure(1, 1)).toBeCloseTo(2, 12); // +1 stop doubles
    expect(applyExposure(1, -1)).toBeCloseTo(0.5, 12);
    expect(luminance(1, 1, 1)).toBeCloseTo(1, 12);
    expect(luminance(0, 1, 0)).toBeCloseTo(0.7152, 6);
  });

  it("sRGB encode/decode round-trips", () => {
    for (const v of [0, 0.04, 0.2, 0.5, 0.9, 1]) {
      expect(srgbToLinear(linearToSrgb(v))).toBeCloseTo(v, 6);
    }
    expect(linearToSrgb(0)).toBe(0);
    expect(linearToSrgb(1)).toBe(1);
  });
});

describe("PostStack wiring", () => {
  /** A recording mock effect (no GPU work) to inspect chaining. */
  function recorder(name: string, log: { input: ResourceHandle; output: ResourceHandle }[]): Effect {
    return {
      name,
      addPass(_g, input, output) {
        log.push({ input, output });
      },
    };
  }

  it("returns the input unchanged for an empty stack", () => {
    const g = new RenderGraph(nullDevice);
    const hdr = g.createTexture({ size: target.size, format: target.format, usage: RT_TB });
    expect(new PostStack([]).build(g, hdr, target)).toBe(hdr);
  });

  it("chains effects, feeding each output into the next input", () => {
    const g = new RenderGraph(nullDevice);
    const hdr = g.createTexture({ size: target.size, format: target.format, usage: RT_TB });
    const swap = g.importTexture({} as GPUTexture, "swap", "bgra8unorm");
    const log: { input: ResourceHandle; output: ResourceHandle }[] = [];
    const stack = new PostStack([recorder("a", log), recorder("b", log), recorder("c", log)]);
    const final = stack.build(g, hdr, { ...target, output: swap });

    expect(log).toHaveLength(3);
    expect(log[0]!.input).toBe(hdr); // first reads the HDR input
    expect(log[1]!.input).toBe(log[0]!.output); // ping-pong
    expect(log[2]!.input).toBe(log[1]!.output);
    expect(log[2]!.output).toBe(swap); // last writes the provided output
    expect(final).toBe(swap);
  });

  it("allocates a transient final target when no output is provided", () => {
    const g = new RenderGraph(nullDevice);
    const hdr = g.createTexture({ size: target.size, format: target.format, usage: RT_TB });
    const log: { input: ResourceHandle; output: ResourceHandle }[] = [];
    const final = new PostStack([recorder("only", log)]).build(g, hdr, target);
    expect(final).not.toBe(hdr);
    expect(final).toBe(log[0]!.output);
  });
});

describe("PostStack integration with real effects (device-free compile)", () => {
  it("bloom + fxaa + tonemap builds a graph that compiles to a valid order", () => {
    const g = new RenderGraph(nullDevice);
    const hdr = g.createTexture({ size: target.size, format: target.format, usage: RT_TB });
    const swap = g.importTexture({} as GPUTexture, "swap", "bgra8unorm");
    const stack = new PostStack([bloom({ threshold: 1 }), fxaa(), tonemap("aces")]);
    stack.build(g, hdr, { ...target, output: swap });

    // Passes are added in a deterministic order: bloom.extract(0), blur(1), blur(2),
    // composite(3), fxaa(4), tonemap(5). compile() must preserve their data dependencies.
    const compiled = g.compile();
    const pos = (i: number): number => compiled.order.indexOf(i);
    expect(compiled.order).toHaveLength(6);
    expect(pos(0)).toBeLessThan(pos(1)); // extract before horizontal blur
    expect(pos(1)).toBeLessThan(pos(2)); // horizontal before vertical blur
    expect(pos(2)).toBeLessThan(pos(3)); // blur before composite
    expect(pos(3)).toBeLessThan(pos(4)); // bloom before fxaa
    expect(pos(4)).toBeLessThan(pos(5)); // fxaa before tonemap
    expect(compiled.live.every(Boolean)).toBe(true); // all feed the presented image
  });
});
