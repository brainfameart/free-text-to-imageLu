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

/**
 * Builds the `this.animator` object for a given entity.
 * @param {import('../../core/World.js').Entity} entity
 * @returns {object}
 */
export function createAnimatorAPI(entity) {
  return {
    play: function (clipName) {
      var anim = entity.getComponent(SPRITE_ANIMATION);
      if (!anim || !anim.clips) return;
      var clip = anim.clips.find(function (c) { return c.name === clipName; });
      if (clip) {
        anim.currentClipId = clip.id;
        anim.playing = true;
        anim.frameElapsed = 0;
        anim.currentFrameIndex = 0;
      }
    },
    stop: function () {
      var anim = entity.getComponent(SPRITE_ANIMATION);
      if (anim) anim.playing = false;
    },
    get playing() {
      var anim = entity.getComponent(SPRITE_ANIMATION);
      return anim ? !!anim.playing : false;
    },
  };
}
