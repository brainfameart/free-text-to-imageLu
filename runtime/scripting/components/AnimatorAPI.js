/**
 * runtime/scripting/components/AnimatorAPI.js
 *
 * The `this.animator` sub-object exposed to user scripts (see
 * scripting/ScriptAPI.js). One file per scripting component — see
 * TransformAPI.js's header comment for the general rationale.
 *
 * RUNTIME-ONLY FILE.
 */

import { SPRITE_ANIMATION } from "../../components/SpriteAnimation.js";

function _tag(err, kind) {
  err.kind = kind;
  return err;
}

/** Throws a descriptive error when a script calls this.animator on an entity
 *  without a Sprite Animation component. */
function _requireAnimator(entity) {
  var a = entity.getComponent(SPRITE_ANIMATION);
  if (!a) throw _tag(new Error(
    "'" + (entity.name || "Entity") + "' called this.animator but has no Sprite Animation component. " +
    "Add one in the Inspector (Add Component → Sprite Animation)."
  ), "missing-component");
  return a;
}

const ANIMATOR_MEMBERS = new Set(["play", "stop", "playing", "currentClip"]);

/**
 * Builds the `this.animator` object for a given entity.
 * Accessing any method/property throws a clear error if the entity has
 * no Sprite Animation component. Accessing an unknown property (typo)
 * throws a distinct "does not exist" error rather than returning
 * undefined and failing later with a confusing "not a function".
 * @param {import('../../core/World.js').Entity} entity
 * @returns {object}
 */
export function createAnimatorAPI(entity) {
  const target = {
    /** Play a named animation clip. Throws if no Sprite Animation component. */
    play: function (clipName) {
      var anim = _requireAnimator(entity);
      if (!anim.clips) return;
      var clip = anim.clips.find(function (c) { return c.name === clipName; });
      if (clip) {
        anim.currentClipId = clip.id;
        anim.playing = true;
        anim.frameElapsed = 0;
        anim.currentFrameIndex = 0;
      } else if (typeof console !== "undefined") {
        console.warn("[Animator] No clip named '" + clipName + "' on '" + (entity.name || "Entity") + "'.");
      }
    },
    /** Stop the current animation. Throws if no Sprite Animation component. */
    stop: function () {
      _requireAnimator(entity).playing = false;
    },
    /** True while an animation is playing (read-only). */
    get playing() {
      var anim = _requireAnimator(entity);
      return !!anim.playing;
    },
    /** The name of the currently active clip (read-only). */
    get currentClip() {
      var anim = _requireAnimator(entity);
      var clip = anim.clips ? anim.clips.find(function (c) { return c.id === anim.currentClipId; }) : null;
      return clip ? clip.name : null;
    },
  };
  return new Proxy(target, {
    get: function (t, prop) {
      if (typeof prop === "symbol" || prop === "then") return t[prop];
      if (!(prop in t) && !ANIMATOR_MEMBERS.has(String(prop))) {
        throw _tag(new Error(
          "this.animator." + String(prop) + " does not exist. Check the spelling — " +
          "valid members are: " + Array.from(ANIMATOR_MEMBERS).join(", ") + "."
        ), "unknown-api");
      }
      var v = t[prop];
      return typeof v === "function" ? v.bind(t) : v;
    },
    set: function (t, prop, value) {
      var key = String(prop);
      if (!(key in t) && !ANIMATOR_MEMBERS.has(key)) {
        throw _tag(new Error(
          "this.animator." + key + " does not exist. Check the spelling — " +
          "valid members are: " + Array.from(ANIMATOR_MEMBERS).join(", ") + "."
        ), "unknown-api");
      }
      // Read-only guard: without a Proxy set trap at all (as this file
      // had before), assigning to a getter-only property (playing,
      // currentClip) falls through to JS's own default behavior and
      // throws a raw, untagged "Cannot set property X ... which has
      // only a getter" TypeError — technically correct, but it isn't
      // written for a script author and ScriptSystem can't classify it
      // into a specific console message. Checking the descriptor here
      // catches it first with a clear, tagged, actionable error, and
      // self-maintains if more read-only fields are added later.
      var descriptor = Object.getOwnPropertyDescriptor(t, key);
      if (descriptor && descriptor.get && !descriptor.set) {
        throw _tag(new Error(
          "this.animator." + key + " is read-only — it reflects the animation's real state and can't be set directly." +
          (key === "playing" ? " Use this.animator.play(clipName) or this.animator.stop() instead." : "")
        ), "unknown-api");
      }
      t[key] = value;
      return true;
    },
  });
}
