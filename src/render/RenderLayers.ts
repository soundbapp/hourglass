import type { Camera, Object3D } from 'three';

/**
 * Layer assignment for depth-only captures.
 *
 * Several things in the frame are drawn as additive sprites that deliberately
 * do not write depth: dust motes, impact sparks, the muzzle flash. Their own
 * materials say so. But `DepthCapture` draws the scene with an *override*
 * material, which replaces those materials wholesale — and the override is
 * opaque and depth-writing. A `Points` field therefore stops being a cloud of
 * soft, transparent specks and becomes a few thousand solid, screen-aligned
 * squares punched into the depth buffer.
 *
 * That is invisible in the beauty pass and ruinous everywhere depth is read as
 * geometry. The volumetric march terminates at each square, so the light shaft
 * is cut into hard rectangles; GTAO reconstructs world positions from the same
 * depth and produces matching rectangular blocks of occlusion. The symptom
 * looks like a filtering or precision fault and is neither.
 *
 * The remedy: anything that must not occlude is moved off the default layer;
 * the main camera is told to draw that layer as well, and every depth-only
 * capture turns it off for the duration. Adding a new effect is then one call
 * rather than another entry in a list of things to remember to hide.
 *
 * Note what does *not* belong here. The viewmodel is solid, and a light shaft
 * marched straight through the receiver reads as a ghost rather than a gun —
 * so the weapon stays in the captures and occludes exactly as it should. Only
 * its muzzle flash, an additive card, is exempt.
 */

/** Objects here are drawn normally but never written into a depth capture. */
export const NON_OCCLUDING_LAYER = 1;

/**
 * Moves a subtree onto the non-occluding layer.
 *
 * `set` rather than `enable`: the object must leave the default layer entirely,
 * because a camera matches if *any* bit is shared, so an object that kept layer
 * 0 would still be captured.
 *
 * @param root - Subtree to exempt. Applied to every descendant.
 */
export function markNonOccluding(root: Object3D): void {
  root.traverse((object) => {
    object.layers.set(NON_OCCLUDING_LAYER);
  });
}

/** Lets a camera see non-occluding objects, in addition to everything else. */
export function includeNonOccluding(camera: Camera): void {
  camera.layers.enable(NON_OCCLUDING_LAYER);
}
