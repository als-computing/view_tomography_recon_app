/**
 * `@zarr-viewer/math` — allocation-conscious vectors, matrices, quaternions, transforms, splines, random,
 * color, shapes, structure-of-arrays, and GPU memory layout. Column-major, WebGPU-friendly.
 *
 * @packageDocumentation
 */

export * from "./scalar.js";

export { Vec2 } from "./vec2.js";
export type { Vec2Like } from "./vec2.js";
export { Vec3 } from "./vec3.js";
export type { Vec3Like } from "./vec3.js";
export { Vec4 } from "./vec4.js";
export type { Vec4Like } from "./vec4.js";

export { Mat3 } from "./mat3.js";
export { Mat4 } from "./mat4.js";

export {
  Matrix,
  SingularMatrixError,
  luDecompose,
  luSolve,
  solve,
  determinant,
  inverse,
  choleskyDecompose,
  choleskySolve,
  conjugateGradient,
  conjugateGradientMatrix,
  eigenSymmetric,
  polarDecompose,
} from "./linalg.js";
export type {
  LuFactorization,
  LinearOperator,
  ConjugateGradientOptions,
  IterativeSolveResult,
  SymmetricEigen,
  PolarDecomposition,
} from "./linalg.js";
export { Quat } from "./quat.js";
export type { QuatLike, EulerOrder } from "./quat.js";
export { DualQuat } from "./dual-quat.js";
export { Euler } from "./euler.js";
export { Transform } from "./transform.js";

export { cubicBezier, catmullRom, hermite } from "./spline.js";

export { bisection, newton, brent } from "./roots.js";
export type { RootOptions, RootResult } from "./roots.js";
export { simpson, adaptiveSimpson, gaussLegendre } from "./quadrature.js";
export {
  Dual,
  derivative,
  valueAndDerivative,
  dualPow,
  dualSqrt,
  dualExp,
  dualLog,
  dualSin,
  dualCos,
  dualTan,
} from "./dual.js";
export { fft, ifft, fftReal } from "./fft.js";

export {
  twoSum,
  twoProduct,
  kahanSum,
  neumaierSum,
  pairwiseSum,
  compensatedDot,
  CompensatedSum,
} from "./summation.js";
export { orient2d, orient3d } from "./predicates.js";
export type { Point2Like } from "./predicates.js";
export {
  floatToHalf,
  halfToFloat,
  packUnorm4x8,
  unpackUnorm4x8,
  packSnorm4x8,
  unpackSnorm4x8,
  encodeOctNormal,
  decodeOctNormal,
  morton3D,
  demorton3D,
} from "./packing.js";
export type { Vec4Out } from "./packing.js";

export { Random } from "./random.js";
export {
  hashU32,
  hash2U32,
  uintToUnitFloat,
  randomFromSeed,
  radicalInverse,
  halton,
  reverseBits32,
  hammersley2D,
  owenScrambledRadicalInverse2,
  sampleConcentricDisk,
  sampleUniformSphere,
  sampleUniformHemisphere,
  sampleCosineHemisphere,
  cosineHemispherePdf,
  sampleGGX,
  ggxPdf,
  sampleUniformTriangle,
  powerHeuristic,
  UNIFORM_HEMISPHERE_PDF,
} from "./sampling.js";
export * from "./color.js";

export { Aabb, Sphere, Ray, Plane, Frustum } from "./shapes.js";
export {
  barycentric,
  closestPointOnSegment,
  closestPointOnAabb,
  closestPointOnTriangle,
  closestPointsBetweenSegments,
} from "./shapes.js";

export { Soa, Pool, Scratch, vec3Pool, mat4Pool, quatPool } from "./soa.js";
export type { SoaSchema, PoolOptions } from "./soa.js";
export { ScalarGrid3, VectorGrid3 } from "./field-grid.js";
export type { Grid3Spec } from "./field-grid.js";
export {
  Std140Builder,
  Std430Builder,
  std140Alignment,
  std430Alignment,
} from "./gpu-layout.js";
