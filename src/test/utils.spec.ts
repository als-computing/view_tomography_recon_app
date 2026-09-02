import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  createZarrFileUrlFromTiledItem,
  getTiledBaseUrl,
  createDefaultTiledBaseUrl,
  sanitizeTiledBaseUrl,
  getDefaultZarrFileUrl,
  getProcessedPath,
  isTokenExpired,
} from "../utils";
import { setActiveServerId } from "../tiledServers";

/** Builds a base64url-encoded fake JWT with the given payload (signature is never validated here). */
function fakeJwt(payload: Record<string, unknown>): string {
  const b64 = (obj: unknown) =>
    btoa(JSON.stringify(obj)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${b64({ alg: "none" })}.${b64(payload)}.sig`;
}

describe("sanitizeTiledBaseUrl", () => {
  it("removes a trailing slash", () => {
    expect(sanitizeTiledBaseUrl("https://example.com/api/v1/")).toBe("https://example.com/api/v1");
  });

  it("appends /api/v1 when missing", () => {
    expect(sanitizeTiledBaseUrl("https://example.com")).toBe("https://example.com/api/v1");
  });

  it("leaves an already-correct URL unchanged", () => {
    expect(sanitizeTiledBaseUrl("https://example.com/api/v1")).toBe("https://example.com/api/v1");
  });
});

describe("getTiledBaseUrl / getProcessedPath / getDefaultZarrFileUrl", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("reads the active server's apiUrl for the default (local) server", () => {
    expect(getTiledBaseUrl()).toBe("http://localhost:8001/api/v1");
  });

  it("switches when the active server changes", () => {
    setActiveServerId("staging");
    expect(getTiledBaseUrl()).toBe("https://tiled-staging.computing.als.lbl.gov/api/v1");
  });

  it("getProcessedPath follows the active server", () => {
    expect(getProcessedPath()).toBe("");
    setActiveServerId("staging");
    expect(getProcessedPath()).toBe("beamlines/bl832/processed");
  });

  it("getDefaultZarrFileUrl builds a zarr URL from the local server's defaultFileId", () => {
    expect(getDefaultZarrFileUrl()).toBe("http://localhost:8001/zarr/v2/scans/petiole22");
  });

  it("getDefaultZarrFileUrl returns null when the active server has no defaultFileId", () => {
    setActiveServerId("staging");
    expect(getDefaultZarrFileUrl()).toBeNull();
  });
});

describe("createDefaultTiledBaseUrl", () => {
  it("builds a URL from window.location ending in /api/v1", () => {
    const url = createDefaultTiledBaseUrl();
    expect(url.endsWith("/api/v1")).toBe(true);
    expect(url.startsWith(`${window.location.protocol}//${window.location.hostname}:`)).toBe(true);
  });
});

describe("createZarrFileUrlFromTiledItem", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("converts an /api/v1/ item URL into a /zarr/v2/ URL", () => {
    const result = createZarrFileUrlFromTiledItem({
      default: "http://localhost:8001/api/v1/scans/petiole22",
    } as never);
    expect(result).toBe("http://localhost:8001/zarr/v2/scans/petiole22");
  });

  it("returns null when the URL doesn't contain /api/v1", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = createZarrFileUrlFromTiledItem({
      default: "http://localhost:8001/some-other-path",
    } as never);
    expect(result).toBeNull();
    spy.mockRestore();
  });
});

describe("isTokenExpired", () => {
  it("treats a missing token as expired", () => {
    expect(isTokenExpired(null)).toBe(true);
    expect(isTokenExpired(undefined)).toBe(true);
  });

  it("treats a malformed (non-JWT) token as expired", () => {
    expect(isTokenExpired("not-a-jwt")).toBe(true);
  });

  it("returns false for a token that expires well in the future", () => {
    const token = fakeJwt({ exp: Math.floor(Date.now() / 1000) + 3600 });
    expect(isTokenExpired(token)).toBe(false);
  });

  it("returns true for a token that already expired", () => {
    const token = fakeJwt({ exp: Math.floor(Date.now() / 1000) - 3600 });
    expect(isTokenExpired(token)).toBe(true);
  });

  it("applies the skew window to treat a near-future expiry as already expired", () => {
    const token = fakeJwt({ exp: Math.floor(Date.now() / 1000) + 10 });
    expect(isTokenExpired(token, 30)).toBe(true);
    expect(isTokenExpired(token, 5)).toBe(false);
  });
});
