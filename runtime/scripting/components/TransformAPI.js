/**
 * runtime/scripting/components/TransformAPI.js
 *
 * The `this.transform` sub-object exposed to user scripts (see
 * scripting/ScriptAPI.js). One file per scripting component so each
 * can grow independently without turning ScriptAPI.js into a huge
 * grab-bag file (RULES.txt scripting/ folder convention).
 *
 * All property access reads/writes the entity's LIVE Transform
 * component data via closures over `entity` — there is no caching or
 * snapshotting, so `this.transform.position = {x, y}` takes effect
 * immediately.
 *
 * RUNTIME-ONLY FILE.
 */

import { TRANSFORM } from "../../components/Transform.js";

/**
 * Builds the `this.transform` object for a given entity.
 * @param {import('../../core/World.js').Entity} entity
 * @returns {object}
 */
export function createTransformAPI(entity) {
  return {
    get position() {
      var t = entity.getComponent(TRANSFORM);
      return t ? { x: t.x, y: t.y } : { x: 0, y: 0 };
    },
    set position(v) {
      var t = entity.getComponent(TRANSFORM);
      if (t) { t.x = v.x; t.y = v.y; }
    },
    get rotation() {
      var t = entity.getComponent(TRANSFORM);
      return t ? t.rotation : 0;
    },
    set rotation(v) {
      var t = entity.getComponent(TRANSFORM);
      if (t) t.rotation = v;
    },
    get scale() {
      var t = entity.getComponent(TRANSFORM);
      return t ? { x: t.scaleX, y: t.scaleY } : { x: 1, y: 1 };
    },
    set scale(v) {
      var t = entity.getComponent(TRANSFORM);
      if (t) { t.scaleX = v.x; t.scaleY = v.y; }
    },
    translate: function (dx, dy) {
      var t = entity.getComponent(TRANSFORM);
      if (t) { t.x += dx; t.y += dy; }
    },
    lookAt: function (x, y) {
      var t = entity.getComponent(TRANSFORM);
      if (t) t.rotation = Math.atan2(y - t.y, x - t.x) * 180 / Math.PI;
    },
  };
}
