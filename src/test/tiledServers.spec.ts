import { describe, it, expect, beforeEach, vi } from "vitest";
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
