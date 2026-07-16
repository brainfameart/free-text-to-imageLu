/**
 * runtime/scripting/components/AudioAPI.js
 *
 * The `this.audio` sub-object exposed to user scripts (see
 * scripting/ScriptAPI.js). One file per scripting component — see
 * TransformAPI.js's header comment for the general rationale.
 *
 * RUNTIME-ONLY FILE.
 */

import { AUDIO_SOURCE } from "../../components/AudioSource.js";

/**
 * Builds the `this.audio` object for a given entity.
 * @param {import('../../core/World.js').Entity} entity
 * @returns {object}
 */
export function createAudioAPI(entity) {
  return {
    play: function () {
      var a = entity.getComponent(AUDIO_SOURCE);
      if (a) a.autoplay = true;
    },
    stop: function () {
      var a = entity.getComponent(AUDIO_SOURCE);
      if (a) a.autoplay = false;
    },
    get volume() { var a = entity.getComponent(AUDIO_SOURCE); return a ? a.volume : 1; },
    set volume(v) { var a = entity.getComponent(AUDIO_SOURCE); if (a) a.volume = v; },
  };
}
