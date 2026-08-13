/**
 * Minimal LZ4 block (not frame) decompressor for Blosc-compressed Zarr chunks.
 *
 * @packageDocumentation
 */

/**
 * Decompress an LZ4 block into `dest` (exactly `destLen` bytes expected).
 * Returns the number of bytes written, or throws on malformed input.
 */
export function lz4BlockDecompress(src: Uint8Array, dest: Uint8Array): number {
  const destLen = dest.length;
  let ip = 0;
  let op = 0;
  const srcEnd = src.length;

  while (ip < srcEnd) {
    const token = src[ip++]!;
    let litLen = token >>> 4;
    if (litLen === 15) {
      let s: number;
      do {
        if (ip >= srcEnd) throw new Error("lz4: truncated literal length");
        s = src[ip++]!;
        litLen += s;
      } while (s === 255);
    }
    if (op + litLen > destLen) throw new Error("lz4: literal overrun");
    if (ip + litLen > srcEnd) throw new Error("lz4: truncated literals");
    dest.set(src.subarray(ip, ip + litLen), op);
    ip += litLen;
    op += litLen;
    if (op === destLen) return op;
    if (ip + 2 > srcEnd) throw new Error("lz4: truncated match offset");
    const offset = src[ip]! | (src[ip + 1]! << 8);
    ip += 2;
    if (offset === 0 || offset > op) throw new Error("lz4: invalid offset");
    let matchLen = (token & 0xf) + 4;
    if ((token & 0xf) === 15) {
      let s: number;
      do {
        if (ip >= srcEnd) throw new Error("lz4: truncated match length");
        s = src[ip++]!;
        matchLen += s;
      } while (s === 255);
    }
    if (op + matchLen > destLen) throw new Error("lz4: match overrun");
    let matchPos = op - offset;
    // Copy byte-by-byte to handle overlapping matches.
    for (let i = 0; i < matchLen; i++) {
      dest[op++] = dest[matchPos++]!;
    }
  }
  if (op !== destLen) throw new Error(`lz4: short output (${op}/${destLen})`);
  return op;
}
