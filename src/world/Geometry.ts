import { BoxGeometry, BufferAttribute, type BufferGeometry } from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';

/**
 * Geometry helpers for the level.
 *
 * Two concerns live here, and both are about making surfaces read correctly
 * rather than about modelling.
 *
 * **World-space texel density.** `BoxGeometry` maps every face to the unit
 * square, so a texture on a sixteen-metre wall and the same texture on a
 * half-metre crate come out at wildly different scales. The eye reads that
 * instantly as fake, long before it could name why. `createWorldUvBox` rewrites
 * the UVs so one texture tile always covers the same number of metres,
 * whatever the object's size.
 *
 * **Bevelled edges.** A perfectly sharp 90° edge does not exist in a
 * manufactured object and never survives contact with the world. More
 * importantly, a sharp edge catches no specular highlight: it is a
 * discontinuity, so there is no surface at a grazing angle to light up. A
 * millimetre of bevel produces the bright thread along every edge that the eye
 * uses to judge solidity, and it is the cheapest realism available.
 */

/** Face order `BoxGeometry` emits: +X, -X, +Y, -Y, +Z, -Z. */
const FACE_SPANS: readonly (readonly ['d' | 'w', 'h' | 'd'])[] = [
  ['d', 'h'],
  ['d', 'h'],
  ['w', 'd'],
  ['w', 'd'],
  ['w', 'h'],
  ['w', 'h'],
];

/**
 * A box whose texture tiles at a fixed world size on every face.
 *
 * @param width - Size along X, in metres.
 * @param height - Size along Y, in metres.
 * @param depth - Size along Z, in metres.
 * @param textureScale - World size of one texture tile, in metres.
 */
export function createWorldUvBox(
  width: number,
  height: number,
  depth: number,
  textureScale: number,
): BufferGeometry {
  const geometry = new BoxGeometry(width, height, depth);
  const uv = geometry.getAttribute('uv') as BufferAttribute;

  const spans = { w: width, h: height, d: depth };
  // Four vertices per face, six faces, in the order BoxGeometry emits them.
  for (let face = 0; face < 6; face++) {
    const [uAxis, vAxis] = FACE_SPANS[face];
    const uScale = spans[uAxis] / textureScale;
    const vScale = spans[vAxis] / textureScale;

    for (let corner = 0; corner < 4; corner++) {
      const index = face * 4 + corner;
      uv.setXY(index, uv.getX(index) * uScale, uv.getY(index) * vScale);
    }
  }

  uv.needsUpdate = true;
  return geometry;
}

/**
 * A bevelled box with uniformly scaled UVs.
 *
 * @param width - Size along X, in metres.
 * @param height - Size along Y, in metres.
 * @param depth - Size along Z, in metres.
 * @param bevel - Edge radius, in metres. Two to five millimetres reads as
 *   machined; two centimetres reads as cast or worn.
 * @param textureScale - World size of one texture tile, in metres.
 * @param segments - Subdivisions across the bevel. Two is enough for a
 *   highlight to form; more is wasted at these sizes.
 */
export function createBevelledBox(
  width: number,
  height: number,
  depth: number,
  bevel: number,
  textureScale: number,
  segments = 2,
): BufferGeometry {
  // The radius cannot exceed half the smallest dimension or the solid inverts.
  const radius = Math.min(bevel, Math.min(width, height, depth) * 0.49);
  const geometry = new RoundedBoxGeometry(width, height, depth, segments, radius);

  const uv = geometry.getAttribute('uv') as BufferAttribute;
  const scale = Math.max(width, height, depth) / textureScale;
  for (let index = 0; index < uv.count; index++) {
    uv.setXY(index, uv.getX(index) * scale, uv.getY(index) * scale);
  }
  uv.needsUpdate = true;

  return geometry;
}
