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
 * `castShadow` is this object's half of dynamic shadow casting — see
 * Light.castShadows for the other half (whether a given light computes
 * shadows at all). Both need to be on for a specific light/object pair
 * to produce a shadow. When on, runtime/systems/LightingSystem.js
 * treats this sprite's real rendered bounding box (post-scale,
 * post-rotation — same box used for click-to-select hit-testing in the
 * editor) as an occluder: any Point/Spot/Area/Directional light with
 * castShadows on will have its glow cut away in the silhouette this
 * object projects, leaving a real dynamic shadow that moves and resizes
 * as the object or light moves. Matches Unity's per-Renderer
 * "Cast Shadows" checkbox.
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
    castShadow = true,
  } = {}) {
    this.spriteKey = spriteKey;
    this.color = color;
    this.flipX = flipX;
    this.flipY = flipY;
    this.castShadow = castShadow;
  }
}
