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

const CAMERA_MEMBERS = new Set([
  "zoom", "shake", "renderToSprite",
  "backgroundColor",
  "x", "y",
  "follow", "stopFollow",
  "offsetX", "offsetY",
]);

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
  // Per-instance follow state — lives here so stopFollow() can cancel the
  // exact rAF loop follow() started without needing any external registry.
  var _followState = null;

  const target = {
    /** Camera size (zoom level). Default 5 = no zoom. Smaller = zoomed in, larger = zoomed out. */
    get zoom() { return _requireCamera(entity).size; },
    set zoom(v) { _requireCamera(entity).size = Math.max(0.001, v); },

    /** Background/clear color as a hex string, e.g. "#1a1a2e". */
    get backgroundColor() { return _requireCamera(entity).backgroundColor; },
    set backgroundColor(v) { _requireCamera(entity).backgroundColor = v; },

    /** Camera world-space X position (same as this.x on the camera entity). */
    get x() { var t = entity.getComponent(TRANSFORM); return t ? t.x : 0; },
    set x(v) { var t = entity.getComponent(TRANSFORM); if (t) t.x = v; },

    /** Camera world-space Y position (same as this.y on the camera entity). */
    get y() { var t = entity.getComponent(TRANSFORM); return t ? t.y : 0; },
    set y(v) { var t = entity.getComponent(TRANSFORM); if (t) t.y = v; },

    /**
     * Renders this camera's view onto the given sprite entity's texture
     * every frame (a minimap / security-camera feed). Pass an entity
     * returned by find() (e.g. this.camera.renderToSprite(find('Minimap'))).
     * The sprite's existing texture is replaced each frame with a live
     * RenderTexture of what this camera sees. Call with null to stop.
     */
    renderToSprite: function (spriteEntity) {
      var c = _requireCamera(entity);
      if (spriteEntity == null) { c.renderToSpriteEntityId = null; return; }
      // Accept an EntityContext (what find() returns — has _entity.id)
      // or a raw entity (has .id directly).
      var id = spriteEntity._entity ? spriteEntity._entity.id : spriteEntity.id;
      if (!id) {
        throw _tag(new Error(
          "camera.renderToSprite(spriteEntity) — pass an entity returned by find(), e.g. find('Minimap')."
        ), "unknown-api");
      }
      c.renderToSpriteEntityId = id;
    },

    /**
     * Shake the camera with a random positional offset that decays over time.
     * intensity — peak shake radius in px (default 10).
     * duration  — how long the shake lasts in seconds (default 0.3).
     *   this.camera.shake(8, 0.5);
     */
    shake: function (intensity, duration) {
      _requireCamera(entity);
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

    /**
     * Smoothly follow a target entity every frame — keeps this camera
     * centered on `target` (offset by offsetX/offsetY if given) with
     * optional lerp smoothing.
     *
     *   this.camera.follow(find("Player"));
     *   this.camera.follow(find("Player"), { smoothing: 0.1, offsetX: 0, offsetY: -40 });
     *   this.camera.follow(find("Player"), { snap: true }); // instant, no lerp
     *
     * opts.smoothing — 0–1 lerp factor per 60 fps frame (default 0.1).
     *                  Higher = snappier; 1 or snap:true = instant.
     * opts.offsetX   — horizontal offset from target center in world px (default 0).
     * opts.offsetY   — vertical offset from target center in world px (default 0).
     * opts.snap      — if true, camera teleports to target each frame (no lerp).
     *
     * Call this.camera.stopFollow() to stop, or pass null as target.
     */
    follow: function (entityTarget, opts) {
      _requireCamera(entity);
      // Passing null is a shorthand for stopFollow().
      if (entityTarget == null) {
        if (_followState) { _followState.active = false; _followState = null; }
        return;
      }
      opts = opts || {};
      // Cancel any existing follow loop before starting a new one.
      if (_followState) _followState.active = false;
      var state = {
        active: true,
        target: entityTarget,
        smoothing: opts.smoothing != null ? opts.smoothing : 0.1,
        offsetX: opts.offsetX || 0,
        offsetY: opts.offsetY || 0,
        snap: !!opts.snap,
      };
      _followState = state;
      function tick() {
        if (!state.active) return;
        var t = entity.getComponent(TRANSFORM);
        if (!t) { state.active = false; return; }
        var tx, ty;
        try {
          tx = state.target.x + state.offsetX;
          ty = state.target.y + state.offsetY;
        } catch (_) {
          // Target entity was destroyed / no longer readable — stop following.
          state.active = false;
          return;
        }
        if (state.snap || state.smoothing >= 1) {
          t.x = tx;
          t.y = ty;
        } else {
          // Lerp per browser frame. Multiply by 60 so smoothing=0.1 means
          // "10% per 60-fps frame" — the conventional Unity-style smoothing
          // value most devs expect.
          var lerp = Math.min(1, state.smoothing * 60 * (1 / 60));
          t.x += (tx - t.x) * lerp;
          t.y += (ty - t.y) * lerp;
        }
        requestAnimationFrame(tick);
      }
      requestAnimationFrame(tick);
    },

    /**
     * Stop a camera.follow() already in progress. Safe to call even when
     * not currently following anything (does nothing in that case).
     *   this.camera.stopFollow();
     */
    stopFollow: function () {
      _requireCamera(entity);
      if (_followState) { _followState.active = false; _followState = null; }
    },

    /**
     * Get/set the X offset of an active camera.follow(). Lets you shift the
     * look-ahead direction without restarting the follow loop:
     *   this.camera.offsetX = this.rigidbody.velocityX > 0 ? 80 : -80;
     */
    get offsetX() { return _followState ? _followState.offsetX : 0; },
    set offsetX(v) { if (_followState) _followState.offsetX = v; },

    get offsetY() { return _followState ? _followState.offsetY : 0; },
    set offsetY(v) { if (_followState) _followState.offsetY = v; },
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
      var descriptor = Object.getOwnPropertyDescriptor(t, key);
      if (descriptor && !descriptor.set && typeof t[key] === "function") {
        throw _tag(new Error(
          "this.camera." + key + " is a method, not a settable property — call it as this.camera." + key + "(...) instead of assigning to it."
        ), "unknown-api");
      }
      t[key] = value;
      return true;
    },
  });
}
