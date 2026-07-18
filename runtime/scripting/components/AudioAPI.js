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

function _tag(err, kind) {
  err.kind = kind;
  return err;
}

/** Throws a descriptive error when a script calls this.audio on an entity
 *  without an Audio Source component. */
function _requireAudio(entity) {
  var a = entity.getComponent(AUDIO_SOURCE);
  if (!a) throw _tag(new Error(
    "'" + (entity.name || "Entity") + "' called this.audio but has no Audio Source component. " +
    "Add one in the Inspector (Add Component → Audio Source)."
  ), "missing-component");
  return a;
}

const AUDIO_MEMBERS = new Set(["play", "stop", "volume", "playing"]);

/**
 * Builds the `this.audio` object for a given entity.
 * Accessing any method/property throws a clear error if the entity has
 * no Audio Source component. Accessing an unknown property (typo)
 * throws a distinct "does not exist" error.
 * @param {import('../../core/World.js').Entity} entity
 * @returns {object}
 */
export function createAudioAPI(entity) {
  const target = {
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
  return new Proxy(target, {
    get: function (t, prop) {
      if (typeof prop === "symbol" || prop === "then") return t[prop];
      if (!(prop in t) && !AUDIO_MEMBERS.has(String(prop))) {
        throw _tag(new Error(
          "this.audio." + String(prop) + " does not exist. Check the spelling — " +
          "valid members are: " + Array.from(AUDIO_MEMBERS).join(", ") + "."
        ), "unknown-api");
      }
      var v = t[prop];
      return typeof v === "function" ? v.bind(t) : v;
    },
    set: function (t, prop, value) {
      var key = String(prop);
      if (!(key in t) && !AUDIO_MEMBERS.has(key)) {
        throw _tag(new Error(
          "this.audio." + key + " does not exist. Check the spelling — " +
          "valid members are: " + Array.from(AUDIO_MEMBERS).join(", ") + "."
        ), "unknown-api");
      }
      // Read-only guard — see AnimatorAPI.js's set trap for why this
      // check exists: without it, assigning to a getter-only property
      // (playing) throws JS's own raw, untagged TypeError instead of a
      // clear script-facing message.
      var descriptor = Object.getOwnPropertyDescriptor(t, key);
      if (descriptor && descriptor.get && !descriptor.set) {
        throw _tag(new Error(
          "this.audio." + key + " is read-only — it reflects the audio source's real state and can't be set directly." +
          (key === "playing" ? " Use this.audio.play() or this.audio.stop() instead." : "")
        ), "unknown-api");
      }
      t[key] = value;
      return true;
    },
  });
}
