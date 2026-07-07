/**
 * runtime/components/Collider2D.js
 *
 * Plain physics-shape data. Separate from Rigidbody2D on purpose (same
 * split Unity uses): a Rigidbody2D says HOW an entity moves (Dynamic /
 * Kinematic / Static), a Collider2D says WHAT SHAPE it collides as. An
 * entity can have a Collider2D with no Rigidbody2D at all (Rapier still
 * treats it as a static collider), matching Unity's "collider-only"
 * convention.
 *
 * No Rapier objects live here — this is pure serializable data. Rapier
 * collider handles are built/kept in sync by
 * runtime/physics/PhysicsWorld.js.
 *
 * RUNTIME-ONLY FILE.
 */

export const COLLIDER_2D = "Collider2D";

export const ColliderShape = Object.freeze({
  BOX: "Box",
  CIRCLE: "Circle",
  CAPSULE: "Capsule",
  TRIANGLE: "Triangle",
});

export class Collider2D {
  constructor({
    shape = ColliderShape.BOX,
    width = 1,
    height = 1,
    radius = 0.5,
    // Capsule: a "stadium" shape (rectangle with semicircle caps) —
    // matches Rapier's ColliderDesc.capsule(halfHeight, radius), whose
    // principal axis is Y (i.e. it's a vertical pill by default, the
    // conventional orientation for a 2D character collider).
    capsuleHalfHeight = 0.5,
    capsuleRadius = 0.3,
    // Triangle: 3 points in the entity's LOCAL space (same space as
    // offsetX/offsetY), user-editable via 3 draggable gizmo handles.
    // Stored as a flat default so a fresh Triangle collider is a
    // sensible small right-triangle rather than 3 coincident points
    // (which Rapier would reject as a degenerate/zero-area shape).
    trianglePoints = [
      { x: -0.5, y: 0.5 },
      { x: 0.5, y: 0.5 },
      { x: 0, y: -0.5 },
    ],
    offsetX = 0,
    offsetY = 0,
    isTrigger = false,
    friction = 0.5,
    restitution = 0,
    density = 1,
  } = {}) {
    this.shape = shape;
    // Box
    this.width = width;
    this.height = height;
    // Circle
    this.radius = radius;
    // Capsule
    this.capsuleHalfHeight = capsuleHalfHeight;
    this.capsuleRadius = capsuleRadius;
    // Triangle — deep-copy so distinct Collider2D instances never share
    // point objects by accident (e.g. via spread/default-arg reuse)
    this.trianglePoints = trianglePoints.map((p) => ({ x: p.x, y: p.y }));
    // Shared
    this.offsetX = offsetX;
    this.offsetY = offsetY;
    this.isTrigger = isTrigger;
    this.friction = friction;
    this.restitution = restitution;
    this.density = density;
  }
}
