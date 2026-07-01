/**
 * runtime/systems/RenderSystem.js
 *
 * Owns a PIXI.Container ("world" / "stage root") and keeps one PIXI
 * DisplayObject per entity with a SpriteRenderer in sync with that
 * entity's Transform + SpriteRenderer data. This is the ONLY system that
 * touches PIXI — everything else stays renderer-agnostic.
 *
 * Used by both the standalone player (runtime/index.js) and the editor's
 * Scene/Game viewport, so visuals never drift between edit mode and play
 * mode.
 *
 * RUNTIME-ONLY FILE (depends on PIXI, not on the editor).
 */

import { System } from "../core/System.js";
import { TRANSFORM } from "../components/Transform.js";
import { SPRITE_RENDERER } from "../components/SpriteRenderer.js";
import { resolveTexture } from "../assets/AssetManager.js";

export class RenderSystem extends System {
  /**
   * @param {PIXI.Container} worldContainer container to draw entities into
   */
  constructor(worldContainer) {
    super();
    this.worldContainer = worldContainer;
    /** @type {Map<string, PIXI.Sprite>} entityId -> sprite */
    this._sprites = new Map();
  }

  update(world) {
    const entities = world.query(TRANSFORM, SPRITE_RENDERER);
    const seen = new Set();

    for (const entity of entities) {
      seen.add(entity.id);
      const transform = entity.getComponent(TRANSFORM);
      const spriteRenderer = entity.getComponent(SPRITE_RENDERER);

      let sprite = this._sprites.get(entity.id);
      if (!sprite) {
        sprite = new PIXI.Sprite(resolveTexture(spriteRenderer.spriteKey));
        sprite.anchor.set(0.5);
        this.worldContainer.addChild(sprite);
        this._sprites.set(entity.id, sprite);
      }

      sprite.texture = resolveTexture(spriteRenderer.spriteKey);
      sprite.x = transform.x;
      sprite.y = transform.y;
      sprite.rotation = (transform.rotation * Math.PI) / 180;
      sprite.scale.set(
        transform.scaleX * (spriteRenderer.flipX ? -1 : 1),
        transform.scaleY * (spriteRenderer.flipY ? -1 : 1)
      );
      sprite.tint = PIXI.utils ? PIXI.utils.string2hex(spriteRenderer.color) : 0xffffff;
      sprite.zIndex = spriteRenderer.orderInLayer;
    }

    // remove sprites for entities that no longer exist / lost the component
    for (const [entityId, sprite] of this._sprites) {
      if (!seen.has(entityId)) {
        this.worldContainer.removeChild(sprite);
        sprite.destroy();
        this._sprites.delete(entityId);
      }
    }

    this.worldContainer.sortableChildren = true;
  }

  destroy() {
    for (const sprite of this._sprites.values()) {
      this.worldContainer.removeChild(sprite);
      sprite.destroy();
    }
    this._sprites.clear();
  }
}
