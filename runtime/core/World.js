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

import { Entity, resetEntityIdCounter } from "./Entity.js";

export class World {
  constructor() {
    /** @type {Map<string, Entity>} */
    this.entities = new Map();

    /** @type {import('./System.js').System[]} */
    this.systems = [];

    this.sceneName = "Untitled Scene";
  }

  /**
   * Wipes all entities. Used when loading a new scene.
   */
  clear() {
    this.entities.clear();
    resetEntityIdCounter();
  }

  createEntity(name, tag) {
    const e = new Entity(name, tag);
    this.entities.set(e.id, e);
    return e;
  }

  destroyEntity(id) {
    return this.entities.delete(id);
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
