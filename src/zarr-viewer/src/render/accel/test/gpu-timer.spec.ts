import { describe, it, expect, vi } from "vitest";
import { GpuTimer } from "../gpu-timer.js";

// GPUBufferUsage/GPUMapMode are browser/WebGPU globals (bit-flag constants) not present under
// Node/vitest - stub them so GpuTimer's constructor/afterSubmit can read them.
(globalThis as unknown as { GPUBufferUsage?: Record<string, number> }).GPUBufferUsage ??= {
  MAP_READ: 1,
  COPY_DST: 8,
  QUERY_RESOLVE: 512,
  COPY_SRC: 4,
};
(globalThis as unknown as { GPUMapMode?: Record<string, number> }).GPUMapMode ??= { READ: 1, WRITE: 2 };

/** A fake buffer whose "GPU-written" content is a plain ArrayBuffer we control directly - real
 * writeTimestamp/resolveQuerySet/copyBufferToBuffer are all no-ops here; the test injects the bytes
 * a real GPU would have produced directly into the read buffer before calling afterSubmit(). */
function fakeBuffer(byteLength: number) {
  const backing = new ArrayBuffer(byteLength);
  return {
    mapAsync: vi.fn(async () => {}),
    getMappedRange: vi.fn((offset = 0, size?: number) => backing.slice(offset, size === undefined ? undefined : offset + size)),
    unmap: vi.fn(),
    __backing: backing,
  };
}

function fakeDevice(opts: { supported?: boolean } = {}) {
  const supported = opts.supported ?? true;
  const readBuffers: ReturnType<typeof fakeBuffer>[] = [];
  const resolveQuerySet = vi.fn();
  const copyBufferToBuffer = vi.fn();
  const device = {
    features: { has: (name: string) => supported && name === "timestamp-query" },
    createQuerySet: vi.fn(() => ({})),
    createBuffer: vi.fn((desc: { size: number; usage: number; label?: string }) => {
      const buf = fakeBuffer(desc.size);
      if (desc.label?.startsWith("gpu-timer-read-")) readBuffers.push(buf);
      return buf;
    }),
    queue: {},
  } as unknown as GPUDevice;
  const encoder = { resolveQuerySet, copyBufferToBuffer } as unknown as GPUCommandEncoder;
  return { device, encoder, readBuffers, resolveQuerySet, copyBufferToBuffer };
}

describe("GpuTimer", () => {
  it("is disabled when the device lacks timestamp-query, and every method becomes a safe no-op", () => {
    const { device, encoder } = fakeDevice({ supported: false });
    const timer = new GpuTimer(device);
    expect(timer.enabled).toBe(false);
    timer.beginFrame();
    expect(timer.timestampWrites("volume")).toBeUndefined();
    expect(() => timer.resolve(encoder)).not.toThrow();
    expect(() => timer.afterSubmit()).not.toThrow();
    expect(timer.lastTotalMs).toBeUndefined();
  });

  it("allocates increasing query-pair slots per pass, in call order", () => {
    const { device } = fakeDevice();
    const timer = new GpuTimer(device, 8);
    timer.beginFrame();
    expect(timer.timestampWrites("volume")).toEqual({
      querySet: expect.anything(),
      beginningOfPassWriteIndex: 0,
      endOfPassWriteIndex: 1,
    });
    expect(timer.timestampWrites("lighting-composite")).toEqual({
      querySet: expect.anything(),
      beginningOfPassWriteIndex: 2,
      endOfPassWriteIndex: 3,
    });
  });

  it("returns undefined (doesn't throw) once a frame's maxPasses budget is exhausted", () => {
    const { device } = fakeDevice();
    const timer = new GpuTimer(device, 2);
    timer.beginFrame();
    expect(timer.timestampWrites("a")).toBeDefined();
    expect(timer.timestampWrites("b")).toBeDefined();
    expect(timer.timestampWrites("c")).toBeUndefined();
  });

  it("resets the slot count on beginFrame (a new frame reuses slots from zero)", () => {
    const { device } = fakeDevice();
    const timer = new GpuTimer(device, 4);
    timer.beginFrame();
    timer.timestampWrites("volume");
    timer.beginFrame();
    expect(timer.timestampWrites("volume")).toEqual({
      querySet: expect.anything(),
      beginningOfPassWriteIndex: 0,
      endOfPassWriteIndex: 1,
    });
  });

  it("resolve() is a no-op when no pass called timestampWrites this frame (nothing to resolve)", () => {
    const { device, encoder, resolveQuerySet } = fakeDevice();
    const timer = new GpuTimer(device, 4);
    timer.beginFrame();
    timer.resolve(encoder);
    expect(resolveQuerySet).not.toHaveBeenCalled();
  });

  it("resolve() copies exactly this frame's pass count (not the full maxPasses budget)", () => {
    const { device, encoder, resolveQuerySet, copyBufferToBuffer } = fakeDevice();
    const timer = new GpuTimer(device, 8);
    timer.beginFrame();
    timer.timestampWrites("volume");
    timer.timestampWrites("taau");
    timer.resolve(encoder);
    expect(resolveQuerySet).toHaveBeenCalledWith(expect.anything(), 0, 4, expect.anything(), 0);
    expect(copyBufferToBuffer).toHaveBeenCalledWith(expect.anything(), 0, expect.anything(), 0, 4 * 8);
  });

  it("computes per-pass ms and lastTotalMs from the resolved timestamp bytes end-to-end", async () => {
    const { device, encoder, readBuffers } = fakeDevice();
    const timer = new GpuTimer(device, 8);
    timer.beginFrame();
    timer.timestampWrites("volume");
    timer.timestampWrites("lighting-composite");
    timer.resolve(encoder);

    // Simulate the GPU having written 2 timestamp pairs (ns, period=1): volume takes 2ms, composite 0.5ms.
    const view = new BigUint64Array(readBuffers[0]!.__backing);
    view[0] = 0n; // volume begin
    view[1] = 2_000_000n; // volume end (+2ms in ns)
    view[2] = 5_000_000n; // composite begin
    view[3] = 5_500_000n; // composite end (+0.5ms in ns)

    timer.afterSubmit();
    await Promise.resolve(); // flush the mapAsync().then() microtask
    await Promise.resolve();

    expect(timer.lastSamples).toEqual([
      { label: "volume", ms: 2 },
      { label: "lighting-composite", ms: 0.5 },
    ]);
    expect(timer.lastTotalMs).toBeCloseTo(2.5);
  });
});
