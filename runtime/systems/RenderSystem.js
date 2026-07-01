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
import { CAMERA } from "../components/Camera.js";
import { resolveTexture } from "../assets/AssetManager.js";
import { getCameraResolution } from "../core/CameraUtils.js";

export class RenderSystem extends System {
  /**
   * @param {PIXI.Container} worldContainer container to draw entities into
   * @param {object} [opts]
   * @param {boolean} [opts.followMainCamera] when true, worldContainer is
   *   translated every frame so the scene's Main Camera world position is
   *   centered on screen — i.e. real "game screen" rendering, matching
   *   the exact frame CameraGizmo.js draws in the editor (both use
   *   CameraUtils.js as the single source of truth). The editor's Scene
   *   viewport passes false: its own free-roam ViewportCamera already
   *   drives worldContainer's pan/zoom, and applying both would fight
   *   each other. Play mode (the popup) and the standalone player pass
   *   true — there, nothing else accounts for where the camera entity
   *   sits in world space, so without this, sprites render at raw
   *   world-space coordinates and anything off-origin renders off the
   *   visible canvas (the "black screen" bug).
   */
  constructor(worldContainer, opts = {}) {
    super();
    this.worldContainer = worldContainer;
    this.followMainCamera = !!opts.followMainCamera;
    /** @type {Map<string, PIXI.Sprite>} entityId -> sprite */
    this._sprites = new Map();
  }

  update(world) {
    if (this.followMainCamera) this._applyMainCameraOffset(world);

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

  /**
   * Positions worldContainer so the Main Camera's world position is
   * centered on screen (0,0 of the container's parent), at 1:1 scale.
   * This is what makes the editor's yellow camera gizmo an honest
   * preview of play mode: whatever sits inside that yellow frame in the
   * Scene view is exactly what the popup renders, no more, no less.
   */
  _applyMainCameraOffset(world) {
    const cameraEntity = world.query(TRANSFORM, CAMERA).find((e) => e.getComponent(CAMERA).isMain);
    if (!cameraEntity) return;

    const camera = cameraEntity.getComponent(CAMERA);
    const transform = cameraEntity.getComponent(TRANSFORM);
    const { width, height } = getCameraResolution(camera);

    this.worldContainer.x = width / 2 - transform.x;
    this.worldContainer.y = height / 2 - transform.y;
  }

  destroy() {
    for (const sprite of this._sprites.values()) {
      this.worldContainer.removeChild(sprite);
      sprite.destroy();
    }
    this._sprites.clear();
  }
}
