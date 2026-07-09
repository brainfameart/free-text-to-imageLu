/**
 * runtime/physics/PhysicsWorld.js
 *
 * Owns the real Rapier2D physics simulation and keeps it in sync with
 * the ECS: for every entity with a Rigidbody2D (and/or Collider2D) it
 * creates/updates a matching Rapier RigidBody + Collider, steps the
 * Rapier world each tick, and writes the resulting position/rotation
 * back onto that entity's Transform. No collision math, no AABB sweep,
 * no custom solver of any kind lives here or anywhere else in the
 * engine — Rapier is the single source of truth for all collision
 * detection and resolution.
 *
 * Units: this engine is 1 world-unit = 1 pixel everywhere (Transform,
 * Camera resolution, etc — see runtime/core/CameraUtils.js). Every
 * position/size passed to Rapier below stays in that same pixel space —
 * there is NO coordinate conversion layer, and nothing outside this
 * file needs to know Rapier is involved at all. The only physics-scale
 * concern is Rapier's internal SOLVER TOLERANCES (contact/penetration/
 * sleep thresholds), which assume ~1-unit objects by default; that is
 * handled once, below, via World.lengthUnit — see the comment there.
 *
 * RUNTIME-ONLY FILE.
 */

import { TRANSFORM } from "../components/Transform.js";
import { RIGIDBODY_2D, BodyType } from "../components/Rigidbody2D.js";
import { COLLIDER_2D, ColliderShape } from "../components/Collider2D.js";
import { getColliderWorldGeometry } from "./ColliderGeometry.js";
import { loadRapier } from "./RapierLoader.js";

const GRAVITY_Y = 980; // px/s^2 downward — same constant the old stub integrator used

// Rapier's solver internally assumes "human scale" objects are ~1 unit
// (1 meter) — its contact/penetration/sleep tolerances are all derived
// from that assumption. This engine works entirely in pixels (1 unit =
// 1 pixel), where a typical object is ~100 units, i.e. ~100x too big
// for those tolerances. Rather than rewriting every position/size in
// the engine into meters, Rapier's World.lengthUnit tells the solver
// "100 of your units = 1 of my meters" so it rescales its internal
// thresholds to match — this is Rapier's own documented fix for
// exactly this pixel-scale mismatch, and it requires no coordinate
// conversion anywhere else: Transform, the Collider2D gizmo, and scene
// files all keep using plain pixels, unaffected.
const LENGTH_UNIT_PX_PER_METER = 100;

const DEG2RAD = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;

function rapierBodyType(RAPIER, bodyType) {
  switch (bodyType) {
    case BodyType.STATIC:
      return RAPIER.RigidBodyType.Fixed;
    case BodyType.KINEMATIC:
      // Position-based (not velocity-based): a KinematicVelocityBased
      // body's trajectory is NEVER corrected by Rapier no matter what
      // it hits — that body type only generates contact events, it
      // does not get blocked (see Rapier's own docs: kinematic bodies
      // are moved by the user and are "independent from any contact").
      // Position-based is what lets us use KinematicCharacterController
      // below to sweep-test the desired movement against obstacles
      // and get back a corrected (blocked/slid) movement to apply.
      return RAPIER.RigidBodyType.KinematicPositionBased;
    case BodyType.DYNAMIC:
    default:
      return RAPIER.RigidBodyType.Dynamic;
  }
}

export class PhysicsWorld {
  constructor() {
    /** @type {typeof import('@dimforge/rapier2d-compat')|null} */
    this.RAPIER = null;
    /** @type {import('@dimforge/rapier2d-compat').World|null} */
    this.rapierWorld = null;
    this.ready = false;

    /** @type {Map<string, { body: object, collider: object|null, bodyType: string, colliderSig: string }>} entityId -> handles */
    this._handles = new Map();

    // Small skin/offset gap (in world pixels) the character controller
    // keeps between a kinematic body and whatever it's sweeping
    // against — Rapier requires a nonzero value for solver stability.
    // 0.5px is imperceptible but avoids the controller reporting
    // "stuck" from exact zero-distance contact.
    this._characterControllerOffset = 0.5;
    /** @type {import('@dimforge/rapier2d-compat').KinematicCharacterController|null} shared across every KINEMATIC body — the controller only needs the collider + desired movement per call, so one instance is enough for the whole world. */
    this._characterController = null;

    this._readyPromise = loadRapier().then((RAPIER) => {
      this.RAPIER = RAPIER;
      this.rapierWorld = new RAPIER.World({ x: 0, y: GRAVITY_Y });
      this.rapierWorld.lengthUnit = LENGTH_UNIT_PX_PER_METER;
      this._characterController = this.rapierWorld.createCharacterController(
        this._characterControllerOffset
      );

      // Sliding: without this, hitting a wall at an angle just stops
      // the character dead instead of sliding along it — every other
      // 2D/3D platformer with a character controller has this on.
      this._characterController.setSlideEnabled(true);

      // Snap-to-ground: this is what kills the "jitters/slips around"
      // symptom. Without it, a kinematic body standing still on flat
      // ground can, frame to frame, land a hair's-width above or below
      // the surface (float rounding + the controller's own offset gap)
      // and the sweep result flickers between "grounded, 0 movement"
      // and "falling, tiny movement" — visually a jitter/vibration.
      // Snap-to-ground forces it back flush with the floor every frame
      // instead of leaving it to float in that gap.
      this._characterController.enableSnapToGround(2); // px

      // Autostep: lets a kinematic mover walk over small ledges/steps
      // instead of catching on their edge — standard platformer feel,
      // and also prevents a specific jitter case where a mover's own
      // collider corner clips a 1-2px seam between adjacent tiles.
      this._characterController.enableAutostep(
        10, // px — max step height it can climb automatically
        4, // px — min free width required above the step to allow it
        true // also allow autostepping onto dynamic bodies
      );

      // Dynamic-body pushing is handled MANUALLY in
      // _syncKinematicMovement._pushDynamicBodies: a directional,
      // bulldozer-style shove along the kinematic's actual travel
      // direction. The character controller's built-in
      // setApplyImpulsesToDynamicBodies is left OFF on purpose — per
      // Rapier's own docs it only pushes along contact normals and
      // frequently produces no reaction at all (the controller's offset
      // gap prevents real contacts), so it can't be relied on for
      // "push bodies in the direction the kinematic is moving".
      this._characterController.setApplyImpulsesToDynamicBodies(false);

      this.ready = true;
    });
  }

  /** @returns {Promise<void>} resolves once Rapier's WASM is loaded and the world exists */
  whenReady() {
    return this._readyPromise;
  }

  /**
   * Creates/updates Rapier bodies+colliders to match current ECS state,
   * steps the simulation, then writes results back to Transform.
   * No-ops silently until Rapier finishes loading (whenReady()).
   * @param {import('../core/World.js').World} world
   * @param {number} dt
   */
  step(world, dt) {
    if (!this.ready) return;

    const entities = world.query(TRANSFORM).filter(
      (e) => e.hasComponent(RIGIDBODY_2D) || e.hasComponent(COLLIDER_2D)
    );
    const seen = new Set();

    const stepDt = dt > 0 ? dt : 1 / 60;
    for (const entity of entities) {
      seen.add(entity.id);
      this._syncEntity(entity, stepDt);
    }

    // remove Rapier bodies for entities that no longer have physics
    // components (or were destroyed)
    for (const [entityId, handle] of this._handles) {
      if (!seen.has(entityId)) {
        this.rapierWorld.removeRigidBody(handle.body);
        this._handles.delete(entityId);
      }
    }

    this.rapierWorld.timestep = stepDt;
    this.rapierWorld.step();

    // write results back onto Transform for every DYNAMIC / KINEMATIC body
    for (const entity of entities) {
      const rb = entity.getComponent(RIGIDBODY_2D);
      if (!rb || rb.bodyType === BodyType.STATIC || !rb.simulated) continue;

      const handle = this._handles.get(entity.id);
      if (!handle) continue;

      const transform = entity.getComponent(TRANSFORM);
      const pos = handle.body.translation();
      transform.x = pos.x;
      transform.y = pos.y;
      if (!rb.lockRotation) transform.rotation = handle.body.rotation() * RAD2DEG;

      if (rb.bodyType === BodyType.DYNAMIC) {
        // Dynamic bodies: Rapier's solver owns velocity outright, so
        // read it back every frame (as before) so scripts/Inspector see
        // the true simulated speed (e.g. after gravity, pushes, etc).
        const vel = handle.body.linvel();
        rb.velocityX = vel.x;
        rb.velocityY = vel.y;
        rb.angularVelocity = handle.body.angvel();
      }
      // KINEMATIC: rb.velocityX/Y are left as whatever the character-
      // controller sweep in _syncEntity already wrote (the ACTUAL,
      // possibly-blocked/slid velocity for this step) — a
      // KinematicPositionBased body has no meaningful linvel() from
      // Rapier's solver to read back here, since we drive it via
      // setNextKinematicTranslation rather than forces/velocity.
    }
  }

  /**
   * Ensures entity has a matching Rapier body/collider whose settings
   * match its current components, creating or recreating as needed, and
   * pushes any editor-driven Transform/velocity changes onto the body.
   */
  _syncEntity(entity, dt) {
    const RAPIER = this.RAPIER;
    const transform = entity.getComponent(TRANSFORM);
    const rb = entity.getComponent(RIGIDBODY_2D);
    const collider = entity.getComponent(COLLIDER_2D);

    // An entity with ONLY a Collider2D (no Rigidbody2D) is an implicit
    // static collider — the common "just a wall" Unity pattern.
    const effectiveBodyType = rb ? rb.bodyType : BodyType.STATIC;
    const simulated = rb ? rb.simulated : true;

    let handle = this._handles.get(entity.id);

    if (!simulated) {
      // simulated=false: remove any live body, do nothing further, but
      // keep no handle so it's recreated cleanly if re-enabled.
      if (handle) {
        this.rapierWorld.removeRigidBody(handle.body);
        this._handles.delete(entity.id);
      }
      return;
    }

    const needsNewBody = !handle || handle.bodyType !== effectiveBodyType;

    if (needsNewBody) {
      if (handle) this.rapierWorld.removeRigidBody(handle.body);

      const desc = new RAPIER.RigidBodyDesc(rapierBodyType(RAPIER, effectiveBodyType))
        .setTranslation(transform.x, transform.y)
        .setRotation(transform.rotation * DEG2RAD);

      const body = this.rapierWorld.createRigidBody(desc);
      handle = { body, collider: null, bodyType: effectiveBodyType, colliderSig: null };
      this._handles.set(entity.id, handle);
    } else {
      // Static bodies never move via simulation, but the editor may
      // still drag them around in edit mode — keep them synced to
      // Transform. Dynamic bodies own their own position once created;
      // don't stomp Rapier's simulated position with stale Transform
      // data every frame.
      if (effectiveBodyType === BodyType.STATIC) {
        handle.body.setTranslation({ x: transform.x, y: transform.y }, true);
        handle.body.setRotation(transform.rotation * DEG2RAD, true);
      }
    }

    // Apply per-body-type tunables every frame (cheap, and lets the
    // Inspector's live sliders take effect immediately).
    if (rb) {
      if (effectiveBodyType === BodyType.DYNAMIC) {
        handle.body.setGravityScale(rb.gravityScale, true);
        handle.body.setLinearDamping(rb.linearDamping);
        handle.body.setAngularDamping(rb.angularDamping);
        handle.body.lockRotations(!!rb.lockRotation, true);
        handle.body.setAdditionalMass(Math.max(0.0001, rb.mass), true);

        // A CharacterController (runtime/systems/ControllerSystem.js)
        // may request a specific horizontal speed and/or override Y
        // (a jump kick, or continuous Y drive for Top-Down) this frame
        // WITHOUT taking over the whole body: X is set directly (so
        // movement feels responsive instead of force-accelerated), Y is
        // left to Rapier's own gravity/solver integration unless a
        // controller explicitly requested a Y override. This is still
        // 100% Rapier's solver doing the actual moving/colliding — this
        // just seeds its linear velocity, the same primitive the
        // Inspector's own Kinematic velocity fields use.
        if (rb.driveVelocityX !== null || rb.driveVelocityY !== null) {
          const current = handle.body.linvel();
          const nextX = rb.driveVelocityX !== null ? rb.driveVelocityX : current.x;
          const nextY = rb.driveVelocityY !== null ? rb.driveVelocityY : current.y;
          handle.body.setLinvel({ x: nextX, y: nextY }, true);
          handle.body.wakeUp();
        }
        // These are one-shot, transient requests — clear them now that
        // they've been applied so a controller-less frame (or a
        // Free-type controller mid-script-drive) doesn't keep re-seeding
        // stale velocity forever.
        rb.driveVelocityX = null;
        rb.driveVelocityY = null;
      }
      // KINEMATIC is handled below, AFTER _syncCollider — the sweep
      // needs handle.collider to exist, which isn't guaranteed yet on
      // the frame a body is first created.
    }

    this._syncCollider(handle, collider, transform);

    if (rb && effectiveBodyType === BodyType.KINEMATIC) {
      this._syncKinematicMovement(handle, rb, dt);
    }
  }

  /**
   * Drives a KINEMATIC body using Rapier's KinematicCharacterController
   * instead of raw setLinvel/setNextKinematicTranslation: the desired
   * displacement (velocity * dt) is swept against every obstacle in its
   * path, sliding along or stopping at anything solid, and ONLY the
   * corrected/blocked displacement is actually applied. This is what
   * makes a kinematic mover get stopped by static/kinematic walls —
   * KinematicPositionBased on its own does not do this (Rapier moves a
   * kinematic body exactly where it's told, colliding-or-not, unless a
   * character controller is used to compute the correction first).
   */
  _syncKinematicMovement(handle, rb, dt) {
    if (!handle.collider) return; // no collider yet (created same frame) — nothing to sweep

    // Use this body's own Rigidbody2D.mass as the character mass for
    // impulse resolution — without this, setApplyImpulsesToDynamicBodies
    // still works but assumes mass 0 (no push at all) since a kinematic
    // body has no intrinsic mass of its own in Rapier's eyes.
    this._characterController.setCharacterMass(Math.max(0.0001, rb.mass));

    const desiredX = rb.velocityX * dt;
    const desiredY = rb.velocityY * dt;

    this._characterController.computeColliderMovement(handle.collider, {
      x: desiredX,
      y: desiredY,
    });

    // Push every DYNAMIC body this kinematic mover ran into, along the
    // direction it is actually moving (a bulldozer shove that brings
    // each hit body up to the kinematic's own travel speed). Done AFTER
    // the sweep so we know which bodies were hit; the sweep itself
    // still stops/slides this kinematic against them exactly as before.
    this._pushDynamicBodies(rb, desiredX, desiredY, dt);

    const corrected = this._characterController.computedMovement();
    const grounded = this._characterController.computedGrounded();

    const current = handle.body.translation();
    handle.body.setNextKinematicTranslation({
      x: current.x + corrected.x,
      y: current.y + corrected.y,
    });

    if (!rb.lockRotation) {
      const currentRotation = handle.body.rotation();
      handle.body.setNextKinematicRotation(currentRotation + rb.angularVelocity * dt);
    }

    // Report back the ACTUAL (possibly blocked/slid) velocity, not the
    // requested one, so gameplay code (grounded checks, animation
    // blending, etc — e.g. ControllerSystem's grounded epsilon check)
    // sees what really happened this step rather than raw input intent.
    rb.velocityX = dt > 0 ? corrected.x / dt : 0;
    rb.velocityY = dt > 0 ? corrected.y / dt : 0;
    // Real sweep-based grounded state (see the field's doc in
    // Rigidbody2D.js) — this is what ControllerSystem should check
    // instead of guessing from a velocity epsilon, which is what
    // caused jitter: a guess can flip-flop frame to frame near-zero
    // velocity even while genuinely resting on the ground.
    rb.grounded = grounded;
  }

  /**
   * Pushes every DYNAMIC body the kinematic mover collided with during
   * the last character-controller sweep, in the direction the kinematic
   * is moving. Each hit body is brought up to the kinematic's own travel
   * speed along that direction, so the push is always "based on where
   * the kinematic is moving" — not just along the contact normal. A
   * kinematic body is effectively infinitely strong (forces never move
   * it), so the transfer is full regardless of the body's mass. STATIC
   * and KINEMATIC obstacles are skipped (impulses can't move them).
   */
  _pushDynamicBodies(rb, desiredX, desiredY, dt) {
    const RAPIER = this.RAPIER;
    const controller = this._characterController;

    const n = controller.numComputedCollisions();
    if (n === 0) return;

    // The direction the kinematic is moving this step — the basis for
    // the push direction ("where it is moving").
    const desiredLen = Math.hypot(desiredX, desiredY);
    if (desiredLen < 1e-6) return; // not moving anywhere this step

    const dirX = desiredX / desiredLen;
    const dirY = desiredY / desiredLen;
    const speed = dt > 0 ? desiredLen / dt : 0; // kinematic speed along the travel dir

    for (let i = 0; i < n; i++) {
      const col = controller.computedCollision(i);
      if (!col || !col.collider) continue;

      const otherBody = col.collider.parent();
      if (!otherBody) continue;
      if (otherBody.bodyType() !== RAPIER.RigidBodyType.Dynamic) continue;

      // Only add the speed the body doesn't already have along the
      // travel direction — once it matches the kinematic's pace we stop
      // shoving, letting Rapier's solver/gravity/friction own the rest.
      const v = otherBody.linvel();
      const vAlong = v.x * dirX + v.y * dirY;
      const deltaV = speed - vAlong;
      if (deltaV <= 1e-4) continue;

      const otherMass = Math.max(0.0001, otherBody.mass());
      // Impulse that brings the body exactly up to the kinematic's speed
      // along the travel direction (impulse = mass * delta-velocity).
      const impulseMag = otherMass * deltaV;
      otherBody.applyImpulse({ x: dirX * impulseMag, y: dirY * impulseMag }, true);
      otherBody.wakeUp();
    }
  }

  /**
   * Creates/recreates the Rapier collider attached to `handle.body` to
   * match the Collider2D component. Uses the SAME
   * getColliderWorldGeometry() helper the editor's red gizmo outline
   * uses, so the shape Rapier actually collides with is guaranteed to
   * be the shape drawn on screen — including the entity's Transform
   * scale, which earlier only the gizmo accounted for (Rapier colliders
   * don't auto-scale with non-uniform Transform scale the way a Pixi
   * sprite does, so the effective size must be baked in here).
   *
   * A signature string lets us skip the (relatively expensive)
   * recreate when nothing shape-affecting actually changed.
   */
  _syncCollider(handle, collider, transform) {
    const RAPIER = this.RAPIER;

    if (!collider) {
      if (handle.collider) {
        this.rapierWorld.removeCollider(handle.collider, true);
        handle.collider = null;
        handle.colliderSig = null;
      }
      return;
    }

    const geo = getColliderWorldGeometry(collider, transform);

    const sig = JSON.stringify([
      geo.shape,
      geo.halfWidth,
      geo.halfHeight,
      geo.radius,
      collider.capsuleRadius,
      collider.capsuleHalfHeight,
      collider.trianglePoints,
      collider.offsetX,
      collider.offsetY,
      collider.isTrigger,
      collider.friction,
      collider.restitution,
      collider.density,
      transform.scaleX,
      transform.scaleY,
    ]);

    if (handle.colliderSig === sig) return; // unchanged, skip rebuild

    if (handle.collider) {
      this.rapierWorld.removeCollider(handle.collider, true);
      handle.collider = null;
    }

    // Collider offset is attached in the BODY's local frame, so we pass
    // the raw (unscaled) offset here — Rapier rotates it with the body
    // automatically. Size, however, must be the already-scaled
    // half-extents from getColliderWorldGeometry, since Rapier shapes
    // don't respond to Transform scale on their own.
    let desc;
    if (geo.shape === ColliderShape.CIRCLE) {
      desc = RAPIER.ColliderDesc.ball(Math.max(0.01, geo.radius));
    } else if (geo.shape === ColliderShape.CAPSULE) {
      desc = RAPIER.ColliderDesc.capsule(Math.max(0.01, geo.halfHeight), Math.max(0.01, geo.radius));
    } else if (geo.shape === ColliderShape.TRIANGLE) {
      // geo.localPoints are already scaled but NOT rotated/translated —
      // Rapier applies the parent body's rotation to them itself, and
      // .setTranslation() below applies the offset, exactly matching
      // how BOX/CIRCLE/CAPSULE already handle offset+rotation.
      const [a, b, c] = geo.localPoints;
      desc = RAPIER.ColliderDesc.triangle(
        { x: a.x, y: a.y },
        { x: b.x, y: b.y },
        { x: c.x, y: c.y }
      );
    } else {
      desc = RAPIER.ColliderDesc.cuboid(Math.max(0.01, geo.halfWidth), Math.max(0.01, geo.halfHeight));
    }

    desc
      .setTranslation(collider.offsetX * transform.scaleX, collider.offsetY * transform.scaleY)
      .setSensor(!!collider.isTrigger)
      .setFriction(collider.friction)
      .setRestitution(collider.restitution)
      .setDensity(collider.density)
      // Rapier's DEFAULT active-collision-types only computes contacts
      // for pairs involving at least one Dynamic body — ANY pairing of
      // two non-dynamic bodies (Kinematic-vs-Static, Kinematic-vs-
      // Kinematic, Static-vs-Static) is silently skipped unless
      // explicitly opted in, no matter how the constant is named. A
      // Kinematic-body character controller (see
      // components/CharacterController.js) needs to be stopped by
      // static walls/floors and by other kinematic bodies just like
      // it's stopped by dynamic ones.
      //
      // IMPORTANT: RAPIER.ActiveCollisionTypes.ALL (despite the name) is
      // actually Rapier's DEFAULT set — it only enables collisions
      // between a dynamic body and a body of ANY type; it enables NO
      // collisions between two non-dynamic bodies. That means it omits
      // BOTH Kinematic-vs-Static AND Kinematic-vs-Kinematic — a
      // kinematic body would otherwise pass straight through a static
      // collider, exactly the "kinematic vs static doesn't collide"
      // bug. We OR in KINEMATIC_KINEMATIC and KINEMATIC_STATIC (note:
      // Rapier names the "wall/floor" flag KINEMATIC_STATIC, NOT
      // KINEMATIC_FIXED — using the wrong name here silently produces
      // `undefined`, which ORs into NaN and makes the whole call a
      // no-op, which was the actual bug). Static-vs-Static is correctly
      // still left out (neither side can move, so it can never produce
      // a meaningful response either way) by not OR-ing in STATIC_STATIC.
      .setActiveCollisionTypes(
        RAPIER.ActiveCollisionTypes.ALL |
          RAPIER.ActiveCollisionTypes.KINEMATIC_KINEMATIC |
          RAPIER.ActiveCollisionTypes.KINEMATIC_STATIC
      );

    handle.collider = this.rapierWorld.createCollider(desc, handle.body);
    handle.colliderSig = sig;
  }

  /** Removes every tracked Rapier body (used when the World/scene is cleared). */
  clear() {
    if (!this.ready) return;
    for (const handle of this._handles.values()) {
      this.rapierWorld.removeRigidBody(handle.body);
    }
    this._handles.clear();
  }

  destroy() {
    this.clear();
    this.rapierWorld = null;
    this.ready = false;
  }
}
