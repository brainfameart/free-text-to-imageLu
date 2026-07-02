/**
 * runtime/physics/ColliderGeometry.js
 *
 * The ONE place that converts a Collider2D + Transform into world-space
 * shape data (half-extents/radius + center position). Both
 * runtime/physics/PhysicsWorld.js (feeding Rapier) and
 * editor/viewport/ColliderGizmo.js (drawing the red outline) call this
 * same function, so the shape Rapier actually collides with and the
 * shape drawn on screen are mathematically guaranteed to match — there
 * is no second copy of this math anywhere to drift out of sync.
 *
 * RUNTIME-ONLY FILE. (Imported by the editor for drawing, but contains
 * no editor-only logic itself — pure geometry.)
 */

import { ColliderShape } from "../components/Collider2D.js";

/**
 * @param {import('../components/Collider2D.js').Collider2D} collider
 * @param {import('../components/Transform.js').Transform} transform
 * @returns {
 *   { shape: 'Box', centerX: number, centerY: number, halfWidth: number, halfHeight: number } |
 *   { shape: 'Circle', centerX: number, centerY: number, radius: number }
 * } world-space geometry, in the same pixel units as Transform.
 */
export function getColliderWorldGeometry(collider, transform) {
  // Collider2D's offset is in the entity's LOCAL space, so it scales
  // with the entity like any other local-space offset would (matches
  // how Rapier attaches a collider to a body: offset is relative to
  // the body's own transform, which Rapier scales internally the same
  // way this line does explicitly).
  const centerX = transform.x + collider.offsetX * transform.scaleX;
  const centerY = transform.y + collider.offsetY * transform.scaleY;

  if (collider.shape === ColliderShape.CIRCLE) {
    const radius = collider.radius * Math.max(Math.abs(transform.scaleX), Math.abs(transform.scaleY));
    return { shape: ColliderShape.CIRCLE, centerX, centerY, radius };
  }

  const halfWidth = (collider.width * Math.abs(transform.scaleX)) / 2;
  const halfHeight = (collider.height * Math.abs(transform.scaleY)) / 2;
  return { shape: ColliderShape.BOX, centerX, centerY, halfWidth, halfHeight };
}
