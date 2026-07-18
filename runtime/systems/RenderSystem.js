/**
 * runtime/systems/RenderSystem.js
 *
 * Owns a PIXI.Container ("world" / "stage root") and keeps one PIXI
 * DisplayObject per entity with a SpriteRenderer in sync with that
 * entity's Transform + SpriteRenderer data. This is the ONLY system that
 * touches PIXI — everything else stays renderer-agnostic.
 *
 * Draw order: Transform.z is the single source of truth for stacking —
 * higher z draws on top of lower z (SpriteRenderer has no separate
 * layer-order field; see SpriteRenderer.js). Ties are broken by a
 * stable entity-id sort so draw order never flickers frame-to-frame for
 * objects that share the same z.
 *
 * Fake-3D depth (Camera.enablePseudo3D, a scene-wide toggle): when the
 * Main Camera has this on, Transform.z ALSO scales an object's rendered
 * size — positive z (closer to camera) enlarges it, negative z (farther
 * from camera) shrinks it, on top of z still controlling draw order.
 * When off, z affects draw order only and never touches visual size,
 * exactly matching the checked/unchecked behavior requested.
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

// Reference "camera distance" used by the pseudo-3D depth-scale formula
// below: visualScale = DEPTH_REFERENCE / (DEPTH_REFERENCE - z). At
// z = 0 (the default for every new object) this is exactly 1 — neutral,
// no visual change — so turning enablePseudo3D on never resizes objects
// that haven't been moved in Z yet. Bigger DEPTH_REFERENCE = more
// gradual/subtle size falloff per unit of Z; smaller = more dramatic.
const DEPTH_REFERENCE = 500;
const MIN_DEPTH_SCALE = 0.02; // guards against z >= DEPTH_REFERENCE going negative/infinite

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

    const pseudo3D = this._isPseudo3DEnabled(world);

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

      // Depth-scale: only applied when the scene's fake-3D toggle is on
      // (see Camera.enablePseudo3D doc comment). At transform.z === 0
      // depthScale is exactly 1, so objects that have never been moved
      // in Z are visually unaffected by turning the toggle on.
      const depthScale = pseudo3D ? this._depthScaleFor(transform.z) : 1;

      // Animation-frame size compensation: Transform.scaleX/Y is the
      // user's INTENDED overall size (what SceneViewport's drag-drop
      // fitSpriteScale() computed against ONE reference image, and what
      // the Inspector shows/edits). Without correction, PIXI multiplies
      // that scale directly against whichever texture is currently
      // assigned — so if a SpriteAnimation clip swaps in a frame whose
      // raw pixel size differs from the image the entity was originally
      // scaled against, the sprite visibly shrinks or grows even though
      // the user never touched Transform.scale (see SpriteRenderer.js's
      // referenceWidth/Height doc comment for the full explanation).
      // frameScaleX/Y cancels that out: if this frame is smaller than
      // the reference, frameScale > 1 to compensate, and vice versa — so
      // the entity's on-screen size stays visually constant across every
      // frame of an animation, exactly like Unity's Pixels Per Unit.
      const tex = sprite.texture;
      const refW = spriteRenderer.referenceWidth || (tex && tex.width) || 1;
      const refH = spriteRenderer.referenceHeight || (tex && tex.height) || 1;
      const frameScaleX = tex && tex.width ? refW / tex.width : 1;
      const frameScaleY = tex && tex.height ? refH / tex.height : 1;

      sprite.scale.set(
        transform.scaleX * frameScaleX * depthScale * (spriteRenderer.flipX ? -1 : 1),
        transform.scaleY * frameScaleY * depthScale * (spriteRenderer.flipY ? -1 : 1)
      );
      sprite.tint = PIXI.utils ? PIXI.utils.string2hex(spriteRenderer.color) : 0xffffff;
      sprite.alpha = (spriteRenderer.opacity != null) ? Math.max(0, Math.min(1, spriteRenderer.opacity)) : 1;

      // Draw order: Transform.z is the sole source of truth (see file
      // header). Pixi's zIndex sort applies a stable sort in modern
      // versions, but a tiny id-derived fractional nudge is added here
      // so tie-breaking is deterministic and documented rather than
      // relying on an internal engine guarantee that could change.
      sprite.zIndex = transform.z + this._tieBreak(entity.id);
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
   * Deterministic, stable, tiny (<< 1) offset derived from an entity id
   * so objects sharing the exact same Transform.z always draw in the
   * same relative order every frame, without affecting the visible
   * z value (never large enough to cross into a neighboring integer z).
   * @param {string} entityId
   */
  _tieBreak(entityId) {
    let hash = 0;
    for (let i = 0; i < entityId.length; i++) {
      hash = (hash * 31 + entityId.charCodeAt(i)) >>> 0;
    }
    return (hash % 1000) / 1000000; // max ~0.001 — invisible to z ordering intent
  }

  /**
   * @returns {boolean} whether the scene's Main Camera has the
   *   scene-wide fake-3D depth toggle on. Missing camera => false, so a
   *   scene mid-setup (no camera yet) never surprises with unexpected
   *   scaling.
   */
  _isPseudo3DEnabled(world) {
    const cameraEntity = world.query(TRANSFORM, CAMERA).find((e) => e.getComponent(CAMERA).isMain);
    if (!cameraEntity) return false;
    return !!cameraEntity.getComponent(CAMERA).enablePseudo3D;
  }

  /**
   * Cheap perspective-style falloff: 1 at z=0, grows above 1 as z goes
   * positive ("closer" to camera / bigger), shrinks toward 0 as z goes
   * more negative ("farther" from camera / smaller) — matches the
   * requested "positive numbers scale up, negative numbers scale down"
   * behavior.
   * @param {number} z
   */
  _depthScaleFor(z) {
    return Math.max(MIN_DEPTH_SCALE, DEPTH_REFERENCE / (DEPTH_REFERENCE - z));
  }

  /**
   * Positions and scales worldContainer so the Main Camera's world
   * position is centered on screen and Camera.size is honoured as a
   * zoom level. Camera.size=5 (the default) is 1:1 — no zoom. A
   * smaller size zooms in (fewer world-units fill the viewport), a
   * larger size zooms out (more world-units visible). This is the
   * standard Unity orthographic camera convention, and it is what makes
   * `this.camera.zoom` in a script actually change how the game looks:
   * zoom = 5 / size, so setting size=2.5 via the script doubles the
   * visible scale (2× zoom in), and size=10 halves it (2× zoom out).
   */
  _applyMainCameraOffset(world) {
    const cameraEntity = world.query(TRANSFORM, CAMERA).find((e) => e.getComponent(CAMERA).isMain);
    if (!cameraEntity) return;

    const camera = cameraEntity.getComponent(CAMERA);
    const transform = cameraEntity.getComponent(TRANSFORM);
    const { width, height } = getCameraResolution(camera);

    // Default size=5 → zoom factor 1 (no scaling). Clamp size to a
    // safe minimum so the container never gets an infinite scale.
    const DEFAULT_CAMERA_SIZE = 5;
    const zoom = DEFAULT_CAMERA_SIZE / Math.max(0.001, camera.size);

    this.worldContainer.scale.set(zoom);
    this.worldContainer.x = width / 2 - transform.x * zoom;
    this.worldContainer.y = height / 2 - transform.y * zoom;
  }

  /**
   * Applies a hex color string (e.g. "#314D79") as the renderer's clear
   * color. Deliberately NOT called automatically from update() — the
   * editor's Scene viewport calls this on every Camera field edit (live
   * preview), while the Game/Play viewport only calls it once, at the
   * moment Play is pressed, matching the requested "update in game mode
   * only when play is pressed" behavior instead of live-tracking Camera
   * edits while a game is actually running.
   * @param {PIXI.Application} pixiApp
   * @param {string} hexColorString e.g. "#314D79"
   */
  static applyBackgroundColor(pixiApp, hexColorString) {
    if (!pixiApp || !hexColorString) return;
    const hex = PIXI.utils ? PIXI.utils.string2hex(hexColorString) : parseInt(hexColorString.replace("#", "0x"));
    pixiApp.renderer.background.color = hex;
  }

  /**
   * Real, post-scale/post-depthScale world-space bounding half-extents
   * for an entity's rendered sprite, read straight from the live PIXI
   * sprite this system is already tracking. Used by
   * editor/viewport/SceneViewport.js for accurate click-to-select
   * hit-testing — previously that hit-test used a hardcoded 40px
   * half-extent for every entity regardless of actual sprite size,
   * which made clicks miss on sprites bigger/smaller than that guess.
   * @param {string} entityId
   * @returns {{halfWidth: number, halfHeight: number}|null} null if this
   *   entity has no tracked sprite (not rendered, or SpriteRenderer-less)
   */
  getSpriteWorldHalfExtents(entityId) {
    const sprite = this._sprites.get(entityId);
    if (!sprite) return null;
    // sprite.width/height already include texture size * abs(scale) —
    // PIXI computes these from the local bounds * worldTransform scale,
    // so this stays correct through flipX/flipY (negative scale) and
    // the pseudo-3D depthScale multiplier applied in update() above.
    return { halfWidth: Math.abs(sprite.width) / 2, halfHeight: Math.abs(sprite.height) / 2 };
  }

  /**
   * Read-only iteration over every live entityId -> PIXI.Sprite pair
   * this system currently tracks. Used ONLY by LightingSystem (see
   * systems/LightingSystem.js's Phase 2: attaching/updating a
   * per-sprite SpriteLightFilter) so it can react to sprites being
   * added/removed without RenderSystem needing to know anything about
   * lighting — keeps rendering centralized here (RULES.txt #5) while
   * still letting another system piggyback on the same tracked sprite
   * set instead of building its own parallel entityId->displayObject
   * map.
   * @returns {IterableIterator<[string, PIXI.Sprite]>}
   */
  getTrackedSprites() {
    return this._sprites.entries();
  }

  destroy() {
    for (const sprite of this._sprites.values()) {
      this.worldContainer.removeChild(sprite);
      sprite.destroy();
    }
    this._sprites.clear();
  }
}
