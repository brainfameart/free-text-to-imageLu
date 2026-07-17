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

/** Throws a descriptive error when a script calls this.animator on an entity
 *  without a Sprite Animation component. */
function _requireAnimator(entity) {
  var a = entity.getComponent(SPRITE_ANIMATION);
  if (!a) throw new Error(
    "'" + (entity.name || "Entity") + "' called this.animator but has no Sprite Animation component. " +
    "Add one in the Inspector (Add Component → Sprite Animation)."
  );
  return a;
}

/**
 * Builds the `this.animator` object for a given entity.
 * Accessing any method/property throws a clear error if the entity has
 * no Sprite Animation component.
 * @param {import('../../core/World.js').Entity} entity
 * @returns {object}
 */
export function createAnimatorAPI(entity) {
  return {
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
}
