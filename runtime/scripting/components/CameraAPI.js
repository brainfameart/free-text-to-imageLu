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

function _tag(err, kind) {
  err.kind = kind;
  return err;
}

/** Throws a descriptive error when a script calls this.camera on an entity
 *  without a Camera component. */
function _requireCamera(entity) {
  var c = entity.getComponent(CAMERA);
  if (!c) throw _tag(new Error(
    "'" + (entity.name || "Entity") + "' called this.camera but has no Camera component. " +
    "Add one in the Inspector (Add Component → Camera)."
  ), "missing-component");
  return c;
}

const CAMERA_MEMBERS = new Set(["zoom", "shake"]);

/**
 * Builds the `this.camera` object for a given entity.
 * `zoom` maps to `Camera.size`: default size=5 is zoom=1 (no scaling).
 * Smaller size → zoomed in (zoom > 1). Larger size → zoomed out (zoom < 1).
 * RenderSystem._applyMainCameraOffset applies this as a PIXI container scale,
 * so changes are visible in play mode immediately.
 * @param {import('../../core/World.js').Entity} entity
 * @returns {object}
 */
export function createCameraAPI(entity) {
  const target = {
    /** Camera size (zoom level). Default 5 = no zoom. Smaller = zoomed in, larger = zoomed out. */
    get zoom() { return _requireCamera(entity).size; },
    set zoom(v) { _requireCamera(entity).size = Math.max(0.001, v); },
    shake: function (intensity, duration) {
      // Guard: throw if the entity has no Camera component, consistent
      // with every other camera API method.
      _requireCamera(entity);
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
  return new Proxy(target, {
    get: function (t, prop) {
      if (typeof prop === "symbol" || prop === "then") return t[prop];
      if (!(prop in t) && !CAMERA_MEMBERS.has(String(prop))) {
        throw _tag(new Error(
          "this.camera." + String(prop) + " does not exist. Check the spelling — " +
          "valid members are: " + Array.from(CAMERA_MEMBERS).join(", ") + "."
        ), "unknown-api");
      }
      var v = t[prop];
      return typeof v === "function" ? v.bind(t) : v;
    },
    set: function (t, prop, value) {
      var key = String(prop);
      if (!(key in t) && !CAMERA_MEMBERS.has(key)) {
        throw _tag(new Error(
          "this.camera." + key + " does not exist. Check the spelling — " +
          "valid members are: " + Array.from(CAMERA_MEMBERS).join(", ") + "."
        ), "unknown-api");
      }
      // Without this file having had a set trap at all before, writing
      // to this.camera.shake (a method, not a property — get-only by
      // nature of being a function) would fall through to JS's own
      // raw, untagged "Cannot assign to read only property" TypeError.
      // See AnimatorAPI.js's set trap for the same pattern.
      var descriptor = Object.getOwnPropertyDescriptor(t, key);
      if (descriptor && typeof t[key] === "function") {
        throw _tag(new Error(
          "this.camera." + key + " is a method, not a settable property — call it as this.camera." + key + "(...) instead of assigning to it."
        ), "unknown-api");
      }
      t[key] = value;
      return true;
    },
  });
}
