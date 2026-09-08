import { test, expect } from "@playwright/test";
import type { FixtureResult, SampleName } from "./harness.js";

declare global {
  interface Window {
    runFixture: (name: string) => Promise<FixtureResult>;
    runMultiBrickFixture: () => Promise<FixtureResult>;
  }
}

/** Max per-channel byte difference tolerated between two sample points that should render "the same"
 * (symmetric camera + symmetric density → should match, modulo minor perspective/dither noise). */
const SAME_TOLERANCE = 12;
/** Min per-channel byte difference required to call two sample points "visibly different" — a much
 * lower bar than SAME_TOLERANCE (which exists to absorb noise between two renders that SHOULD match).
 * Proving something changed only needs to rule out noise, not clear the same generous margin proving
 * two renders are near-identical needs. */
const CHANGED_TOLERANCE = 4;

async function run(page: import("@playwright/test").Page, fixture: string): Promise<FixtureResult> {
  await page.goto("/test/browser/harness.html");
  const result = await page.evaluate((name) => window.runFixture(name), fixture);
  if (!result.ok) throw new Error(`fixture "${fixture}" failed: ${result.error}`);
  return result;
}

function channelDiff(a: readonly number[], b: readonly number[]): number {
  return Math.max(...a.slice(0, 3).map((v, i) => Math.abs(v - b[i]!)));
}

function sample(result: FixtureResult, name: SampleName): readonly [number, number, number, number] {
  return result.samples![name];
}

test.describe("constant volume (sanity baseline)", () => {
  test("renders a spatially uniform image", async ({ page }) => {
    const result = await run(page, "constant");
    const center = sample(result, "center");
    // Uniform density has zero gradient everywhere, so directional (diffuse) shading contributes
    // nothing - only ambient (non-directional) light should show, which is the same regardless of
    // screen position. A real bug (asymmetric gradient computation, a flipped coordinate) would show
    // up here as one side being visibly brighter/darker than its mirror.
    for (const name of ["nearLeft", "nearRight", "nearTop", "nearBottom"] as const) {
      expect(channelDiff(center, sample(result, name)), `${name} vs center`).toBeLessThanOrEqual(
        SAME_TOLERANCE,
      );
    }
  });

  test("actually renders something (not just background)", async ({ page }) => {
    const result = await run(page, "constant");
    const center = sample(result, "center");
    const corner = sample(result, "corner"); // ray misses the box entirely - pure background
    // If the volume weren't rendering at all (a broken bind group, texture upload, etc.), center
    // would equal corner (background clear color both times) — this is the "did anything actually
    // happen" check `getMemoryStats` numbers alone can't give you.
    expect(channelDiff(center, corner)).toBeGreaterThan(SAME_TOLERANCE);
  });
});

test.describe("sphere (gradient/lighting symmetry)", () => {
  test("is mirror-symmetric left/right and top/bottom", async ({ page }) => {
    const result = await run(page, "sphere");
    // A sphere is symmetric under any axis mirror. A real gradient-direction bug (an unnormalized-by-
    // spacing step, a wrong-sign finite difference, a coordinate-convention slip) breaks this in a way
    // flat test data can't reveal - this is exactly the class of regression Phase 2b's gradient fix
    // was written against.
    expect(
      channelDiff(sample(result, "nearLeft"), sample(result, "nearRight")),
      "nearLeft vs nearRight",
    ).toBeLessThanOrEqual(SAME_TOLERANCE);
    expect(
      channelDiff(sample(result, "nearTop"), sample(result, "nearBottom")),
      "nearTop vs nearBottom",
    ).toBeLessThanOrEqual(SAME_TOLERANCE);
  });
});

test.describe("multi-brick residency (item 9 stage 9c)", () => {
  test("two simultaneously-resident brick slots each show their own fine data, and the region between them stays coarse", async ({
    page,
  }) => {
    await page.goto("/test/browser/harness.html");
    const result = await page.evaluate(() => window.runMultiBrickFixture());
    if (!result.ok) throw new Error(`multi-brick fixture failed: ${result.error}`);

    const withBricks = result.samples!;
    const withoutBricks = result.samplesNoBrick!;

    // Each brick slot's footprint (nearLeft/nearRight) visibly changes once its own atlas slot is
    // enabled - the multi-slot blend loop (resolveBrickSlot/brickSlotToAtlasUvw) is actually engaging,
    // not silently falling through to the coarse-only path for one or both slots.
    expect(
      channelDiff(withBricks.nearLeft, withoutBricks.nearLeft),
      "nearLeft (brick A slot) should change once its brick is enabled",
    ).toBeGreaterThan(CHANGED_TOLERANCE);
    expect(
      channelDiff(withBricks.nearRight, withoutBricks.nearRight),
      "nearRight (brick B slot) should change once its brick is enabled",
    ).toBeGreaterThan(CHANGED_TOLERANCE);

    // The two slots hold genuinely different density values (1.0 vs 0.25) - each must show its OWN
    // data, not the same atlas contents leaking into both slots (a real risk this stage's own
    // atlasOrigin-addressing rewrite could get wrong) and not one slot silently overwriting the other's
    // placement.
    expect(
      channelDiff(withBricks.nearLeft, withBricks.nearRight),
      "the two brick slots should render visibly different densities",
    ).toBeGreaterThan(CHANGED_TOLERANCE);

    // Outside both slots' world footprint, the picture must be untouched by the bricks entirely -
    // proves the atlas addressing doesn't leak fine detail (or garbage) beyond each slot's own placed
    // world box.
    expect(
      channelDiff(withBricks.center, withoutBricks.center),
      "center (outside both brick footprints) should be unaffected by either brick",
    ).toBeLessThanOrEqual(SAME_TOLERANCE);
  });
});
