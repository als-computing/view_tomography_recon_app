import { describe, it, expect, afterEach, vi } from "vitest";

describe("useTabsStore — locked-build guard", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("setServerId is a no-op once FIXED_SERVER_ID is set", async () => {
    vi.stubEnv("VITE_FIXED_TILED_SERVER", "production");
    const { useTabsStore } = await import("../stores/useTabsStore");
    const before = useTabsStore.getState().serverId;
    useTabsStore.getState().setServerId("staging");
    expect(useTabsStore.getState().serverId).toBe(before);
  });
});
