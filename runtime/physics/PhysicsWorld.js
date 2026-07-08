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

      // THE fix for "doesn't move dynamic bodies around": by default a
      // character controller's obstacles are treated as unmovable — it
      // computes a corrected movement against them but never pushes
      // back. This opts back into pushing dynamic bodies it runs into,
      // using each body's own mass (set per-entity below in
      // _syncKinematicMovement via setCharacterMass) so heavier things
      // are harder to shove, matching normal Rapier dynamics.
      this._characterController.setApplyImpulsesToDynamicBodies(true);

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
        // IMPORTANT: do NOT unconditionally call setAdditionalMass(rb.mass)
        // here. Rapier's real mass source for a Dynamic body is
        // density * colliderArea (Collider2D.density, applied via
        // setDensity() in _syncCollider below) — that's what the
        // Inspector's "Density" field actually controls, matching how
        // most 2D engines (Unity2D/Box2D included) derive mass. But
        // setAdditionalMass() doesn't REPLACE that — it's literally
        // additive on top of the density-derived mass, and calling it
        // every single frame with rb.mass defaulting to 1 meant a body
        // with density=0.1 (intended mass ≈0.1×area) was actually
        // sitting at ≈(0.1×area + 1), i.e. its real mass floor was
        // pinned near 1 no matter how low density went. That's why the
        // bulldozer push (_bulldozeDynamicBodies's massRatio =
        // pusherMass/targetMass) barely moved a "density 0.1" box even
        // at mover velocity 900 — targetMass was never actually ~0.1,
        // it was ~1+. Only apply rb.mass as a genuine override when the
        // person has explicitly moved it off its default (1), signaling
        // they want a fixed mass regardless of collider density; leave
        // density as the sole mass source otherwise.
        const hasExplicitMassOverride = Math.abs(rb.mass - 1) > 1e-6;
        if (hasExplicitMassOverride) {
          handle.body.setAdditionalMass(Math.max(0.0001, rb.mass), true);
        }

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
   *
   * Pushing dynamic bodies: setApplyImpulsesToDynamicBodies(true) (set
   * once, in the constructor) is Rapier's OWN built-in mechanism for
   * this, but it has two real limitations documented by Rapier itself
   * and confirmed here:
   *   1. It only fires when the controller's sweep actually registers a
   *      contact against its offset "skin" (_characterControllerOffset,
   *      0.5px) — with normal per-frame movement deltas that contact
   *      can easily be missed or only partially register, so the push
   *      is unreliable rather than "pushes whenever touching".
   *   2. When it DOES fire, the impulse is applied along the CONTACT
   *      NORMAL (perpendicular to the touched surface), not along the
   *      kinematic's own direction of travel — so shoving a box from
   *      the side can nudge it diagonally, barely, or not at all,
   *      rather than cleanly in the direction the mover is walking.
   * Below, on top of that built-in (left enabled — it's harmless and
   * still contributes some resolution force), a manual "bulldozer" push
   * is added: after the sweep, every dynamic body the controller
   * actually touched this frame gets its velocity set DIRECTLY along
   * the kinematic's own travel direction (scaled by its speed), mass-
   * gated so heavier things resist more. This guarantees the felt
   * behavior the person asked for — "push dynamic bodies based on
   * where they're moving" — regardless of the offset-gap timing issue.
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
    const corrected = this._characterController.computedMovement();
    const grounded = this._characterController.computedGrounded();

    this._bulldozeDynamicBodies(handle, rb, desiredX, desiredY, dt);

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
   * Manual push pass: iterates every collision the character controller
   * sweep just detected (numComputedCollisions/computedCollision — the
   * SAME sweep _syncKinematicMovement already did above, so this costs
   * no extra physics query), and for any touched collider that belongs
   * to a DYNAMIC body, sets that body's velocity directly along the
   * kinematic's OWN travel direction — not the contact normal — scaled
   * by how fast the kinematic is moving and gated by relative mass so a
   * light mover can't shove something far heavier at full speed.
   *
   * This intentionally sets velocity (setLinvel) rather than applying
   * an impulse: an impulse's effect depends on the target's current
   * velocity/mass in ways that can feel inconsistent frame to frame,
   * while directly setting velocity along travel direction reliably
   * produces the "bulldozer" feel — the pushed body moves at (a
   * fraction of) the pusher's speed, in the pusher's direction, for as
   * long as contact continues, then falls back to normal Rapier physics
   * (gravity, other collisions) the instant contact ends since nothing
   * here holds a persistent force on it.
   *
   * NOTE ON API SURFACE: numComputedCollisions()/computedCollision(i)
   * are rapier2d-compat@0.14.0's documented shape for reading back what
   * a KinematicCharacterController's sweep just touched
   * (RapierLoader.js pins this exact version from jsDelivr). Each
   * returned CharacterCollision exposes a numeric collider HANDLE
   * (`.handle`), not a live Collider object — it must be resolved via
   * `this.rapierWorld.getCollider(handle)` before `.parent()` gives you
   * the owning RigidBody. (An earlier version of this code assumed a
   * `.collider` object existed directly on the collision entry; it
   * didn't, so every entry was silently skipped and nothing was ever
   * pushed — this is the fix for that.)
   * Wrapped in try/catch and defensive existence checks below so that
   * IF a future Rapier upgrade renames/reshapes this API, the game
   * silently falls back to "no manual push" (kinematic bodies still
   * move/collide correctly via the character controller either way —
   * this method only ADDS the bulldozer push on top) rather than
   * throwing and breaking physics entirely.
   *
   * @param {{body:object,collider:object}} handle the kinematic's own handle
   * @param {import('../components/Rigidbody2D.js').Rigidbody2D} rb kinematic's own Rigidbody2D (for mass + speed)
   * @param {number} desiredX raw requested displacement this frame (px), i.e. rb.velocityX * dt, BEFORE the controller's own blocking/sliding correction
   * @param {number} desiredY same, Y axis
   * @param {number} dt
   */
  _bulldozeDynamicBodies(handle, rb, desiredX, desiredY, dt) {
    if (dt <= 0) return;

    const speed = Math.hypot(desiredX, desiredY) / dt; // px/s, the kinematic's actual travel speed this frame
    if (speed < 0.01) return; // not moving — nothing to push, matches "based on where they're moving"

    const dirX = desiredX / dt / speed;
    const dirY = desiredY / dt / speed;

    let count = 0;
    try {
      count = this._characterController.numComputedCollisions();
    } catch (err) {
      return; // API not available on this Rapier build — fail safe, no push
    }

    for (let i = 0; i < count; i++) {
      let otherBody;
      try {
        const collision = this._characterController.computedCollision(i);
        if (!collision) continue;

        // rapier2d-compat's CharacterCollision does NOT expose a
        // `.collider` object directly — it exposes `.handle`, a plain
        // numeric collider handle, which has to be resolved back into
        // a real Collider via World.getCollider(handle) before you can
        // call .parent() on it. (The earlier `collision.collider`
        // check above silently failed this every single frame — that
        // was the actual reason nothing ever got pushed: every
        // iteration hit the `continue` and the loop body below never
        // ran at all.)
        const colliderHandle = collision.handle;
        if (colliderHandle === undefined || colliderHandle === null) continue;

        const otherCollider = this.rapierWorld.getCollider(colliderHandle);
        if (!otherCollider) continue;

        otherBody = otherCollider.parent();
      } catch (err) {
        continue; // unexpected shape for this entry — skip it, don't crash the whole pass
      }
      if (!otherBody || typeof otherBody.isDynamic !== "function" || !otherBody.isDynamic()) continue;

      // Mass gating: a light kinematic mover shouldn't shove a much
      // heavier dynamic body at full speed — but a LIGHT dynamic body
      // should be able to get shoved FASTER than the kinematic's own
      // travel speed (a bowling ball rolling into a pebble sends the
      // pebble flying faster than the ball itself is moving; the old
      // `Math.min(1, ratio)` cap made pushSpeed <= speed ALWAYS, no
      // matter how extreme the mass difference — a 10:1 mass ratio
      // behaved identically to a 1:1 ratio, which is why pushes felt
      // weak/flat regardless of how light the target was).
      // otherBody.mass() is Rapier's own computed mass — normally
      // density * colliderArea (Collider2D.density, the Inspector's
      // real per-object mass knob for Dynamic bodies), or density*area
      // PLUS an explicit additional-mass override if the person set
      // Rigidbody2D.mass away from its default (see the
      // hasExplicitMassOverride check in _syncEntity above).
      const pusherMass = Math.max(0.0001, rb.mass);
      const targetMass = Math.max(0.0001, otherBody.mass());
      // Uncapped ratio: >1 when the target is lighter than the
      // pusher (→ pushed faster than the pusher's own speed), <1 when
      // heavier (→ pushed slower / barely moved), exactly 1 at equal
      // mass. MAX_PUSH_MULTIPLIER is a sanity ceiling only — it exists
      // so an extreme mass mismatch (e.g. density 0.001 dust mote)
      // can't fling a target at physically-absurd, solver-destabilizing
      // speed; it is NOT the "same speed as pusher" cap the old code
      // effectively enforced.
      const MAX_PUSH_MULTIPLIER = 6; // target can be shoved up to 6x the pusher's own speed
      const massRatio = Math.min(MAX_PUSH_MULTIPLIER, pusherMass / targetMass);

      const pushSpeed = speed * massRatio;

      // Set velocity along the kinematic's OWN travel direction — this
      // is the actual fix for "pushes along contact normal, not travel
      // direction" (Rapier's built-in setApplyImpulsesToDynamicBodies
      // behavior). Only the axis-component the kinematic is actually
      // moving along gets overridden; the other axis (e.g. the dynamic
      // body's own existing vertical fall speed, if the push is purely
      // horizontal) is left alone so this doesn't fight gravity or
      // cancel out unrelated motion on the other axis.
      const current = otherBody.linvel();
      const nextX = Math.abs(dirX) > 0.001 ? dirX * pushSpeed : current.x;
      const nextY = Math.abs(dirY) > 0.001 ? dirY * pushSpeed : current.y;
      otherBody.setLinvel({ x: nextX, y: nextY }, true);
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
