/**
 * runtime/components/Rigidbody2D.js
 *
 * Plain physics-body data, mirrored 1:1 to a real Rapier RigidBody by
 * runtime/physics/PhysicsWorld.js — no physics math and no Rapier
 * objects live on the component itself, so it stays trivially
 * serializable (RULES.txt section 4).
 *
 * bodyType decides which fields are actually meaningful:
 *  - Dynamic:   full simulation. mass/gravityScale/damping/lockRotation
 *               all apply; Rapier integrates forces + collisions.
 *  - Kinematic: moved by code/animation, not forces. Only velocity
 *               (used to move it) and lockRotation apply; mass, drag,
 *               and gravity are ignored by a kinematic body.
 *  - Static:    never moves. None of the dynamic-only fields apply —
 *               only the body exists as an immovable collider anchor.
 * The Inspector (editor/panels/Inspector.js) reads bodyType to decide
 * which of these fields to actually show, matching Unity's convention
 * of hiding body-type-irrelevant settings.
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

    // Dynamic-only
    mass = 1,
    gravityScale = 1,
    linearDamping = 0,
    angularDamping = 0.05,

    // Dynamic + Kinematic
    lockRotation = false,

    // working velocity — for Dynamic this is read back FROM Rapier each
    // frame; for Kinematic this is the velocity the caller/script sets
    // to drive the body (consumed by PhysicsWorld as a kinematic move).
    velocityX = 0,
    velocityY = 0,
    angularVelocity = 0,
  } = {}) {
    this.bodyType = bodyType;
    this.simulated = simulated;

    this.mass = mass;
    this.gravityScale = gravityScale;
    this.linearDamping = linearDamping;
    this.angularDamping = angularDamping;

    this.lockRotation = lockRotation;

    this.velocityX = velocityX;
    this.velocityY = velocityY;
    this.angularVelocity = angularVelocity;
  }
}
