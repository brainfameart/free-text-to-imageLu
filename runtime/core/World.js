/**
 * runtime/core/World.js
 *
 * The World owns every Entity and every System. It has no idea an editor
 * exists. The editor reads/writes into a World instance through the
 * runtime's public API only (see runtime/index.js) — it never reaches
 * into private fields.
 *
 * RUNTIME-ONLY FILE.
 */

import { Entity, resetEntityIdCounter, setEntityIdCounter } from "./Entity.js";

export class World {
  constructor() {
    /** @type {Map<string, Entity>} */
    this.entities = new Map();

    /** @type {import('./System.js').System[]} */
    this.systems = [];

    this.sceneName = "Untitled Scene";

    // Entities queued for destruction this frame (see queueDestroy()'s
    // doc comment for why destruction is deferred rather than
    // immediate — matches Unity's Destroy() semantics).
    /** @type {Set<string>} */
    this._pendingDestroy = new Set();
  }

  /**
   * Wipes all entities. Used when loading a new scene.
   */
  clear() {
    this.entities.clear();
    this._pendingDestroy.clear();
    resetEntityIdCounter();
  }

  /**
   * Creates an entity. Pass `id` to RESTORE a specific id from a saved
   * scene (deserializeScene) — required because cross-entity references
   * (e.g. a Tilemap pointing at its Tileset entity by id) only survive
   * a load if the ids are preserved verbatim. When omitted, a fresh
   * auto-incremented id is generated as before.
   */
  createEntity(name, tag, id) {
    const e = new Entity(name, tag);
    if (id) {
      e.id = id;
      // Keep the auto-increment counter ahead of the restored id so
      // the next entity created normally never collides with it.
      const n = parseInt(id.slice(1), 10);
      if (!Number.isNaN(n)) setEntityIdCounter(n + 1);
    }
    this.entities.set(e.id, e);
    return e;
  }

  destroyEntity(id) {
    return this.entities.delete(id);
  }

  /**
   * Marks an entity for destruction at the END of this frame, rather
   * than removing it immediately — the same deferred semantics as
   * Unity's Destroy(). This matters because destruction can be
   * requested from the MIDDLE of a frame — e.g. a script's own
   * onUpdate(), or an onCollision(other) callback fired while
   * PhysicsSystem is mid-step — and immediately splicing the entity out
   * of world.entities right then would yank it out from under whatever
   * system or query is currently iterating (a Map can be safely deleted
   * from mid-for-of in JS, but OTHER code later in the same frame that
   * already captured a reference to this entity — e.g. ScriptSystem's
   * own instances Map for it, or a second collision callback about to
   * fire for the same pair this physics step — would then be working
   * against a half-torn-down object). Unity's own behavior is
   * identical: a destroyed object is still fully valid for the rest of
   * the current frame's calls, and is only actually gone starting next
   * frame.
   *
   * Actual cleanup — including firing onDestroy on the entity's own
   * scripts — happens in flushDestroyed(), called once per frame by
   * ScriptSystem.update() (see systems/ScriptSystem.js) AFTER every
   * system (physics, controller, animation, render, scripts) has
   * finished its own pass for this frame, so nothing reads a
   * half-destroyed entity mid-frame.
   * @param {string} id
   */
  queueDestroy(id) {
    if (this.entities.has(id)) this._pendingDestroy.add(id);
  }

  /**
   * True if this entity has been queued for destruction this frame
   * (via queueDestroy) but hasn't been removed yet. Systems that would
   * otherwise keep acting on a "zombie" entity for the remainder of the
   * frame (e.g. starting a NEW collision response, or spawning
   * something from it) can check this and skip; existing per-frame
   * behavior already in flight (an onUpdate call already in progress
   * this frame) is intentionally left alone — see queueDestroy()'s doc
   * comment for why that matches Unity's own Destroy() semantics.
   * @param {string} id
   */
  isPendingDestroy(id) {
    return this._pendingDestroy.has(id);
  }

  /**
   * Actually removes every entity queued via queueDestroy() since the
   * last flush. Returns the list of removed entities (NOT ids) so the
   * caller (ScriptSystem) can still reach their Script component/name
   * for cleanup and error reporting after they're gone from
   * world.entities.
   * @returns {Entity[]}
   */
  flushDestroyed() {
    if (this._pendingDestroy.size === 0) return [];
    const removed = [];
    for (const id of this._pendingDestroy) {
      const entity = this.entities.get(id);
      if (entity) removed.push(entity);
      this.entities.delete(id);
    }
    this._pendingDestroy.clear();
    return removed;
  }

  getEntity(id) {
    return this.entities.get(id) || null;
  }

  /** @returns {Entity[]} */
  getAllEntities() {
    return Array.from(this.entities.values());
  }

  /** @returns {Entity[]} entities that own every component type listed */
  query(...componentTypes) {
    const out = [];
    for (const entity of this.entities.values()) {
      if (!entity.active) continue;
      let ok = true;
      for (const t of componentTypes) {
        if (!entity.hasComponent(t)) {
          ok = false;
          break;
        }
      }
      if (ok) out.push(entity);
    }
    return out;
  }

  findByTag(tag) {
    return this.getAllEntities().filter((e) => e.tag === tag);
  }

  findFirstByName(name) {
    return this.getAllEntities().find((e) => e.name === name) || null;
  }

  addSystem(system) {
    this.systems.push(system);
    if (typeof system.onAdded === "function") system.onAdded(this);
    return system;
  }

  /**
   * Runs every system's update once. Called by the GameLoop each tick.
   * @param {number} dt seconds since last tick
   */
  update(dt) {
    for (const system of this.systems) {
      if (typeof system.update === "function") system.update(this, dt);
    }
  }
}
