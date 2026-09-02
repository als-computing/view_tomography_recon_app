import { defineConfig } from "@playwright/test";

/**
 * WebGPU browser-test harness (renderer-hardening plan's Phase 3). Runs `test/browser/*.spec.ts`
 * against `test/browser/harness.html`, served by the same Vite dev server the app itself uses.
 *
 * WebGPU-in-headless-Chromium needed real trial and error to get working (confirmed by hand on
 * macOS/Metal, this session):
 * - `navigator.gpu` is entirely absent under Playwright's *default* headless launch args — its
 *   default `--headless` (legacy) plus `--enable-unsafe-swiftshader` block WebGPU adapter creation
 *   even though the same binary works fine with `--headless=new` invoked directly. Both defaults are
 *   removed below (`ignoreDefaultArgs`) and replaced.
 * - `navigator.gpu` is also absent on Playwright's default blank starting page — every test must
 *   `page.goto(...)` a real page (this harness's `harness.html`) before touching `navigator.gpu`, or
 *   it won't exist yet even with every launch flag right.
 *
 * Not yet verified on Linux CI (no real GPU hardware there). `--enable-unsafe-swiftshader` is only
 * stripped on macOS below — there it forces a software path that conflicts with Dawn's native Metal
 * backend and breaks WebGPU entirely, but on Linux (no Metal alternative) SwiftShader's Vulkan
 * backend is very likely the *only* way headless WebGPU works at all without real GPU hardware, so
 * removing it there would probably have the opposite effect. This platform split is an informed
 * guess, not something confirmed by an actual CI run yet — revisit once `ci.yml`'s job actually
 * exercises this on Linux and see what it really needs.
 */
const isMac = process.platform === "darwin";

export default defineConfig({
  testDir: "./test/browser",
  timeout: 30_000,
  fullyParallel: false, // one shared dev server / GPU adapter at a time is plenty for a small fixture set
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "dot" : "list",
  use: {
    baseURL: "http://localhost:5181",
    launchOptions: {
      ignoreDefaultArgs: isMac ? ["--headless", "--enable-unsafe-swiftshader"] : ["--headless"],
      args: [
        "--headless=new",
        "--enable-unsafe-webgpu",
        "--enable-features=Vulkan",
        "--disable-gpu-sandbox",
        "--no-sandbox",
      ],
    },
  },
  webServer: {
    command: "npm run dev -- --open=false",
    url: "http://localhost:5181",
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
