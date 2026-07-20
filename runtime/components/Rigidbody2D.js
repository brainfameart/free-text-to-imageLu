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

    // DYNAMIC-only force/impulse queue: pushed by the scripting API's
    // DynamicRigidbodyAPI (see scripting/components/RigidbodyAPI.js) via
    // .addForce()/.addImpulse()/.addTorque() and drained by
    // PhysicsWorld._syncEntity every physics step, exactly like
    // driveVelocityX/Y above — plain, serializable data (RULES.txt
    // section 4), never a function/callback, and never meaningful for
    // Kinematic/Static bodies (which have no force integration at all).
    pendingForceX = 0,
    pendingForceY = 0,
    pendingImpulseX = 0,
    pendingImpulseY = 0,
    pendingTorque = 0,
    pendingAngularImpulse = 0,
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

    this.pendingForceX = pendingForceX;
    this.pendingForceY = pendingForceY;
    this.pendingImpulseX = pendingImpulseX;
    this.pendingImpulseY = pendingImpulseY;
    this.pendingTorque = pendingTorque;
    this.pendingAngularImpulse = pendingAngularImpulse;

    // KINEMATIC-only one-shot move request: set (transiently, one frame)
    // by the scripting API's KinematicRigidbodyAPI.move(dx, dy) — a
    // direct positional nudge for a kinematic mover, swept through the
    // SAME character-controller path as velocity-driven movement (so it
    // still gets blocked/slid by obstacles) rather than a raw teleport.
    // null = no move requested this frame.
    this.pendingMoveX = null;
    this.pendingMoveY = null;

    // KINEMATIC-only, read-only: Unity-style contact-state flags written
    // every physics step by PhysicsWorld._syncKinematicMovement from the
    // character controller's computed collision normals. Always false for
    // Dynamic/Static bodies (they use Rapier's solver directly and have
    // no character-controller sweep to query).
    //
    // isOnCeiling: touching a surface above (normal pushes character down)
    // isOnWall:    touching a wall laterally (normal is mostly horizontal)
    // isOnSlope:   grounded on a non-flat surface (groundAngle >= slopeMinAngle)
    // groundAngle: angle of the ground surface in degrees from horizontal
    //              (0 = flat, 45 = steep slope, up to the groundAngleLimit)
    this.isOnCeiling = false;
    this.isOnWall = false;
    this.isOnSlope = false;
    this.groundAngle = 0;

    // KINEMATIC-only, user-configurable angle thresholds (degrees).
    // These let scripts define exactly what counts as ground, slope, and
    // wall for THIS body — no global constant to edit, no engine rebuild.
    //
    // groundAngleLimit: contacts whose normal is within this angle of
    //   world-up are treated as walkable ground (and tracked for
    //   isGrounded/groundAngle). Contacts steeper than this are either
    //   walls or unclimbable slopes. Default 45° matches Unity's
    //   CharacterController.slopeLimit default and Rapier's own example.
    //   Script: this.rigidbody.groundAngleLimit = 60
    //
    // wallAngleLimit: contacts between groundAngleLimit and this angle
    //   are "too steep to walk on" but are NOT walls — they are
    //   unclimbable slopes. Only contacts at or above this angle (i.e.
    //   nearly vertical) set isOnWall. Default 70°.
    //   Script: this.rigidbody.wallAngleLimit = 80
    //
    // slopeMinAngle: minimum groundAngle (degrees) before isOnSlope
    //   becomes true. Contacts below this are treated as flat ground.
    //   Default 10° (raised from the old 5° to reduce false positives
    //   from floating-point noise on flat floors).
    //   Script: this.rigidbody.slopeMinAngle = 15
    this.groundAngleLimit = 45;
    this.wallAngleLimit   = 70;
    this.slopeMinAngle    = 10;
  }
}
