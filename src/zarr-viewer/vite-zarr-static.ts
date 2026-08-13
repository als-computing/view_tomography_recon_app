/**
 * Vite middleware: serve a local OME-Zarr directory as raw bytes (no module transform).
 * Extensionless chunk keys and `.zarray` / `.zattrs` must not go through `/@fs` JS transforms.
 */

import { createReadStream, existsSync, statSync } from "node:fs";
import { normalize, relative, resolve, sep } from "node:path";
import type { Connect, Plugin } from "vite";

export interface ZarrStaticMount {
  /** URL prefix, e.g. `/datasets/petiole.zarr`. */
  url: string;
  /** Absolute filesystem path to the `.zarr` root. */
  root: string;
}

function contentTypeFor(key: string): string {
  if (
    key.endsWith(".json") ||
    key.endsWith(".zattrs") ||
    key.endsWith(".zarray") ||
    key.endsWith(".zgroup") ||
    key.endsWith(".zmetadata")
  ) {
    return "application/json";
  }
  return "application/octet-stream";
}

function safeJoin(root: string, urlPath: string): string | undefined {
  const decoded = decodeURIComponent(urlPath);
  const abs = normalize(resolve(root, decoded));
  const rel = relative(root, abs);
  if (rel.startsWith("..") || rel.startsWith(sep)) return undefined;
  if (!abs.startsWith(root)) return undefined;
  return abs;
}

/** Serve one or more local Zarr stores under fixed URL prefixes as raw files. */
export function zarrStaticPlugin(mounts: ZarrStaticMount[]): Plugin {
  return {
    name: "zarr-viewer-static",
    configureServer(server) {
      const handler: Connect.NextHandleFunction = (req, res, next) => {
        if (!req.url || (req.method !== "GET" && req.method !== "HEAD")) {
          next();
          return;
        }
        const pathOnly = req.url.split("?")[0] ?? "";
        for (const mount of mounts) {
          const prefix = mount.url.replace(/\/+$/, "");
          if (pathOnly !== prefix && !pathOnly.startsWith(`${prefix}/`)) continue;

          const root = resolve(mount.root);
          if (!existsSync(root)) {
            res.statusCode = 404;
            res.end(`Zarr root missing: ${root}`);
            return;
          }

          const rel = pathOnly === prefix ? "" : pathOnly.slice(prefix.length + 1);
          if (!rel) {
            res.statusCode = 404;
            res.end("Not a file");
            return;
          }

          const filePath = safeJoin(root, rel);
          if (!filePath) {
            res.statusCode = 403;
            res.end("Forbidden");
            return;
          }
          if (!existsSync(filePath) || !statSync(filePath).isFile()) {
            res.statusCode = 404;
            res.end("Not found");
            return;
          }

          const st = statSync(filePath);
          res.statusCode = 200;
          res.setHeader("Content-Type", contentTypeFor(rel));
          res.setHeader("Content-Length", String(st.size));
          res.setHeader("Cache-Control", "no-cache");
          if (req.method === "HEAD") {
            res.end();
            return;
          }
          createReadStream(filePath).pipe(res);
          return;
        }
        next();
      };
      // Run before Vite's internal /@fs transform.
      server.middlewares.use(handler);
    },
  };
}

/**
 * Default petiole tomography mount. Override with env `ZARR_ROOT`, or change `root` here.
 * The viewer also supports `?zarr=<url>` and the in-app Open (File System Access) button.
 */
export const PETIOLE_ZARR_MOUNT: ZarrStaticMount = {
  url: "/datasets/petiole.zarr",
  root:
    process.env.ZARR_ROOT ??
    "/Users/david/Documents/data/tomo/scratch/rec20260221_135217_petiole22.zarr",
};
