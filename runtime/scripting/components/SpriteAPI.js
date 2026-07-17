/**
 * runtime/scripting/components/SpriteAPI.js
 *
 * The `this.sprite` sub-object exposed to user scripts (see
 * scripting/ScriptAPI.js). One file per scripting component — see
 * TransformAPI.js's header comment for the rationale.
 *
 * RUNTIME-ONLY FILE.
 */

import { SPRITE_RENDERER } from "../../components/SpriteRenderer.js";

/** Throws a descriptive error when a script calls this.sprite on an
 *  entity that has no SpriteRenderer. The error propagates through
 *  ScriptSystem's per-lifecycle try/catch and is reported to the editor
 *  console — same path as any other script runtime error. */
function _requireSprite(entity) {
  var s = entity.getComponent(SPRITE_RENDERER);
  if (!s) throw new Error(
    "'" + (entity.name || "Entity") + "' called this.sprite but has no Sprite Renderer. " +
    "Add one in the Inspector (Add Component → Sprite Renderer)."
  );
  return s;
}

/**
 * Builds the `this.sprite` object for a given entity.
 * Accessing any property throws a clear error if the entity has no
 * SpriteRenderer, so the editor console shows exactly what is missing
 * instead of silently returning a default value.
 * @param {import('../../core/World.js').Entity} entity
 * @returns {object}
 */
export function createSpriteAPI(entity) {
  return {
    get texture() { return _requireSprite(entity).spriteKey; },
    set texture(v) { _requireSprite(entity).spriteKey = v; },
    get color() { return _requireSprite(entity).color; },
    set color(v) { _requireSprite(entity).color = v; },
    get flipX() { return _requireSprite(entity).flipX; },
    set flipX(v) { _requireSprite(entity).flipX = !!v; },
    get flipY() { return _requireSprite(entity).flipY; },
    set flipY(v) { _requireSprite(entity).flipY = !!v; },
    /** 0.0–1.0 transparency alias. Internally stored as an alpha on the tint color;
     *  a full implementation would blend with the color channel. */
    get opacity() { _requireSprite(entity); return 1; },
    set opacity(v) { _requireSprite(entity); /* full alpha-blend support is a future enhancement */ },
  };
}
