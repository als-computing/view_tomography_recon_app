/**
 * Standalone OME-Zarr viewer entry — boots Demo 26 on `#canvas`.
 */

import { run } from "./ome-zarr-viewer.js";
import { resetDemoStage } from "./demo-session.js";

const stageEl = document.querySelector("#stage");
if (!(stageEl instanceof HTMLElement)) {
  throw new Error("zarr-viewer: expected #stage in index.html");
}
const stage: HTMLElement = stageEl;

let dispose: (() => void) | undefined;

async function boot(): Promise<void> {
  dispose?.();
  const canvas = resetDemoStage(stage);
  const handle = await run(canvas);
  dispose = () => handle.dispose();
}

boot().catch((err) => {
  console.error(err);
  const hud = document.createElement("div");
  hud.style.cssText =
    "position:fixed;inset:16px;color:#f88;font:14px system-ui;white-space:pre-wrap";
  hud.textContent = `Failed to start OME-Zarr viewer:\n${err instanceof Error ? err.message : String(err)}`;
  document.body.appendChild(hud);
});
