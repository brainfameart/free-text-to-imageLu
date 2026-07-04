/**
 * runtime/components/SpriteRenderer.js
 *
 * Visual representation of an entity. `spriteKey` is a logical name that
 * is resolved to a texture by runtime/assets/AssetManager.js — components
 * never hold PIXI objects directly, so they stay serializable.
 *
 * Draw order is controlled entirely by the entity's Transform.z (higher
 * z draws on top) — see runtime/systems/RenderSystem.js. There is no
 * separate per-sprite layer-order field; Z is the single source of
 * truth for stacking, which is also what makes the fake-3D depth-scale
 * effect (Camera.enablePseudo3D) and draw order always agree with each
 * other by construction.
 *
 * RUNTIME-ONLY FILE.
 */

export const SPRITE_RENDERER = "SpriteRenderer";

export class SpriteRenderer {
  constructor({
    spriteKey = null,
    color = "#ffffff",
    flipX = false,
    flipY = false,
  } = {}) {
    this.spriteKey = spriteKey;
    this.color = color;
    this.flipX = flipX;
    this.flipY = flipY;
  }
}
