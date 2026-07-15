/**
 * runtime/core/Entity.js
 *
 * Plain entity record. An entity is just an id + name + tag + a bag of
 * components keyed by component type name. No rendering, no editor
 * concerns live here — this is pure data.
 *
 * RUNTIME-ONLY FILE. Do not import anything from /editor here.
 */

let _nextEntityId = 1;

export class Entity {
  /**
   * @param {string} name
   * @param {string} [tag]
   */
  constructor(name, tag) {
    this.id = "e" + (_nextEntityId++);
    this.name = name || "GameObject";
    this.tag = tag || "Untagged";
    this.active = true;

    /** @type {Map<string, object>} componentType -> component instance */
    this.components = new Map();
  }

  addComponent(typeName, component) {
    this.components.set(typeName, component);
    return component;
  }

  getComponent(typeName) {
    return this.components.get(typeName) || null;
  }

  hasComponent(typeName) {
    return this.components.has(typeName);
  }

  removeComponent(typeName) {
    return this.components.delete(typeName);
  }
}

/**
 * Reset the global id counter. Only ever used by scene loading when
 * starting a fresh scene, so ids stay predictable in a single run.
 */
export function resetEntityIdCounter() {
  _nextEntityId = 1;
}

/**
 * Bumps the global id counter to at least `minNext` (exclusive), so a
 * subsequently created entity never reuses an id that was explicitly
 * restored from a saved scene (see World.createEntity's optional id).
 * No-op when the counter is already ahead. Used only by scene loading.
 */
export function setEntityIdCounter(minNext) {
  if (_nextEntityId < minNext) _nextEntityId = minNext;
}
