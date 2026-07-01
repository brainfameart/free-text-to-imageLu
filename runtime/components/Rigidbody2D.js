/**
 * runtime/components/Rigidbody2D.js
 *
 * Plain physics data. No physics math lives on the component itself —
 * that belongs in runtime/systems/PhysicsSystem.js so the data/behavior
 * split stays clean and the component remains trivially serializable.
 *
 * RUNTIME-ONLY FILE.
 */

export const RIGIDBODY_2D = "Rigidbody2D";

export const BodyType = Object.freeze({
  DYNAMIC: "Dynamic",
  KINEMATIC: "Kinematic",
  STATIC: "Static",
});

export class Rigidbody2D {
  constructor({
    bodyType = BodyType.DYNAMIC,
    simulated = true,
    mass = 1,
    linearDrag = 0,
    gravityScale = 1,
  } = {}) {
    this.bodyType = bodyType;
    this.simulated = simulated;
    this.mass = mass;
    this.linearDrag = linearDrag;
    this.gravityScale = gravityScale;

    // working velocity, updated by PhysicsSystem
    this.velocityX = 0;
    this.velocityY = 0;
  }
}
