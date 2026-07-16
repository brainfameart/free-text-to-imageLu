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

/**
 * Builds the `this.sprite` object for a given entity. Returns null if
 * the entity has no SpriteRenderer (caller decides whether to still
 * expose a stub — see ScriptAPI.js's EntityContext).
 * @param {import('../../core/World.js').Entity} entity
 * @returns {object}
 */
export function createSpriteAPI(entity) {
  return {
    get texture() { var s = entity.getComponent(SPRITE_RENDERER); return s ? s.spriteKey : null; },
    set texture(v) { var s = entity.getComponent(SPRITE_RENDERER); if (s) s.spriteKey = v; },
    get color() { var s = entity.getComponent(SPRITE_RENDERER); return s ? s.color : "#ffffff"; },
    set color(v) { var s = entity.getComponent(SPRITE_RENDERER); if (s) s.color = v; },
    get flipX() { var s = entity.getComponent(SPRITE_RENDERER); return s ? s.flipX : false; },
    set flipX(v) { var s = entity.getComponent(SPRITE_RENDERER); if (s) s.flipX = v; },
    get flipY() { var s = entity.getComponent(SPRITE_RENDERER); return s ? s.flipY : false; },
    set flipY(v) { var s = entity.getComponent(SPRITE_RENDERER); if (s) s.flipY = v; },
    get opacity() { return 1; },
    set opacity(v) { /* opacity alias — maps to color alpha if needed in future */ },
  };
}
