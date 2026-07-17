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

/** Throws a descriptive error when a script calls this.audio on an entity
 *  without an Audio Source component. */
function _requireAudio(entity) {
  var a = entity.getComponent(AUDIO_SOURCE);
  if (!a) throw new Error(
    "'" + (entity.name || "Entity") + "' called this.audio but has no Audio Source component. " +
    "Add one in the Inspector (Add Component → Audio Source)."
  );
  return a;
}

/**
 * Builds the `this.audio` object for a given entity.
 * Accessing any method/property throws a clear error if the entity has
 * no Audio Source component.
 * @param {import('../../core/World.js').Entity} entity
 * @returns {object}
 */
export function createAudioAPI(entity) {
  return {
    /** Start playback. Throws if no Audio Source component. */
    play: function () { _requireAudio(entity).autoplay = true; },
    /** Stop playback. Throws if no Audio Source component. */
    stop: function () { _requireAudio(entity).autoplay = false; },
    /** Volume: 0.0 (silent) to 1.0 (full). Throws if no Audio Source. */
    get volume() { return _requireAudio(entity).volume; },
    set volume(v) { _requireAudio(entity).volume = Math.max(0, Math.min(1, v)); },
    /** True when the audio source is set to play on awake / is playing. */
    get playing() { return _requireAudio(entity).autoplay; },
  };
}
