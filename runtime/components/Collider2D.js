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
});

export class Collider2D {
  constructor({
    shape = ColliderShape.BOX,
    width = 1,
    height = 1,
    radius = 0.5,
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
    // Shared
    this.offsetX = offsetX;
    this.offsetY = offsetY;
    this.isTrigger = isTrigger;
    this.friction = friction;
    this.restitution = restitution;
    this.density = density;
  }
}
