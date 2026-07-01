/**
 * runtime/components/SpriteRenderer.js
 *
 * Visual representation of an entity. `spriteKey` is a logical name that
 * is resolved to a texture by runtime/assets/AssetManager.js — components
 * never hold PIXI objects directly, so they stay serializable.
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
    orderInLayer = 0,
  } = {}) {
    this.spriteKey = spriteKey;
    this.color = color;
    this.flipX = flipX;
    this.flipY = flipY;
    this.orderInLayer = orderInLayer;
  }
}
