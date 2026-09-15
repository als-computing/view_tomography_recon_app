/**
 * Minimal geometry type stub for volume analysis isosurface output.
 * (Full glTF parsing is not included in this extract.)
 */

/** Triangle mesh data (positions required; other attributes optional). */
export interface GeometryData {
  positions: Float32Array;
  normals?: Float32Array;
  uvs?: Float32Array;
  colors?: Float32Array;
  indices?: Uint32Array;
}
