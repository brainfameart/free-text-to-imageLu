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
 * Camera resolution, etc — see runtime/core/CameraUtils.js), so Rapier
 * is driven directly in pixel-scale units too (pixel-scale gravity,
 * pixel-scale collider sizes) rather than introducing a meters<->pixels
 * conversion layer that the rest of the engine doesn't have.
 *
 * RUNTIME-ONLY FILE.
 */

import { TRANSFORM } from "../components/Transform.js";
import { RIGIDBODY_2D, BodyType } from "../components/Rigidbody2D.js";
import { COLLIDER_2D, ColliderShape } from "../components/Collider2D.js";
import { loadRapier } from "./RapierLoader.js";

const GRAVITY_Y = 980; // px/s^2 downward — same constant the old stub integrator used

const DEG2RAD = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;

function rapierBodyType(RAPIER, bodyType) {
  switch (bodyType) {
    case BodyType.STATIC:
      return RAPIER.RigidBodyType.Fixed;
    case BodyType.KINEMATIC:
      return RAPIER.RigidBodyType.KinematicVelocityBased;
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

    this._readyPromise = loadRapier().then((RAPIER) => {
      this.RAPIER = RAPIER;
      this.rapierWorld = new RAPIER.World({ x: 0, y: GRAVITY_Y });
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

    for (const entity of entities) {
      seen.add(entity.id);
      this._syncEntity(entity);
    }

    // remove Rapier bodies for entities that no longer have physics
    // components (or were destroyed)
    for (const [entityId, handle] of this._handles) {
      if (!seen.has(entityId)) {
        this.rapierWorld.removeRigidBody(handle.body);
        this._handles.delete(entityId);
      }
    }

    this.rapierWorld.timestep = dt > 0 ? dt : 1 / 60;
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

      const vel = handle.body.linvel();
      rb.velocityX = vel.x;
      rb.velocityY = vel.y;
      rb.angularVelocity = handle.body.angvel();
    }
  }

  /**
   * Ensures entity has a matching Rapier body/collider whose settings
   * match its current components, creating or recreating as needed, and
   * pushes any editor-driven Transform/velocity changes onto the body.
   */
  _syncEntity(entity) {
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
      } else if (effectiveBodyType === BodyType.KINEMATIC) {
        handle.body.setLinvel({ x: rb.velocityX, y: rb.velocityY }, true);
        handle.body.setAngvel(rb.lockRotation ? 0 : rb.angularVelocity, true);
      }
    }

    this._syncCollider(handle, collider);
  }

  /**
   * Creates/recreates the Rapier collider attached to `handle.body` to
   * match the Collider2D component. A signature string lets us skip
   * the (relatively expensive) recreate when nothing shape-related
   * actually changed.
   */
  _syncCollider(handle, collider) {
    const RAPIER = this.RAPIER;

    if (!collider) {
      if (handle.collider) {
        this.rapierWorld.removeCollider(handle.collider, true);
        handle.collider = null;
        handle.colliderSig = null;
      }
      return;
    }

    const sig = JSON.stringify([
      collider.shape,
      collider.width,
      collider.height,
      collider.radius,
      collider.offsetX,
      collider.offsetY,
      collider.isTrigger,
      collider.friction,
      collider.restitution,
      collider.density,
    ]);

    if (handle.colliderSig === sig) return; // unchanged, skip rebuild

    if (handle.collider) {
      this.rapierWorld.removeCollider(handle.collider, true);
      handle.collider = null;
    }

    let desc;
    if (collider.shape === ColliderShape.CIRCLE) {
      desc = RAPIER.ColliderDesc.ball(Math.max(0.01, collider.radius));
    } else {
      desc = RAPIER.ColliderDesc.cuboid(
        Math.max(0.01, collider.width / 2),
        Math.max(0.01, collider.height / 2)
      );
    }

    desc
      .setTranslation(collider.offsetX, collider.offsetY)
      .setSensor(!!collider.isTrigger)
      .setFriction(collider.friction)
      .setRestitution(collider.restitution)
      .setDensity(collider.density);

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
