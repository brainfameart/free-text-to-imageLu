/**
 * runtime/scripting/ScriptAPI.js
 *
 * The small set of globals exposed to user game scripts. Scripts never
 * touch World/Entity classes directly — they go through this API so the
 * underlying ECS can change without breaking user code.
 *
 * Currently minimal: extend this file (not the World/Entity classes)
 * when adding new scripting capabilities such as forever(), globalVar,
 * or dontDestroyOnLoad(). See /RULES.txt before adding new APIs here.
 *
 * RUNTIME-ONLY FILE.
 */

export class ScriptAPI {
  /**
   * @param {import('../core/World.js').World} world
   */
  constructor(world) {
    this.world = world;
    this._globals = new Map();
  }

  findByName(name) {
    return this.world.findFirstByName(name);
  }

  findByTag(tag) {
    return this.world.findByTag(tag);
  }

  /** Simple cross-scene persistent variable store. */
  setGlobal(key, value) {
    this._globals.set(key, value);
  }

  getGlobal(key) {
    return this._globals.has(key) ? this._globals.get(key) : undefined;
  }
}
