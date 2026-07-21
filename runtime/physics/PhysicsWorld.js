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
import { TILEMAP } from "../components/Tilemap.js";
import { TILESET } from "../components/Tileset.js";
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

// SINGLE SOURCE OF TRUTH for "how steep can a slope be before it's a
// wall instead of walkable ground" — used both to configure Rapier's
// OWN character-controller sweep behavior (setMaxSlopeClimbAngle,
// below) and to classify isOnSlope/groundAngle from the resulting
// collision normals (_syncKinematicMovement, further below). Matches
// Unity's CharacterController.slopeLimit default of 45°. Keeping both
// uses pinned to this one constant is what guarantees "can the
// character actually climb this slope" and "what does the script see
// via isOnSlope/groundAngle" never disagree with each other.
const SLOPE_LIMIT_DEG = 45;
// Below this angle (between flat ground and SLOPE_LIMIT_DEG), Rapier
// auto-slides the character down rather than letting it stand still —
// matches Rapier's own documented example (30°, paired with a 45°
// climb limit) for a natural, Unity-like "band" of walkable-but-slidey
// ground between dead flat and too-steep-to-climb.
const SLOPE_SLIDE_LIMIT_DEG = 30;
// Contacts whose normal angle is between SLOPE_LIMIT_DEG and this
// threshold are "too steep to walk on" but are NOT true walls — do NOT
// set isOnWall for them. Only normals whose angle exceeds this value
// (nearly vertical surfaces) are reported as walls. Separating the two
// thresholds stops steep-but-walkable-looking slopes from triggering
// isOnWall and stops wall-jump logic from firing while on a ramp.
const WALL_ANGLE_DEG = 70;
// Number of consecutive physics frames Rapier's computedGrounded() must
// return false before isGrounded is actually cleared. Prevents the
// 1-frame "ground → air → ground" flicker that occurs on uneven terrain,
// step edges, or when the character briefly loses the snap-to-ground
// contact while still visually standing on the surface.
const GROUNDED_GRACE_FRAMES = 3;

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

    /** @type {Map<string, { body: object, collider: object|null, bodyType: string, _colliderRef: object|null }>} entityId -> handles. Also carries cached _sig* fields used by _syncCollider's cheap per-frame dirty-check (see that method). */
    this._handles = new Map();
    // Running count of KINEMATIC bodies currently in _handles, kept in
    // sync at every _handles.set()/delete()/clear() call site (see
    // _hasKinematicBodies() below) — lets _dispatchKinematicCollisions
    // skip its entire scan with an O(1) check on frames with no
    // kinematic bodies, instead of walking _handles just to find out.
    this._kinematicCount = 0;

    // Per-tilemap-cell static colliders: each Tilemap entity whose
    // cells map to solid ground gets a single STATIC Rapier body, and
    // one cuboid collider per painted cell (sized to the referenced
    // Tileset's tileWidth/tileHeight, positioned in the body's local
    // frame at (col+0.5)*tw, (row+0.5)*th — matching
    // TilemapSystem.js's per-tile placement). This is what makes a
    // painted tilemap act as real collision geometry in Play mode,
    // so the player/kinematic/dynamic bodies land on and bump into
    // individual tiles instead of falling through the floor.
    this._tilemapBodies = new Map(); // entityId -> RigidBody
    this._tilemapCellColliders = new Map(); // entityId -> Map<cellKey, Collider>
    this._tilemapBodySig = new Map(); // entityId -> "tw,th"

    // Small skin/offset gap (in world pixels) the character controller
    // keeps between a kinematic body and whatever it's sweeping
    // against — Rapier requires a nonzero value for solver stability.
    // 0.5px is imperceptible but avoids the controller reporting
    // "stuck" from exact zero-distance contact.
    this._characterControllerOffset = 0.5;
    /** @type {import('@dimforge/rapier2d-compat').KinematicCharacterController|null} shared across every KINEMATIC body — the controller only needs the collider + desired movement per call, so one instance is enough for the whole world. */
    this._characterController = null;

    /** Reverse map from Rapier collider handle index → entityId for event dispatch */
    this._colliderHandleMap = new Map();
    /** Per-kinematic "currently touching" set, used to fire onCollision only
     *  on the enter transition (see _syncKinematicMovement). */
    this._kinematicContacts = new Map();
    /** Subset of _kinematicContacts that was established by the event queue
     *  (dynamic body moved into a stationary kinematic). Kept separate so
     *  _syncKinematicMovement's sweep — which can't see a dynamic body
     *  touching a zero-velocity kinematic — doesn't evict those contacts and
     *  fire false onCollisionExit every frame. */
    this._kinematicEventContacts = new Map();
    /** Per-dynamic "currently touching" set for dynamic<->dynamic and dynamic<->static
     *  pairs, used to fire onCollisionExit when the event queue reports started=false. */
    this._dynamicContacts = new Map();
    /** Per-kinematic entity: number of consecutive physics frames that
     *  Rapier's computedGrounded() has returned false. Used to implement
     *  GROUNDED_GRACE_FRAMES hysteresis so a single skipped snap-to-ground
     *  frame does not cause a visible ground→air→ground flicker. */
    this._ungroundedFrames = new Map();
    /** Rapier EventQueue used to drain collision/trigger events after each step */
    this._eventQueue = null;

    this._readyPromise = loadRapier().then((RAPIER) => {
      this.RAPIER = RAPIER;
      this.rapierWorld = new RAPIER.World({ x: 0, y: GRAVITY_Y });
      this.rapierWorld.lengthUnit = LENGTH_UNIT_PX_PER_METER;
      // true = drains intersection (sensor) events in addition to contact events
      this._eventQueue = new RAPIER.EventQueue(true);
      this._characterController = this.rapierWorld.createCharacterController(
        this._characterControllerOffset
      );

      // CRITICAL: Rapier's KinematicCharacterController defaults `up`
      // to positive-Y — but this engine is Y-DOWN (gravity = +GRAVITY_Y
      // above, screen-down = positive Y, matching Transform/Camera
      // everywhere else in the engine). Without this explicit setUp
      // call, Rapier computes its OWN internal ground/slope detection
      // (computedGrounded(), and the angle checked against
      // maxSlopeClimbAngle/minSlopeSlideAngle below) against exactly
      // the WRONG up direction — i.e. floors could be misread as
      // ceilings and vice versa at the Rapier level, before this
      // file's own normal-based classification (see
      // _syncKinematicMovement below) even runs. (0, -1) is "up" in
      // this engine's Y-down convention — negative Y is away from the
      // floor, against gravity.
      this._characterController.setUp({ x: 0, y: -1 });

      // Match Rapier's OWN slope handling to the SLOPE_LIMIT_DEG (45°)
      // constant used below for isOnSlope/groundAngle classification —
      // without this, Rapier runs its sweep/movement logic against
      // whichever internal default it happens to ship with, which is
      // not guaranteed to agree with what this file reports to
      // scripts: the character could physically be stopped by (or
      // allowed to climb) a slope at an angle that isOnSlope/
      // groundAngle disagrees with, since those are two independently
      // computed values. Setting both here keeps "can the character
      // actually walk up this slope" and "what does the script see via
      // this.controller.isGrounded/this.rigidbody.groundAngle" in sync
      // — the same 45° Unity uses as CharacterController.slopeLimit's
      // own default. minSlopeSlideAngle (auto-slide below this) is set
      // lower (30°) than maxSlopeClimbAngle so there's a walkable band
      // between "flat ground, no sliding" and "too steep to climb" —
      // matching Rapier's own documented example values.
      this._characterController.setMaxSlopeClimbAngle(SLOPE_LIMIT_DEG * DEG2RAD);
      this._characterController.setMinSlopeSlideAngle(SLOPE_SLIDE_LIMIT_DEG * DEG2RAD);

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
  step(world, dt, scriptSystem) {
    if (!this.ready) return;

    // Stash for _syncKinematicMovement, which runs below and needs both
    // to dispatch onCollision for kinematic-vs-static/kinematic contacts
    // (see the comment there for why Rapier's event queue misses those).
    this._stepWorld = world;
    this._stepScriptSystem = scriptSystem;

    const entities = world.query(TRANSFORM).filter(
      (e) => e.hasComponent(RIGIDBODY_2D) || e.hasComponent(COLLIDER_2D)
    );
    const seen = new Set();

    // Clamp dt to a maximum of 1/30s — when the tab is backgrounded or
    // the frame rate stutters, dt can spike to 0.5s+ and a kinematic
    // body's velocity*dt displacement becomes enormous, causing the
    // character-controller sweep to teleport the body or produce a huge
    // correction. Capping at 30fps-equivalent keeps every step's
    // movement bounded so the body never jumps through walls.
    const stepDt = Math.min(dt > 0 ? dt : 1 / 60, 1 / 30);
    for (const entity of entities) {
      seen.add(entity.id);
      this._syncEntity(entity, stepDt);
    }

    // remove Rapier bodies for entities that no longer have physics
    // components (or were destroyed)
    for (const [entityId, handle] of this._handles) {
      if (!seen.has(entityId)) {
        if (handle.collider) this._colliderHandleMap.delete(handle.collider.handle);
        this.rapierWorld.removeRigidBody(handle.body);
        if (handle.bodyType === BodyType.KINEMATIC) this._kinematicCount--;
        this._handles.delete(entityId);
      }
    }

    // Rebuild/refresh per-tilemap-cell static colliders so a painted
    // tilemap participates in the Rapier solve this step (see
    // _syncTilemapColliders). Done BEFORE the step so freshly painted
    // cells collide immediately, and after _syncEntity so a tilemap
    // entity's own Rigidbody2D/Collider2D (if any) is already in place.
    this._syncTilemapColliders(world);

    this.rapierWorld.timestep = stepDt;
    this.rapierWorld.step(this._eventQueue);

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
      // KINEMATIC: rb.velocityX/Y stay as the INTENDED input the
      // controller/Inspector/script set (they are NOT overwritten here
      // or by the sweep — see resolvedVelocityX/Y for the actual/blocked
      // movement). A KinematicPositionBased body has no meaningful
      // linvel() from Rapier's solver to read back here, since we drive
      // it via setNextKinematicTranslation rather than forces/velocity.
    }

    // Drain the event queue and dispatch collision / trigger events to
    // the ScriptSystem so user scripts receive onCollision, onTriggerEnter,
    // and onTriggerExit callbacks. Rapier only emits events for colliders
    // that opted in via setActiveEvents (done in _syncCollider above).
    if (this._eventQueue && scriptSystem) {
      this._eventQueue.drainCollisionEvents((handle1, handle2, started) => {
        const entityId1 = this._colliderHandleMap.get(handle1);
        const entityId2 = this._colliderHandleMap.get(handle2);
        if (!entityId1 || !entityId2) return;
        const entity1 = world.getEntity(entityId1);
        const entity2 = world.getEntity(entityId2);
        if (!entity1 || !entity2) return;

        // Determine sensor/trigger status from live Rapier collider objects.
        const coll1 = this.rapierWorld.getCollider(handle1);
        const coll2 = this.rapierWorld.getCollider(handle2);
        const isSensor = (coll1 && coll1.isSensor()) || (coll2 && coll2.isSensor());

        if (isSensor) {
          // Trigger event: fire on both entities for enter and exit.
          scriptSystem.fireTrigger(entityId1, entity2, world, started);
          scriptSystem.fireTrigger(entityId2, entity1, world, started);
        } else {
          // Solid collision dispatch.
          const h1 = this._handles.get(entityId1);
          const h2 = this._handles.get(entityId2);
          const kin1 = h1 && h1.bodyType === BodyType.KINEMATIC;
          const kin2 = h2 && h2.bodyType === BodyType.KINEMATIC;

          if (kin1 || kin2) {
            // One side is kinematic. Kinematic-vs-static and
            // kinematic-vs-kinematic contacts are handled entirely by the
            // character-controller sweep in _syncKinematicMovement — skip
            // those here to avoid double-firing.
            //
            // Dynamic-vs-kinematic MUST come through the event queue when
            // the kinematic is stationary: a zero-velocity kinematic's sweep
            // calls computeColliderMovement with desiredX/Y = 0 and the
            // snap-to-ground only sweeps downward, so a dynamic body moving
            // into the kinematic from any other direction never appears in
            // computedCollision() and would be silently missed without this.
            const dyn1 = h1 && h1.bodyType === BodyType.DYNAMIC;
            const dyn2 = h2 && h2.bodyType === BodyType.DYNAMIC;
            if (!(dyn1 || dyn2)) return; // kinematic-vs-static / kinematic-vs-kinematic: sweep only

            // Exactly one kinematic, one dynamic.
            const kinId    = kin1 ? entityId1 : entityId2;
            const dynId    = kin1 ? entityId2 : entityId1;
            const kinEnt   = kin1 ? entity1   : entity2;
            const dynEnt   = kin1 ? entity2   : entity1;

            if (!this._kinematicEventContacts.has(kinId)) {
              this._kinematicEventContacts.set(kinId, new Set());
            }
            const eventSet = this._kinematicEventContacts.get(kinId);

            if (started) {
              // Guard against double-fire: the sweep in _syncKinematicMovement
              // may have already fired onCollisionEnter this same step if the
              // kinematic was also moving toward the dynamic. Check
              // _kinematicContacts (which _syncKinematicMovement writes before
              // rapierWorld.step() runs) before firing.
              const sweepSet = this._kinematicContacts.get(kinId);
              const alreadyFired = sweepSet && sweepSet.has(dynId);
              // Register in the event set so _syncKinematicMovement preserves
              // this contact and does not fire a false onCollisionExit next frame.
              eventSet.add(dynId);
              // Mirror into _kinematicContacts so exit tracking is consistent.
              if (!sweepSet) this._kinematicContacts.set(kinId, new Set());
              this._kinematicContacts.get(kinId).add(dynId);
              if (!alreadyFired) {
                scriptSystem.fireCollision(kinId, dynEnt, world);
                scriptSystem.fireCollision(dynId, kinEnt, world);
              }
            } else {
              // Exit: only fire if we were actually tracking this contact.
              // (Rapier can sometimes emit stale exit events for pairs we
              // never saw enter — guard with the eventSet membership check.)
              if (!eventSet.has(dynId)) return;
              eventSet.delete(dynId);
              const kc = this._kinematicContacts.get(kinId);
              if (kc) kc.delete(dynId);
              scriptSystem.fireCollisionExit(kinId, dynEnt, world);
              scriptSystem.fireCollisionExit(dynId, kinEnt, world);
            }
          } else {
            // Pure dynamic<->dynamic or dynamic<->static: event queue is
            // reliable for both enter and exit.
            const pairKey = entityId1 < entityId2 ? entityId1 + '|' + entityId2 : entityId2 + '|' + entityId1;
            if (started) {
              this._dynamicContacts.set(pairKey, { id1: entityId1, id2: entityId2 });
              scriptSystem.fireCollision(entityId1, entity2, world);
              scriptSystem.fireCollision(entityId2, entity1, world);
            } else {
              this._dynamicContacts.delete(pairKey);
              scriptSystem.fireCollisionExit(entityId1, entity2, world);
              scriptSystem.fireCollisionExit(entityId2, entity1, world);
            }
          }
        }
      });
    }

    // The event queue above does NOT fire onCollision for kinematic-vs-
    // static/kinematic pairs when the body is STATIONARY \u2014 the character
    // controller keeps a small gap so no contact manifold is generated,
    // and a body that is spawned overlapping a collider (or resting on
    // one without moving this frame) never appears in the sweep's
    // computedCollision() list either. Probe those contacts here so
    // onCollisionEnter fires reliably regardless of whether the kinematic
    // body moved this step. Merges into the same _kinematicContacts set
    // the movement-sweep dispatch uses, so no pair is double-fired.
    this._dispatchKinematicCollisions(world, scriptSystem);
  }

  /**
   * O(1) check backed by _kinematicCount (kept in sync at every
   * _handles mutation site — see _syncEntity's needsNewBody/simulated
   * branches, the stale-handle sweep in step(), and clear() above) so
   * _dispatchKinematicCollisions can skip its whole scan on frames with
   * no kinematic bodies without walking _handles just to find out.
   */
  _hasKinematicBodies() {
    return this._kinematicCount > 0;
  }

  /**
   * Detects solid contacts for every KINEMATIC body via Rapier's
   * contactPair query (independent of movement), and fires onCollision
   * on the not-touching \u2192 touching transition. Catches stationary /
   * spawned-overlapping / tilemap contacts that the movement sweep
   * misses. Dynamic obstacles are skipped \u2014 the event queue already
   * delivers dynamic-vs-kinematic. Tilemap cell colliders are iterated
   * directly (they aren't in _colliderHandleMap) so kinematic-vs-tilemap
   * onCollisionEnter works too.
   */
  _dispatchKinematicCollisions(world, scriptSystem) {
    if (!this.ready || !scriptSystem) return;
    const RAPIER = this.RAPIER;

    // PERFORMANCE: this function used to unconditionally build the
    // `others` flat list (walking every entity collider AND every
    // tilemap cell collider) and then loop every tracked handle, EVERY
    // physics step — even for scenes with zero KINEMATIC bodies (the
    // common case: a scene with just Dynamic/Static physics, e.g. a
    // single falling box). That's pure wasted work: this function's
    // entire job is kinematic-vs-other contact probing, so with no
    // kinematic bodies there is nothing for it to do at all. Checking
    // first (a cheap flag flip, not a full scan — see
    // _hasKinematicBodies below) skips the list-build and scan entirely
    // on every frame that has no kinematic bodies.
    if (!this._hasKinematicBodies()) return;

    // Flat list of every other collider to test against: entity colliders
    // (reverse-mapped from handle \u2192 entityId) + tilemap cell colliders
    // (mapped to their owning tilemap entity id).
    const others = [];
    for (const [handle, entityId] of this._colliderHandleMap) {
      const col = this.rapierWorld.getCollider(handle);
      if (col) others.push({ collider: col, entityId });
    }
    for (const [tilemapId, cellMap] of this._tilemapCellColliders) {
      for (const collider of cellMap.values()) {
        others.push({ collider, entityId: tilemapId });
      }
    }

    for (const [entityId, handle] of this._handles) {
      if (handle.bodyType !== BodyType.KINEMATIC) continue;
      if (!handle.collider) continue;
      const selfCollider = handle.collider;

      // Start from whatever the movement-sweep dispatch already recorded
      // this step, so movement-detected contacts are preserved (and not
      // re-fired) while contactPair-only contacts are added on top.
      const prev = this._kinematicContacts.get(entityId) || new Set();
      const next = new Set(prev);

      for (const { collider: otherCollider, entityId: otherId } of others) {
        if (otherId === entityId) continue;
        let pair = null;
        try { pair = this.rapierWorld.contactPair(selfCollider, otherCollider); } catch (_) { continue; }
        if (!pair) continue;

        next.add(otherId);
        if (!prev.has(otherId)) {
          const me = world.getEntity(entityId);
          const other = world.getEntity(otherId);
          if (me && other) {
            scriptSystem.fireCollision(entityId, other, world);
            scriptSystem.fireCollision(otherId, me, world);
          }
        }
      }

      // Fire onCollisionExit for any IDs that were in prev but not in next
      for (const goneId of prev) {
        if (!next.has(goneId)) {
          const me = world.getEntity(entityId);
          const gone = world.getEntity(goneId);
          if (me && gone) {
            scriptSystem.fireCollisionExit(entityId, gone, world);
            scriptSystem.fireCollisionExit(goneId, me, world);
          }
        }
      }
      this._kinematicContacts.set(entityId, next);
    }
  }

  /**
   * Builds/refreshes one STATIC Rapier body per Tilemap entity and a
   * cuboid collider for every painted cell in Tilemap.cells, so a
   * painted tilemap acts as solid collision geometry in Play mode.
   * Cell world position = transform.x/y + (col+0.5)*tw, (row+0.5)*th,
   * matching TilemapSystem.js's per-tile placement, so a tilemap entity
   * can be moved and its solid cells follow. Erased cells (and whole
   * destroyed tilemap entities) have their colliders removed. If the
   * referenced Tileset's tile size changes, all of that tilemap's cell
   * colliders are rebuilt to the new size.
   */
  _syncTilemapColliders(world) {
    const RAPIER = this.RAPIER;
    const tilemapEntities = world.query(TRANSFORM, TILEMAP);
    const seenTilemaps = new Set();

    for (const entity of tilemapEntities) {
      seenTilemaps.add(entity.id);
      const transform = entity.getComponent(TRANSFORM);
      const tilemap = entity.getComponent(TILEMAP);

      const tilesetEntity = tilemap.tilesetEntityId ? world.getEntity(tilemap.tilesetEntityId) : null;
      const tileset = tilesetEntity ? tilesetEntity.getComponent(TILESET) : null;
      const tw = tileset ? tileset.tileWidth : 32;
      const th = tileset ? tileset.tileHeight : 32;
      const sizeSig = tw + "," + th;

      let body = this._tilemapBodies.get(entity.id);
      let cellColliders = this._tilemapCellColliders.get(entity.id);
      const prevSig = this._tilemapBodySig.get(entity.id);

      if (!body) {
        const desc = new RAPIER.RigidBodyDesc(RAPIER.RigidBodyType.Fixed)
          .setTranslation(transform.x, transform.y)
          .setRotation(transform.rotation * DEG2RAD);
        body = this.rapierWorld.createRigidBody(desc);
        this._tilemapBodies.set(entity.id, body);
        cellColliders = new Map();
        this._tilemapCellColliders.set(entity.id, cellColliders);
        this._tilemapBodySig.set(entity.id, sizeSig);
      } else {
        // keep the static body pinned to the entity's Transform so a
        // moved tilemap's solid cells follow it. Static bodies don't
        // simulate, so this is safe to apply every frame.
        body.setTranslation({ x: transform.x, y: transform.y }, true);
        body.setRotation(transform.rotation * DEG2RAD, true);

        // tile size changed -> drop all existing cell colliders so they
        // rebuild at the new size on the loop below.
        if (prevSig !== sizeSig) {
          for (const collider of cellColliders.values()) {
            this.rapierWorld.removeCollider(collider, true);
          }
          cellColliders.clear();
          this._tilemapBodySig.set(entity.id, sizeSig);
        }
      }

      const filledKeys = Object.keys(tilemap.cells);
      for (const key of filledKeys) {
        if (cellColliders.has(key)) continue;
        const comma = key.indexOf(",");
        const col = parseInt(key.slice(0, comma), 10);
        const row = parseInt(key.slice(comma + 1), 10);
        const cx = (col + 0.5) * tw;
        const cy = (row + 0.5) * th;
        const desc = RAPIER.ColliderDesc.cuboid(Math.max(0.01, tw / 2), Math.max(0.01, th / 2))
          .setTranslation(cx, cy)
          .setFriction(1)
          .setActiveCollisionTypes(
            RAPIER.ActiveCollisionTypes.ALL |
              RAPIER.ActiveCollisionTypes.KINEMATIC_KINEMATIC |
              RAPIER.ActiveCollisionTypes.KINEMATIC_STATIC
          );
        const collider = this.rapierWorld.createCollider(desc, body);
        cellColliders.set(key, collider);
      }

      // remove colliders for cells that were erased since last step.
      const filledSet = new Set(filledKeys);
      for (const [key, collider] of cellColliders) {
        if (!filledSet.has(key)) {
          this.rapierWorld.removeCollider(collider, true);
          cellColliders.delete(key);
        }
      }
    }

    // remove bodies for tilemap entities that were destroyed.
    for (const [entityId, body] of this._tilemapBodies) {
      if (!seenTilemaps.has(entityId)) {
        this.rapierWorld.removeRigidBody(body);
        this._tilemapBodies.delete(entityId);
        this._tilemapCellColliders.delete(entityId);
        this._tilemapBodySig.delete(entityId);
      }
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
        if (handle.collider) this._colliderHandleMap.delete(handle.collider.handle);
        this.rapierWorld.removeRigidBody(handle.body);
        if (handle.bodyType === BodyType.KINEMATIC) this._kinematicCount--;
        this._handles.delete(entity.id);
      }
      return;
    }

    const needsNewBody = !handle || handle.bodyType !== effectiveBodyType;

    if (needsNewBody) {
      if (handle) {
        if (handle.collider) this._colliderHandleMap.delete(handle.collider.handle);
        this.rapierWorld.removeRigidBody(handle.body);
        if (handle.bodyType === BodyType.KINEMATIC) this._kinematicCount--;
      }

      // Body type just changed (or is being created) — drop any
      // force/impulse/move request queued for a previous body type so
      // nothing carries over into a type that doesn't support it (e.g.
      // a force queued while Dynamic must not silently apply the
      // instant this entity becomes Dynamic again after a detour
      // through Kinematic).
      if (rb) {
        rb.pendingForceX = 0;
        rb.pendingForceY = 0;
        rb.pendingImpulseX = 0;
        rb.pendingImpulseY = 0;
        rb.pendingTorque = 0;
        rb.pendingAngularImpulse = 0;
        rb.pendingMoveX = null;
        rb.pendingMoveY = null;
      }

      const desc = new RAPIER.RigidBodyDesc(rapierBodyType(RAPIER, effectiveBodyType))
        .setTranslation(transform.x, transform.y)
        .setRotation(transform.rotation * DEG2RAD);

      const body = this.rapierWorld.createRigidBody(desc);
      handle = { body, collider: null, bodyType: effectiveBodyType, _colliderRef: null, _entityId: entity.id };
      this._handles.set(entity.id, handle);
      if (effectiveBodyType === BodyType.KINEMATIC) this._kinematicCount++;
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
        if (rb.driveVelocityX !== null || rb.driveVelocityY !== null || rb.driveAngularVelocity !== null) {
          const current = handle.body.linvel();
          const nextX = rb.driveVelocityX !== null ? rb.driveVelocityX : current.x;
          const nextY = rb.driveVelocityY !== null ? rb.driveVelocityY : current.y;
          handle.body.setLinvel({ x: nextX, y: nextY }, true);
          if (rb.driveAngularVelocity !== null) {
            handle.body.setAngvel(rb.driveAngularVelocity, true);
          }
          handle.body.wakeUp();
        }
        // These are one-shot, transient requests — clear them now that
        // they've been applied so a controller-less frame (or a
        // Free-type controller mid-script-drive) doesn't keep re-seeding
        // stale velocity forever.
        rb.driveVelocityX = null;
        rb.driveVelocityY = null;
        rb.driveAngularVelocity = null;

        // Drain any force/impulse/torque a script queued this frame via
        // DynamicRigidbodyAPI (scripting/components/RigidbodyAPI.js).
        //
        // IMPORTANT: Rapier's addForce/addTorque are NOT automatically
        // zeroed after a timestep (that changed in a past Rapier
        // release — see rapier.js's own CHANGELOG) — a force added once
        // stays in Rapier's internal accumulator and keeps being
        // applied EVERY step forever until resetForces()/resetTorques()
        // is called. Unity's Rigidbody2D.AddForce, which this API is
        // modeled on, works the opposite way: a force only acts for the
        // ONE FixedUpdate it was called in — sustaining a push means
        // calling AddForce again next frame. To match that expected
        // behavior (and avoid a single addForce call silently
        // accelerating a body forever), Rapier's accumulator is reset
        // FIRST every step, then this frame's queued force (if any) is
        // added back on top — so a script that stops calling addForce
        // actually stops accelerating the body, exactly like Unity.
        // Impulses are already one-shot by nature (instantaneous
        // velocity change) and need no such reset.
        handle.body.resetForces(true);
        handle.body.resetTorques(true);

        if (rb.pendingForceX !== 0 || rb.pendingForceY !== 0) {
          handle.body.addForce({ x: rb.pendingForceX, y: rb.pendingForceY }, true);
          rb.pendingForceX = 0;
          rb.pendingForceY = 0;
        }
        if (rb.pendingImpulseX !== 0 || rb.pendingImpulseY !== 0) {
          handle.body.applyImpulse({ x: rb.pendingImpulseX, y: rb.pendingImpulseY }, true);
          rb.pendingImpulseX = 0;
          rb.pendingImpulseY = 0;
        }
        if (rb.pendingTorque !== 0) {
          handle.body.addTorque(rb.pendingTorque, true);
          rb.pendingTorque = 0;
        }
        if (rb.pendingAngularImpulse !== 0) {
          handle.body.applyTorqueImpulse(rb.pendingAngularImpulse, true);
          rb.pendingAngularImpulse = 0;
        }
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
    // One-shot move() request queued by KinematicRigidbodyAPI.move(dx, dy)
    // (scripting/components/RigidbodyAPI.js) — added on top of this
    // frame's velocity-driven displacement so both go through the SAME
    // character-controller sweep below (blocked/slid by obstacles,
    // exactly like velocity movement), rather than a raw teleport that
    // could push the body through walls. Drained (reset to null)
    // immediately since it's a single-frame request, not a standing value.
    const extraMoveX = rb.pendingMoveX || 0;
    const extraMoveY = rb.pendingMoveY || 0;
    rb.pendingMoveX = null;
    rb.pendingMoveY = null;

    if (!handle.collider) {
      // No collider: a kinematic body with nothing to sweep against
      // still moves — just without collision detection (it passes
      // through everything). This is expected: the character-controller
      // sweep needs a collider to test against obstacles, so without one
      // the best we can do is apply the raw velocity. Add a Collider2D
      // if you want the body to be stopped by walls/floors.
      const desiredX = rb.velocityX * dt + extraMoveX;
      const desiredY = rb.velocityY * dt + extraMoveY;
      const current = handle.body.translation();
      handle.body.setNextKinematicTranslation({
        x: current.x + desiredX,
        y: current.y + desiredY,
      });
      if (!rb.lockRotation) {
        // Use transform.rotation as the base, not handle.body.rotation().
        // Scripts run before _syncKinematicMovement and write directly to
        // the Transform component ("this.rotation = ..."). If we read the
        // Rapier body's last-committed rotation instead, the script's change
        // is silently discarded: _syncKinematicMovement calls
        // setNextKinematicRotation with the old value, and after the step
        // line 292 overwrites transform.rotation with that same old value.
        // Reading transform.rotation here closes the loop so "this.rotation
        // += N" accumulates correctly each frame.
        const entity = this._stepWorld && this._stepWorld.getEntity(handle._entityId);
        const tf = entity && entity.getComponent(TRANSFORM);
        const baseRot = tf ? tf.rotation * DEG2RAD : handle.body.rotation();
        handle.body.setNextKinematicRotation(baseRot + rb.angularVelocity * dt);
      }
      rb.resolvedVelocityX = rb.velocityX;
      rb.resolvedVelocityY = rb.velocityY;
      rb.grounded = false;
      // No collider → no sweep → all contact-state flags must be
      // cleared so scripts don't read stale values from a previous
      // frame when the collider was present.
      rb.isOnCeiling = false;
      rb.isOnWall    = false;
      rb.isOnSlope   = false;
      rb.groundAngle = 0;
      return;
    }

    // Use this body's own Rigidbody2D.mass as the character mass for
    // impulse resolution — without this, setApplyImpulsesToDynamicBodies
    // still works but assumes mass 0 (no push at all) since a kinematic
    // body has no intrinsic mass of its own in Rapier's eyes.
    this._characterController.setCharacterMass(Math.max(0.0001, rb.mass));

    // Per-body angle thresholds (fallback to global defaults when not set
    // — old scenes that predate these fields will behave identically).
    const groundLimit = (rb.groundAngleLimit != null) ? rb.groundAngleLimit : SLOPE_LIMIT_DEG;
    const wallLimit   = (rb.wallAngleLimit   != null) ? rb.wallAngleLimit   : WALL_ANGLE_DEG;
    const slopeMin    = (rb.slopeMinAngle    != null) ? rb.slopeMinAngle    : 10;

    // Sync the character controller's own slope-climb limit so it matches
    // whatever the script set for groundAngleLimit — the controller uses
    // it to decide whether to slide or stop at a steep contact, and it
    // must stay consistent with our contact-classification below or the
    // body will be stopped by surfaces it also classifies as "not ground".
    this._characterController.setMaxSlopeClimbAngle(groundLimit * DEG2RAD);

    const desiredX = rb.velocityX * dt + extraMoveX;
    const desiredY = rb.velocityY * dt + extraMoveY;

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

    // Unity-style contact-state flags: isOnCeiling, isOnWall, isOnSlope,
    // groundAngle. Computed from the character-controller's own collision
    // normals (each normal points FROM the obstacle TOWARD the character,
    // i.e. "which way does this surface push the character away").
    //
    // Coordinate convention: this engine is Y-down (gravity = +Y). So a
    // floor's normal points UP = negative Y, and a ceiling's normal points
    // DOWN = positive Y.
    //
    // Per-body classification thresholds resolved earlier in this function.
    // groundLimit: contacts within this angle of up → walkable ground.
    // wallLimit:   contacts at or above this angle from up → genuine wall.
    // slopeMin:    minimum groundAngle to set isOnSlope.
    let onCeiling = false, onWall = false, onSlope = false;
    let groundAngle = 0;
    // hasGroundContact: true if ANY collision normal classifies as ground.
    // This is the PRIMARY source for isGrounded — it is stable even when
    // velocityY = 0 (zero downward movement means computedGrounded() can
    // return false while the body is plainly resting on a floor, which
    // causes the 0→10→0→10 gravity flicker loop when scripts read
    // isGrounded to gate their own gravity). computedGrounded() is used
    // only as a secondary signal for snap-to-ground cases where Rapier
    // detects ground contact through its internal probe rather than an
    // actual swept collision (e.g. very first frame of landing, or when
    // the body's velocity is zero but snap pulls it flush to the floor).
    let hasGroundContact = false;

    const numCols = this._characterController.numComputedCollisions();
    for (let ci = 0; ci < numCols; ci++) {
      const col = this._characterController.computedCollision(ci);
      if (!col) continue;
      // col.normal1 is the world-space outward normal ON THE OBSTACLE —
      // for a floor the character stands on it points straight up toward
      // the character. normal2 is local-space on the character's own
      // shape and is NOT what we want here.
      const normal = col.normal1;
      if (normal && typeof normal.y === "number") {
        // dot((nx,ny),(0,-1)) = -ny  →  angle = acos(-ny)  (Y-down world)
        const dotWithUp = Math.max(-1, Math.min(1, -normal.y));
        const angle = Math.acos(dotWithUp) * RAD2DEG;
        if (angle <= groundLimit) {
          // Ground or walkable slope — track the steepest angle seen.
          // isOnSlope is resolved after the loop so touching both flat
          // ground AND a slope simultaneously doesn't cause per-contact
          // flickering; only the steepest walkable normal decides.
          hasGroundContact = true;
          if (angle > groundAngle) groundAngle = angle;
        } else if (dotWithUp < 0) {
          // Normal has downward component → ceiling (pushes character down).
          onCeiling = true;
        } else if (angle >= wallLimit) {
          // Near-vertical surface → genuine wall.
          // Contacts between groundLimit and wallLimit are "too steep to
          // climb" but are NOT walls — they are unclimbable slopes.
          // Treating them as walls caused isOnWall to fire on ramps,
          // confusing wall-jump logic even with no vertical surface nearby.
          onWall = true;
        }
        // else: angle in (groundLimit, wallLimit) — unclimbable slope,
        // ignored for both ground AND wall state intentionally.
      }
    }

    // Dispatch onCollision for kinematic-vs-static and
    // kinematic-vs-kinematic contacts. Rapier's event queue does NOT emit
    // collision events for those pairs when the character controller is
    // involved — the sweep stops the body *before* it penetrates, so no
    // contact manifold is ever generated for the queue to drain. The
    // controller's own computedCollision() list DOES see those swept
    // contacts, so we dispatch onCollision from here. Dynamic obstacles
    // are skipped: dynamic-vs-kinematic is still delivered by the event
    // queue (the dynamic body's contact manifold), so firing here too
    // would double-fire. We track the currently-touching set per
    // kinematic body and only fire on the not-touching → touching
    // transition (enter), matching Unity's onCollision semantics and the
    // queue's own `started` gating in drainCollisionEvents.
    {
      const ssys = this._stepScriptSystem;
      const w = this._stepWorld;
      if (ssys && w) {
        const myId = handle._entityId;
        const prev = this._kinematicContacts.get(myId) || new Set();
        const next = new Set();
        for (let ci = 0; ci < numCols; ci++) {
          const col = this._characterController.computedCollision(ci);
          if (!col || col.collider == null) continue;
          // col.collider is a Rapier Collider object; _colliderHandleMap
          // is keyed by the integer collider.handle — using the object
          // directly as a key always misses (returns undefined) and
          // silently leaves `next` empty every frame, so onCollisionEnter
          // never fires for kinematic bodies regardless of movement.
          const otherId = this._colliderHandleMap.get(col.collider.handle);
          if (!otherId || otherId === myId) continue;
          // Dynamic obstacles are NO LONGER skipped here — the event
          // queue does NOT reliably fire for kinematic-vs-dynamic (the
          // character-controller gap prevents a real contact manifold),
          // so skipping them left "kinematic moves INTO a dynamic body"
          // with no onCollisionEnter at all. Now dispatched here; the
          // event queue's solid branch skips kinematic-involved pairs
          // (see drainCollisionEvents) to avoid double-firing.
          next.add(otherId);
          if (!prev.has(otherId)) {
            const me = w.getEntity(myId);
            const other = w.getEntity(otherId);
            if (me && other) {
              ssys.fireCollision(myId, other, w);
              ssys.fireCollision(otherId, me, w);
            }
          }
        }
        // Preserve contacts established by the event queue (dynamic bodies
        // that moved into this kinematic while it was stationary). Those
        // pairs are managed by drainCollisionEvents — the sweep can't see
        // them when velocity=0. Without this, next would be empty for a
        // stationary kinematic, the dynamic contact would not be in next,
        // and the sweep would fire a false onCollisionExit every frame.
        const eventContacts = this._kinematicEventContacts.get(myId) || new Set();
        for (const id of eventContacts) next.add(id);

        // Fire onCollisionExit for contacts that ended this sweep
        for (const goneId of prev) {
          if (!next.has(goneId)) {
            const me = w.getEntity(myId);
            const gone = w.getEntity(goneId);
            if (me && gone) {
              ssys.fireCollisionExit(myId, gone, w);
              ssys.fireCollisionExit(goneId, me, w);
            }
          }
        }
        this._kinematicContacts.set(myId, next);
      }
    }

    // Movement-based fallback — kept as a safety net for the rare case
    // a collision entry has no usable normal1 (e.g. a degenerate/zero
    // vector from an edge-case contact), NOT as the primary path
    // anymore now that normal1 above is read correctly and fires for
    // every normal collision.
    if (!onCeiling && !onWall && numCols > 0) {
      // Ceiling: tried to move up but was blocked from above.
      if (desiredY < -0.5 && corrected.y > desiredY + 1) onCeiling = true;
      // Wall: tried to move horizontally but motion was largely blocked.
      const absDesiredX = Math.abs(desiredX);
      if (absDesiredX > 0.5 && Math.abs(corrected.x) < absDesiredX * 0.3) onWall = true;
    }

    // isOnSlope: derive from groundAngle after ALL contacts are processed
    // (not per-contact) so touching flat ground + a slope simultaneously
    // doesn't cause per-contact flickering. Use per-body slopeMin so
    // floating-point noise on flat floors doesn't trigger isOnSlope.
    onSlope = groundAngle >= slopeMin;

    // isGrounded: contact-normal-based, NOT purely from computedGrounded().
    //
    // Why: computedGrounded() requires actual downward swept movement to
    // detect the floor. When a script reads isGrounded=true and sets
    // velocityY=0, the NEXT step has desiredY=0 — no downward sweep —
    // so computedGrounded() returns false. After GROUNDED_GRACE_FRAMES it
    // clears, gravity is applied (velocityY>0), the sweep fires again,
    // grounded goes true, script zeros velocity, repeat → the infamous
    // 0→10→0→10 flickering loop.
    //
    // hasGroundContact is derived from actual collision normals (which
    // Rapier reports even for a zero-velocity body resting on a floor)
    // and is therefore immune to this loop. computedGrounded() is kept
    // as a secondary signal only for the snap-to-ground probe edge case
    // (very first landing frame where a zero-area contact doesn't always
    // produce a usable normal1).
    const groundedFromContacts = hasGroundContact || grounded;

    rb.isOnCeiling = onCeiling;
    rb.isOnWall    = onWall;
    rb.isOnSlope   = groundedFromContacts && onSlope;
    rb.groundAngle = groundAngle;

    const current = handle.body.translation();
    handle.body.setNextKinematicTranslation({
      x: current.x + corrected.x,
      y: current.y + corrected.y,
    });

    if (!rb.lockRotation) {
      // Same transform.rotation-as-base logic as the no-collider path above:
      // scripts write to Transform before this runs; using handle.body.rotation()
      // would silently throw away that write every frame.
      const entity = this._stepWorld && this._stepWorld.getEntity(handle._entityId);
      const tf = entity && entity.getComponent(TRANSFORM);
      const baseRot = tf ? tf.rotation * DEG2RAD : handle.body.rotation();
      handle.body.setNextKinematicRotation(baseRot + rb.angularVelocity * dt);
    }

    // Report the ACTUAL (possibly blocked/slid) movement to the
    // resolved* fields so gameplay code (grounded checks, animation,
    // scripts asking "did I actually move this step?") sees what really
    // happened — WITHOUT clobbering velocityX/Y, which stay as the
    // intended input the controller/Inspector/script set.
    rb.resolvedVelocityX = dt > 0 ? corrected.x / dt : 0;
    rb.resolvedVelocityY = dt > 0 ? corrected.y / dt : 0;

    // Grounded hysteresis on top of the contact-normal result.
    // groundedFromContacts already eliminates the main flicker cause (the
    // zero-velocity / no-downward-sweep case). The grace frames here are
    // a second safety net for the rarer case where the contact list itself
    // is briefly empty for one frame (e.g. landing on a thin edge, a step
    // corner, or the first frame of the snap-to-ground snapping the body
    // down into a new contact). Without it, even contact-based grounded
    // can drop for a single frame when the sweep geometry is degenerate.
    const myId = handle._entityId;
    if (groundedFromContacts) {
      this._ungroundedFrames.set(myId, 0);
      rb.grounded = true;
    } else {
      const streak = (this._ungroundedFrames.get(myId) || 0) + 1;
      this._ungroundedFrames.set(myId, streak);
      if (streak >= GROUNDED_GRACE_FRAMES) rb.grounded = false;
      // else: body was grounded last frame and contacts just vanished —
      // keep grounded=true for up to GROUNDED_GRACE_FRAMES more frames
      // before accepting that the character is truly airborne.
    }
  }

  /**
   * Pushes every DYNAMIC body the kinematic mover collided with during
   * the last character-controller sweep, in the direction the kinematic
   * is moving — a bulldozer-style shove based on where the kinematic is
   * actually traveling, not just the contact normal.
   *
   * MASS-RATIO BUG FIX: this used to compute an impulse that forced the
   * hit body to EXACTLY the kinematic's own travel speed in a single
   * step, using only the target body's mass (impulse = otherMass *
   * deltaV) — the kinematic's OWN mass (rb.mass, the same field already
   * fed into setCharacterMass elsewhere in this file) never entered the
   * formula at all. The practical symptom: a 1-mass crate and a
   * 1000-mass boulder both got shoved to identical velocity by the same
   * kinematic push, because "how strong is the pusher" was never part
   * of the math — only "how much impulse does it take to move THIS
   * body to THAT speed", which is mass-independent from the pusher's
   * point of view (impulse = mass * deltaV is correct for reaching an
   * exact target speed, but using deltaV = full kinematic speed for
   * every body regardless of its own mass is what erased any sense of
   * "pushing something heavy is harder").
   *
   * Fix: scale how much of the kinematic's speed is actually transferred
   * per step by the pusher-to-pushed MASS RATIO
   * (rb.mass / (rb.mass + otherMass)), the same weighted-average shape
   * a real inelastic collision/contact resolves to. A pusher many times
   * heavier than the obstacle (ratio → 1) still shoves it up to full
   * speed almost immediately, matching the old "kinematic is
   * effectively unstoppable" feel for light obstacles. A pusher lighter
   * than or comparable to the obstacle (ratio → 0.5 or lower) now only
   * transfers a fraction of its speed per step, so heavier bodies
   * visibly lag behind / resist more, and continue easing toward full
   * speed over several steps rather than snapping to it in one. STATIC
   * and KINEMATIC obstacles are skipped entirely (impulses can't move
   * them, and a kinematic obstacle has no meaningful "mass" of its own
   * in Rapier's eyes to weigh against).
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

    // The pusher's own configured mass — this is what was missing
    // before. Rigidbody2D.mass on a Kinematic body has no effect on its
    // OWN motion (Rapier never integrates forces into a kinematic
    // body), but it's exactly the right knob for "how strong is this
    // pusher when it shoves something", so it's reused here instead of
    // adding a separate "push strength" field.
    const pusherMass = Math.max(0.0001, rb.mass);

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
      const remainingGap = speed - vAlong;
      if (remainingGap <= 1e-4) continue;

      const otherMass = Math.max(0.0001, otherBody.mass());

      // Mass-ratio transfer fraction: how much of the remaining gap to
      // this kinematic's speed gets closed THIS step. A much-heavier
      // pusher (pusherMass >> otherMass) closes nearly all of it every
      // step (ratio → 1), same feel as the old code for light obstacles.
      // A pusher that's lighter than or comparable to what it's hitting
      // closes only a fraction per step, so a heavy body visibly takes
      // longer (several steps) to spin up to the kinematic's speed —
      // and a MUCH heavier obstacle barely moves at all per step, since
      // the ratio approaches 0 as otherMass grows relative to pusherMass.
      const transferFraction = pusherMass / (pusherMass + otherMass);
      const deltaV = remainingGap * transferFraction;
      if (deltaV <= 1e-4) continue;

      // Impulse that closes exactly `deltaV` of the gap along the
      // travel direction (impulse = mass * delta-velocity).
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
   * A cheap per-frame dirty-check (primitive field comparisons, no
   * allocation) lets us skip the relatively expensive rebuild — and the
   * trig-heavy geometry computation that feeds it — when nothing
   * shape-affecting actually changed since last frame.
   */
  _syncCollider(handle, collider, transform) {
    const RAPIER = this.RAPIER;

    if (!collider) {
      if (handle.collider) {
        this.rapierWorld.removeCollider(handle.collider, true);
        handle.collider = null;
        handle._colliderRef = null;
      }
      return;
    }

    // PERFORMANCE: this used to call getColliderWorldGeometry() (trig:
    // sin/cos + scale math) AND build a JSON.stringify signature array
    // EVERY frame for EVERY physics entity, purely to detect "did
    // anything shape-affecting change" — even though a collider's
    // shape/offset/material almost never change after spawn (only
    // transform.rotation moves every frame for a spinning/rotating
    // body, and rotation doesn't even affect Box/Circle collider
    // geometry the way this signature is built). JSON.stringify in
    // particular allocates a fresh array + walks/escapes every field
    // into a string every single call — with even one Rigidbody2D in a
    // scene, that ran 60+ times a second for no reason, which is
    // exactly the "one physics object tanks FPS" symptom.
    //
    // Fix: compare the handful of primitive fields that can actually
    // change directly (a handful of === checks, no allocation at all),
    // and only call getColliderWorldGeometry() + rebuild the Rapier
    // collider on the rare frame something really did change.
    if (
      handle._colliderRef === collider &&
      handle._sigShape === collider.shape &&
      handle._sigOffsetX === collider.offsetX &&
      handle._sigOffsetY === collider.offsetY &&
      handle._sigWidth === collider.width &&
      handle._sigHeight === collider.height &&
      handle._sigRadius === collider.radius &&
      handle._sigCapsuleRadius === collider.capsuleRadius &&
      handle._sigCapsuleHalfHeight === collider.capsuleHalfHeight &&
      handle._sigTrianglePoints === collider.trianglePoints &&
      handle._sigIsTrigger === collider.isTrigger &&
      handle._sigFriction === collider.friction &&
      handle._sigRestitution === collider.restitution &&
      handle._sigDensity === collider.density &&
      handle._sigScaleX === transform.scaleX &&
      handle._sigScaleY === transform.scaleY
    ) {
      return; // nothing shape-affecting changed since last frame — skip entirely
    }

    const geo = getColliderWorldGeometry(collider, transform);

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

    // Cache the primitive fields the fast-path check above compares
    // next frame — see the dirty-check block near the top of this
    // method for why this replaced a JSON.stringify signature.
    handle._colliderRef = collider;
    handle._sigShape = collider.shape;
    handle._sigOffsetX = collider.offsetX;
    handle._sigOffsetY = collider.offsetY;
    handle._sigWidth = collider.width;
    handle._sigHeight = collider.height;
    handle._sigRadius = collider.radius;
    handle._sigCapsuleRadius = collider.capsuleRadius;
    handle._sigCapsuleHalfHeight = collider.capsuleHalfHeight;
    handle._sigTrianglePoints = collider.trianglePoints;
    handle._sigIsTrigger = collider.isTrigger;
    handle._sigFriction = collider.friction;
    handle._sigRestitution = collider.restitution;
    handle._sigDensity = collider.density;
    handle._sigScaleX = transform.scaleX;
    handle._sigScaleY = transform.scaleY;

    // Register the new collider in the reverse-lookup map so event
    // draining can find the owning entityId from Rapier's handle index.
    this._colliderHandleMap.set(handle.collider.handle, handle._entityId);

    // Opt this collider into the EventQueue so collision and sensor
    // (trigger) events are actually delivered — Rapier only emits events
    // for colliders that have explicitly requested them.
    handle.collider.setActiveEvents(this.RAPIER.ActiveEvents.COLLISION_EVENTS);
  }

  /** Removes every tracked Rapier body (used when the World/scene is cleared). */
  clear() {
    if (!this.ready) return;
    for (const handle of this._handles.values()) {
      this.rapierWorld.removeRigidBody(handle.body);
    }
    this._handles.clear();
    this._kinematicCount = 0;
    this._colliderHandleMap.clear();
    this._kinematicContacts.clear();
    this._kinematicEventContacts.clear();
    this._dynamicContacts.clear();
    this._ungroundedFrames.clear();
    for (const body of this._tilemapBodies.values()) {
      this.rapierWorld.removeRigidBody(body);
    }
    this._tilemapBodies.clear();
    this._tilemapCellColliders.clear();
    this._tilemapBodySig.clear();
  }

  destroy() {
    this.clear();
    this.rapierWorld = null;
    this.ready = false;
  }
}
