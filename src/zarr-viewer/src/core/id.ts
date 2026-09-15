/**
 * Branded, allocation-free identifiers and handles.
 *
 * Handles are plain 32-bit integers wearing a compile-time brand, so they are as cheap as numbers
 * at runtime but cannot be accidentally mixed across domains (e.g. a `Handle<"Node">` is not
 * assignable to a `Handle<"Texture">`).
 *
 * @packageDocumentation
 */

declare const brand: unique symbol;

/**
 * A branded numeric handle. `Tag` is a phantom type used only for compile-time safety.
 *
 * @typeParam Tag - A unique string tag identifying the handle's domain.
 */
export type Handle<Tag extends string> = number & { readonly [brand]: Tag };

/**
 * Create a strongly-typed, monotonically increasing handle allocator.
 *
 * @typeParam Tag - The domain tag for handles produced by this allocator.
 * @returns A `next()` function producing fresh handles.
 *
 * @example
 * ```ts
 * const nextNodeId = createHandleAllocator<"Node">();
 * const a = nextNodeId(); // Handle<"Node">
 * const b = nextNodeId();
 * ```
 */
export function createHandleAllocator<Tag extends string>(): () => Handle<Tag> {
  let counter = 0;
  return () => ++counter as Handle<Tag>;
}

const HEX = "0123456789abcdef";

/**
 * Generate a RFC-4122 version-4 UUID string using `crypto.getRandomValues` when available,
 * falling back to `Math.random` (non-cryptographic) otherwise.
 *
 * @example
 * ```ts
 * const sessionId = uuid();
 * ```
 */
export function uuid(): string {
  const bytes = new Uint8Array(16);
  const cryptoObj = (globalThis as { crypto?: Crypto }).crypto;
  if (cryptoObj?.getRandomValues) {
    cryptoObj.getRandomValues(bytes);
  } else {
    for (let i = 0; i < 16; i++) bytes[i] = (Math.random() * 256) & 0xff;
  }
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;

  let out = "";
  for (let i = 0; i < 16; i++) {
    const b = bytes[i]!;
    out += HEX[(b >> 4) & 0xf]! + HEX[b & 0xf]!;
    if (i === 3 || i === 5 || i === 7 || i === 9) out += "-";
  }
  return out;
}
