/**
 * Joint-bilateral upsample math for Milestone 6 (B3): reconstructing a full-resolution lighting
 * buffer from a half-resolution one, guided by full-resolution depth/normal so the reconstruction
 * doesn't bleed across depth discontinuities (the "thin feature over empty space" case). Pure
 * math, no GPU — this validates the weighting/blend logic before it's translated to WGSL.
 *
 * @packageDocumentation
 */

/**
 * Edge-stopping weight between two samples' depth and normal. Both terms are Gaussian falloffs:
 * `sigmaDepth`/`sigmaNormal` are the standard deviations (larger = more tolerant of a mismatch).
 * Depth is in the same normalized units as `VOLUME_DEPTH_FORMAT`'s centroid output (`[0,1]`, far-
 * plane-normalized); normals are unit vectors, compared by the angle between them.
 */
export function bilateralWeight(
  depthA: number,
  depthB: number,
  normalA: readonly [number, number, number],
  normalB: readonly [number, number, number],
  sigmaDepth: number,
  sigmaNormal: number,
): number {
  const dDepth = depthA - depthB;
  const depthWeight = Math.exp(-(dDepth * dDepth) / (2 * sigmaDepth * sigmaDepth));
  const dot = normalA[0] * normalB[0] + normalA[1] * normalB[1] + normalA[2] * normalB[2];
  const angle = Math.acos(Math.min(1, Math.max(-1, dot)));
  const normalWeight = Math.exp(-(angle * angle) / (2 * sigmaNormal * sigmaNormal));
  return depthWeight * normalWeight;
}

/** Inputs for {@link bilateralUpsample}: a half-res RGBA buffer plus full/half-res depth+normal guides. */
export interface BilateralUpsampleParams {
  lowColor: Float32Array; // RGBA, lowWidth*lowHeight*4
  lowDepth: Float32Array; // lowWidth*lowHeight
  lowNormal: Float32Array; // xyz, lowWidth*lowHeight*3
  lowWidth: number;
  lowHeight: number;
  fullDepth: Float32Array; // fullWidth*fullHeight
  fullNormal: Float32Array; // xyz, fullWidth*fullHeight*3
  fullWidth: number;
  fullHeight: number;
  sigmaDepth: number;
  sigmaNormal: number;
}

/**
 * Upsample `lowColor` to `fullWidth x fullHeight`, weighting each full-res pixel's 2x2 low-res
 * neighborhood by {@link bilateralWeight} against the full-res depth/normal at that pixel. Falls
 * back to a plain (unweighted) bilinear blend when every neighbor's weight underflows to ~0 (e.g.
 * NaN/degenerate low-res depth/normal at every neighbor) so a bad low-res sample never propagates
 * as a black hole in the output.
 */
export function bilateralUpsample(params: BilateralUpsampleParams): Float32Array {
  const {
    lowColor,
    lowDepth,
    lowNormal,
    lowWidth,
    lowHeight,
    fullDepth,
    fullNormal,
    fullWidth,
    fullHeight,
    sigmaDepth,
    sigmaNormal,
  } = params;
  const out = new Float32Array(fullWidth * fullHeight * 4);
  const sx = lowWidth / fullWidth;
  const sy = lowHeight / fullHeight;

  for (let fy = 0; fy < fullHeight; fy++) {
    for (let fx = 0; fx < fullWidth; fx++) {
      const fullIdx = fy * fullWidth + fx;
      const fDepth = fullDepth[fullIdx] ?? 0;
      const fNormal: [number, number, number] = [
        fullNormal[fullIdx * 3] ?? 0,
        fullNormal[fullIdx * 3 + 1] ?? 0,
        fullNormal[fullIdx * 3 + 2] ?? 0,
      ];

      // The 2x2 low-res texel neighborhood a bilinear sample at this full-res pixel would use.
      const lx = (fx + 0.5) * sx - 0.5;
      const ly = (fy + 0.5) * sy - 0.5;
      const lx0 = Math.floor(lx);
      const ly0 = Math.floor(ly);
      const tx = lx - lx0;
      const ty = ly - ly0;

      let rSum = 0;
      let gSum = 0;
      let bSum = 0;
      let aSum = 0;
      let wSum = 0;
      let bilinearR = 0;
      let bilinearG = 0;
      let bilinearB = 0;
      let bilinearA = 0;
      let bilinearWSum = 0;

      for (let dy = 0; dy <= 1; dy++) {
        for (let dx = 0; dx <= 1; dx++) {
          const nx = Math.min(lowWidth - 1, Math.max(0, lx0 + dx));
          const ny = Math.min(lowHeight - 1, Math.max(0, ly0 + dy));
          const lowIdx = ny * lowWidth + nx;
          const bilinearWeight = (dx === 0 ? 1 - tx : tx) * (dy === 0 ? 1 - ty : ty);

          const lDepth = lowDepth[lowIdx] ?? 0;
          const lNormal: [number, number, number] = [
            lowNormal[lowIdx * 3] ?? 0,
            lowNormal[lowIdx * 3 + 1] ?? 0,
            lowNormal[lowIdx * 3 + 2] ?? 0,
          ];
          let w = bilateralWeight(fDepth, lDepth, fNormal, lNormal, sigmaDepth, sigmaNormal) * bilinearWeight;
          if (!Number.isFinite(w)) w = 0;

          const r = lowColor[lowIdx * 4] ?? 0;
          const g = lowColor[lowIdx * 4 + 1] ?? 0;
          const b = lowColor[lowIdx * 4 + 2] ?? 0;
          const a = lowColor[lowIdx * 4 + 3] ?? 0;

          rSum += r * w;
          gSum += g * w;
          bSum += b * w;
          aSum += a * w;
          wSum += w;

          bilinearR += r * bilinearWeight;
          bilinearG += g * bilinearWeight;
          bilinearB += b * bilinearWeight;
          bilinearA += a * bilinearWeight;
          bilinearWSum += bilinearWeight;
        }
      }

      // Every bilateral weight underflowed (e.g. NaN/garbage low-res guides at every neighbor) -
      // fall back to a plain bilinear blend rather than emitting a black/zero pixel.
      if (wSum > 1e-8) {
        out[fullIdx * 4] = rSum / wSum;
        out[fullIdx * 4 + 1] = gSum / wSum;
        out[fullIdx * 4 + 2] = bSum / wSum;
        out[fullIdx * 4 + 3] = aSum / wSum;
      } else if (bilinearWSum > 1e-8) {
        out[fullIdx * 4] = bilinearR / bilinearWSum;
        out[fullIdx * 4 + 1] = bilinearG / bilinearWSum;
        out[fullIdx * 4 + 2] = bilinearB / bilinearWSum;
        out[fullIdx * 4 + 3] = bilinearA / bilinearWSum;
      }
    }
  }
  return out;
}
