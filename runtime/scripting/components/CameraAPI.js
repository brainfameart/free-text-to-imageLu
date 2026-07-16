/**
 * runtime/scripting/components/CameraAPI.js
 *
 * The `this.camera` sub-object exposed to user scripts (see
 * scripting/ScriptAPI.js). One file per scripting component — see
 * TransformAPI.js's header comment for the general rationale.
 *
 * RUNTIME-ONLY FILE.
 */

import { TRANSFORM } from "../../components/Transform.js";
import { CAMERA } from "../../components/Camera.js";

/**
 * Builds the `this.camera` object for a given entity.
 * @param {import('../../core/World.js').Entity} entity
 * @returns {object}
 */
export function createCameraAPI(entity) {
  return {
    get zoom() { var c = entity.getComponent(CAMERA); return c ? c.size : 5; },
    set zoom(v) { var c = entity.getComponent(CAMERA); if (c) c.size = v; },
    shake: function (intensity, duration) {
      // Simple camera shake: apply a transient random offset to the
      // camera entity's Transform for a short time. A dedicated shake
      // system could be added later for smoother results.
      var t = entity.getComponent(TRANSFORM);
      if (!t) return;
      var origX = t.x, origY = t.y;
      var start = Date.now();
      var ms = (duration || 0.3) * 1000;
      function step() {
        var elapsed = Date.now() - start;
        if (elapsed >= ms) { t.x = origX; t.y = origY; return; }
        var decay = 1 - elapsed / ms;
        t.x = origX + (Math.random() - 0.5) * (intensity || 10) * decay;
        t.y = origY + (Math.random() - 0.5) * (intensity || 10) * decay;
        requestAnimationFrame(step);
      }
      step();
    },
  };
}
