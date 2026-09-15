import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  TILED_SERVERS,
  DEFAULT_SERVER_ID,
  getActiveServerId,
  getActiveServer,
  setActiveServerId,
} from "../tiledServers";

describe("tiledServers", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("defaults to DEFAULT_SERVER_ID when nothing is persisted", () => {
    expect(getActiveServerId()).toBe(DEFAULT_SERVER_ID);
    expect(getActiveServer().id).toBe(DEFAULT_SERVER_ID);
  });

  it("round-trips a persisted server id", () => {
    setActiveServerId("staging");
    expect(getActiveServerId()).toBe("staging");
    expect(getActiveServer().id).toBe("staging");
    expect(getActiveServer()).toBe(TILED_SERVERS.find((s) => s.id === "staging"));
  });

  it("falls back to the default for an invalid persisted value", () => {
    localStorage.setItem("tiledServerId", "not-a-real-server");
    expect(getActiveServerId()).toBe(DEFAULT_SERVER_ID);
  });

  it("falls back to the default when localStorage.getItem throws", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(getActiveServerId()).toBe(DEFAULT_SERVER_ID);
    vi.restoreAllMocks();
  });

  it("setActiveServerId silently no-ops when localStorage.setItem throws", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(() => setActiveServerId("staging")).not.toThrow();
    vi.restoreAllMocks();
  });

  it("every server has a non-empty apiUrl and oidcRedirectUrl", () => {
    for (const server of TILED_SERVERS) {
      expect(server.apiUrl.length).toBeGreaterThan(0);
      expect(server.oidcRedirectUrl.length).toBeGreaterThan(0);
    }
  });
});

describe("FIXED_SERVER_ID (locked builds)", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("is undefined when VITE_FIXED_TILED_SERVER is unset (today's :local behavior)", async () => {
    vi.stubEnv("VITE_FIXED_TILED_SERVER", "");
    const mod = await import("../tiledServers");
    expect(mod.FIXED_SERVER_ID).toBeUndefined();
  });

  it("locks to a server by matching its apiUrl host", async () => {
    vi.stubEnv("VITE_FIXED_TILED_SERVER", "tiled.als.lbl.gov");
    const mod = await import("../tiledServers");
    expect(mod.FIXED_SERVER_ID).toBe("production");
    expect(mod.getActiveServerId()).toBe("production");
  });

  it("throws at import time for a hostname that matches no configured server", async () => {
    vi.stubEnv("VITE_FIXED_TILED_SERVER", "not-a-real-host.example.com");
    await expect(import("../tiledServers")).rejects.toThrow(/doesn't match any configured server/);
  });

  it("getActiveServerId ignores localStorage entirely once locked", async () => {
    vi.stubEnv("VITE_FIXED_TILED_SERVER", "tiled-staging.als.lbl.gov");
    localStorage.setItem("tiledServerId", "production"); // an attempted override
    const mod = await import("../tiledServers");
    expect(mod.getActiveServerId()).toBe("staging");
  });

  it("setActiveServerId is a no-op once locked", async () => {
    vi.stubEnv("VITE_FIXED_TILED_SERVER", "tiled.als.lbl.gov");
    const mod = await import("../tiledServers");
    mod.setActiveServerId("staging");
    expect(localStorage.getItem("tiledServerId")).toBeNull();
  });
});
