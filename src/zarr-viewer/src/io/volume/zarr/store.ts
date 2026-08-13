/**
 * Zarr stores abstract where chunk/metadata bytes come from: HTTP(S), the File System Access API,
 * or an in-memory map. Zarr v2 and v3 key layouts are both supported.
 *
 * @packageDocumentation
 */

/** A key-value byte store (keys are POSIX-like paths within the Zarr hierarchy). */
export interface Store {
  /** Fetch the bytes for `key`, or `undefined` if absent. */
  get(key: string): Promise<Uint8Array | undefined>;
  /** Whether `key` exists. */
  has(key: string): Promise<boolean>;
}

/** Normalize a store key to a relative POSIX path without a leading slash. */
export function normalizeStoreKey(key: string): string {
  return key.replace(/^\/+/, "").replace(/\\/g, "/");
}

function joinUrl(base: string, key: string): string {
  const k = normalizeStoreKey(key);
  if (!base) return k;
  return base.endsWith("/") ? base + k : `${base}/${k}`;
}

/** A store backed by `fetch` (HTTP/HTTPS or same-origin static mounts). */
export function httpStore(baseUrl: string): Store {
  const base = baseUrl.replace(/\/+$/, "");
  return {
    async get(key: string): Promise<Uint8Array | undefined> {
      const url = joinUrl(base, key);
      const res = await fetch(url);
      if (res.status === 404) return undefined;
      if (!res.ok) throw new Error(`httpStore GET ${url}: ${res.status} ${res.statusText}`);
      // Guard against HTML/JS error pages being treated as chunk bytes.
      const ctype = res.headers.get("content-type") ?? "";
      if (ctype.includes("text/html") || ctype.includes("text/javascript")) {
        throw new Error(
          `httpStore GET ${url}: unexpected content-type ${ctype} (is the Zarr served as raw static files?)`,
        );
      }
      return new Uint8Array(await res.arrayBuffer());
    },
    async has(key: string): Promise<boolean> {
      const url = joinUrl(base, key);
      const res = await fetch(url, { method: "HEAD" });
      if (res.status === 404) return false;
      if (res.ok) return true;
      // Some static servers reject HEAD — fall back to GET.
      if (res.status === 405 || res.status === 501) {
        const g = await fetch(url, { method: "GET" });
        return g.ok;
      }
      return false;
    },
  };
}

/** A store backed by an in-memory map (useful for tests/fixtures). */
export function memoryStore(entries: Map<string, Uint8Array>): Store {
  const map = new Map<string, Uint8Array>();
  for (const [k, v] of entries) map.set(normalizeStoreKey(k), v);
  return {
    async get(key: string): Promise<Uint8Array | undefined> {
      return map.get(normalizeStoreKey(key));
    },
    async has(key: string): Promise<boolean> {
      return map.has(normalizeStoreKey(key));
    },
  };
}

/**
 * A store backed by a File System Access API directory handle (user-picked `.zarr` folder).
 * Supports nested keys with `/` separators (Zarr `dimension_separator: "/"`).
 */
export function fileSystemStore(root: FileSystemDirectoryHandle): Store {
  async function resolveFile(key: string): Promise<FileSystemFileHandle | undefined> {
    const parts = normalizeStoreKey(key).split("/").filter(Boolean);
    if (parts.length === 0) return undefined;
    let dir: FileSystemDirectoryHandle = root;
    for (let i = 0; i < parts.length - 1; i++) {
      try {
        dir = await dir.getDirectoryHandle(parts[i]!);
      } catch {
        return undefined;
      }
    }
    try {
      return await dir.getFileHandle(parts[parts.length - 1]!);
    } catch {
      return undefined;
    }
  }

  return {
    async get(key: string): Promise<Uint8Array | undefined> {
      const fh = await resolveFile(key);
      if (!fh) return undefined;
      const file = await fh.getFile();
      return new Uint8Array(await file.arrayBuffer());
    },
    async has(key: string): Promise<boolean> {
      return (await resolveFile(key)) !== undefined;
    },
  };
}
