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
 *               all apply; Rapier integrates forces + collisions. A
 *               CharacterController (see components/CharacterController.js)
 *               can still drive a Dynamic body's velocity directly —
 *               see the driveVelocityX/driveVelocityY fields below —
 *               while Rapier's own gravity/solver still owns everything
 *               else (falling, being pushed, landing).
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
    // frame (unless driveVelocityX below is set by a controller this
    // same frame); for Kinematic this is the velocity the caller/script
    // sets to drive the body (consumed by PhysicsWorld as a kinematic
    // move).
    velocityX = 0,
    velocityY = 0,
    angularVelocity = 0,

    // Set (transiently, one frame at a time) by
    // runtime/systems/ControllerSystem.js to drive a DYNAMIC body's
    // horizontal speed via Rapier's setLinvel while leaving the Y axis
    // (and therefore Rapier's own gravity/impulse integration) alone.
    // null = no controller is driving this body's X this frame, so
    // PhysicsWorld leaves Rapier's own solver-computed velocity as-is.
    // Plain data (RULES.txt section 4) — not a function/callback.
    driveVelocityX = null,
    // Set (transiently, one frame) by ControllerSystem to override a
    // DYNAMIC body's Y velocity this physics step — used both for a
    // one-shot jump kick (Character Controller/Platformer) and for
    // continuous Y drive (Top-Down, which has no gravity to preserve).
    // null = no override requested; Rapier's own gravity/solver keeps
    // integrating Y normally.
    driveVelocityY = null,
    // Set (transiently, one frame) by ControllerSystem to drive a
    // DYNAMIC body's angular velocity (e.g. Car controller steering).
    // null = no override; Rapier's own solver keeps integrating
    // rotation normally.
    driveAngularVelocity = null,

    // KINEMATIC-only, read-only from the caller's perspective: written
    // every physics step by PhysicsWorld._syncKinematicMovement from
    // the character controller's own computedGrounded() result — real
    // sweep-based ground contact, not a velocity-epsilon guess. Always
    // false for Dynamic/Static bodies (Dynamic has no character
    // controller sweep; use a separate ground-check for those).
    grounded = false,

    // KINEMATIC-only, read-only: written every physics step by
    // PhysicsWorld._syncKinematicMovement with the ACTUAL movement the
    // character-controller sweep produced (after blocking/sliding
    // against obstacles), as a velocity. velocityX/Y above stay as the
    // intended input and are NOT clobbered, so ControllerSystem's
    // acceleration lerp (and any script driving a kinematic body) keeps
    // working from intent rather than feeding a collision-blocked value
    // back into itself — which previously decelerated a kinematic body
    // every time it pushed a dynamic body (a real kinematic body has
    // infinite mass and must never slow from a collision). Read this
    // when you need "did the body actually move / how fast this step",
    // not velocityX/Y. Always 0 for Dynamic/Static bodies.
    resolvedVelocityX = 0,
    resolvedVelocityY = 0,
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

    this.driveVelocityX = driveVelocityX;
    this.driveVelocityY = driveVelocityY;

    this.driveAngularVelocity = driveAngularVelocity;

    this.grounded = grounded;

    this.resolvedVelocityX = resolvedVelocityX;
    this.resolvedVelocityY = resolvedVelocityY;
  }
}
