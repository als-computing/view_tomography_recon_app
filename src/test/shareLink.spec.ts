import { describe, it, expect, beforeEach } from "vitest";
import { fileIdFromZarrUrl, zarrUrlFromFileId, buildShareUrl, readShareFromLocation } from "../shareLink";
import type { ShareState } from "../shareLink";

describe("fileIdFromZarrUrl / zarrUrlFromFileId", () => {
  it("extracts the file id after /zarr/v2/", () => {
    expect(fileIdFromZarrUrl("http://localhost:8001/zarr/v2/scans/petiole22")).toBe("scans/petiole22");
  });

  it("returns null when there's no /zarr/v2/ segment", () => {
    expect(fileIdFromZarrUrl("http://localhost:8001/api/v1/scans/petiole22")).toBeNull();
  });

  it("rebuilds a zarr URL from a file id using the active server's base URL", () => {
    expect(zarrUrlFromFileId("scans/petiole22")).toBe("http://localhost:8001/zarr/v2/scans/petiole22");
  });

  it("round-trips fileIdFromZarrUrl(zarrUrlFromFileId(x)) === x", () => {
    const fileId = "scans/nist_sand";
    expect(fileIdFromZarrUrl(zarrUrlFromFileId(fileId))).toBe(fileId);
  });
});

describe("buildShareUrl / readShareFromLocation", () => {
  const state: ShareState = { f: "scans/petiole22", r: "webgpu", camera: { x: 1 } };

  beforeEach(() => {
    window.history.replaceState(null, "", "/tomo_viewer/");
  });

  it("round-trips a share state through the URL", () => {
    const url = buildShareUrl(state);
    const shareParam = new URL(url).searchParams.get("share");
    expect(shareParam).toBeTruthy();

    window.history.replaceState(null, "", `/tomo_viewer/?share=${shareParam}`);
    const decoded = readShareFromLocation();
    expect(decoded).toEqual(state);
  });

  it("returns null when there's no share param", () => {
    window.history.replaceState(null, "", "/tomo_viewer/");
    expect(readShareFromLocation()).toBeNull();
  });

  it("returns null for a malformed share param", () => {
    window.history.replaceState(null, "", "/tomo_viewer/?share=not-valid-base64url!!!");
    expect(readShareFromLocation()).toBeNull();
  });

  it("returns null when the decoded payload has no file id", () => {
    const bytes = new TextEncoder().encode(JSON.stringify({ notF: "x" }));
    let binary = "";
    bytes.forEach((b) => {
      binary += String.fromCharCode(b);
    });
    const encoded = btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    window.history.replaceState(null, "", `/tomo_viewer/?share=${encoded}`);
    expect(readShareFromLocation()).toBeNull();
  });
});
