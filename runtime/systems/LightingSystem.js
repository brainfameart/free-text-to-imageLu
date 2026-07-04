/**
 * runtime/systems/LightingSystem.js
 *
 * Renders every entity's Light component (see components/Light.js) as an
 * actual visual effect over the scene: an ambient-darkness overlay that
 * every light punches a bright hole through, using PIXI's additive blend
 * mode. This is what makes lights actually affect sprites and the world
 * (not just show a gizmo in the editor) — anything under a light reads
 * brighter, anything outside every light's reach reads darker.
 *
 * Owns its own PIXI.Container (added ABOVE the world container that
 * RenderSystem draws sprites into, but the darkness/light layer visually
 * sits "on top" using blend modes rather than actually occluding sprites
 * underneath — same technique Unity 2D's own Light2D uses under the
 * hood). Both the editor's Scene/Game viewport and the standalone player
 * get identical lighting because both go through this one System, same
 * as RenderSystem (see RULES.txt #5 — rendering is centralized).
 *
 * If a scene has ZERO light entities, this system draws nothing (fully
 * transparent overlay) so scenes without any Light component look
 * exactly as they did before lighting existed.
 *
 * RUNTIME-ONLY FILE (depends on PIXI, not on the editor).
 */

import { System } from "../core/System.js";
import { TRANSFORM } from "../components/Transform.js";
import { LIGHT, LightType } from "../components/Light.js";

// How dark the ambient overlay gets where no light reaches, at
// intensity 1 on whatever lights exist in the scene. 0 = no darkening
// at all, 1 = fully black. Kept well under 1 so scenes read as "dim"
// rather than pitch black outside light range, matching how most 2D
// games use lighting (mood, not total blackout).
const AMBIENT_DARKNESS = 0.65;

export class LightingSystem extends System {
  /**
   * @param {PIXI.Container} worldContainer the SAME container
   *   RenderSystem draws sprites into — lighting is layered as a child
   *   of it so it pans/zooms/follows-camera in lockstep with the
   *   sprites it's lighting, exactly like RenderSystem's own offset
   *   logic (see RenderSystem._applyMainCameraOffset).
   */
  constructor(worldContainer) {
    super();
    this.worldContainer = worldContainer;

    this.overlay = new PIXI.Container();
    // Darkness base: a big solid rect, resized to always cover the
    // current view every frame (see _resizeDarknessRect). Drawn first.
    this.darknessGraphics = new PIXI.Graphics();
    // Light "holes": each light draws an additive radial/shaped gradient
    // sprite here; ADD blend mode means bright areas cancel the darkness
    // rect drawn immediately below them and actually brighten whatever
    // sprite is under both layers.
    this.lightGraphics = new PIXI.Graphics();
    this.lightGraphics.blendMode = PIXI.BLEND_MODES.ADD;

    this.overlay.addChild(this.darknessGraphics);
    this.overlay.addChild(this.lightGraphics);

    // Sprites are added to worldContainer lazily, one at a time, as
    // RenderSystem discovers new entities — each newly-added sprite
    // lands wherever addChild puts it (end of the children list) and
    // would bury a same-container overlay added before it. zIndex
    // (with sortableChildren on) sits above raw add-order instead:
    // sprites default to zIndex 0-ish territory (RenderSystem sets
    // sprite.zIndex = Transform.z, which is 0 for un-moved objects and
    // rarely reaches into the thousands), so a very high fixed zIndex
    // keeps this overlay reliably above every sprite without having to
    // fight add-order every frame. It's still BELOW editor-only chrome
    // (grid/gizmo containers), which SceneViewport.js adds directly to
    // pixiApp.stage — those simply never opt into worldContainer's
    // zIndex sort, so their own container add-order (after this one)
    // keeps them on top regardless.
    this.overlay.zIndex = 100000;
    this.worldContainer.sortableChildren = true;
    this.worldContainer.addChild(this.overlay);
  }

  update(world) {
    const lightEntities = world
      .query(TRANSFORM, LIGHT)
      .filter((e) => e.getComponent(LIGHT).castsOnWorld);

    this.darknessGraphics.clear();
    this.lightGraphics.clear();

    if (lightEntities.length === 0) {
      // No lights in the scene at all: leave both graphics empty so the
      // overlay is fully transparent and the scene renders exactly as
      // it did before any Light component existed.
      this.overlay.visible = false;
      return;
    }
    this.overlay.visible = true;

    this._drawDarkness();

    for (const entity of lightEntities) {
      const transform = entity.getComponent(TRANSFORM);
      const light = entity.getComponent(LIGHT);
      const colorHex = this._toHex(light.color);

      switch (light.type) {
        case LightType.DIRECTIONAL:
          this._drawDirectional(transform, light, colorHex);
          break;
        case LightType.SPOT:
          this._drawSpot(transform, light, colorHex);
          break;
        case LightType.AREA:
          this._drawArea(transform, light, colorHex);
          break;
        case LightType.POINT:
        default:
          this._drawPoint(transform, light, colorHex);
          break;
      }
    }
  }

  /**
   * Covers a generous fixed area around the origin with the ambient
   * darkness color. Generous/fixed (rather than measured off the
   * camera) keeps this simple and correct even while the editor's free
   * -roam viewport camera pans/zooms independently of any Main Camera —
   * a light-less area just outside this rect would be exceedingly rare
   * in a normal scene and errs toward "still dark" rather than "a hard
   * edge where darkness suspiciously stops".
   */
  _drawDarkness() {
    const half = 4000;
    this.darknessGraphics.beginFill(0x000000, AMBIENT_DARKNESS);
    this.darknessGraphics.drawRect(-half, -half, half * 2, half * 2);
    this.darknessGraphics.endFill();
  }

  _drawPoint(transform, light, colorHex) {
    this._radialGradient(transform.x, transform.y, light.radius, light.intensity, colorHex);
  }

  /**
   * Directional light: no falloff, no position dependency — it's meant
   * to evenly light the entire visible scene, like sunlight. Applied as
   * a flat additive tint across the same big rect the darkness uses, so
   * a single Directional light with intensity 1 fully cancels
   * AMBIENT_DARKNESS everywhere (matching "the sun is up, nothing is in
   * shadow" rather than only near the light entity's Transform, which
   * wouldn't make sense for a light that's conceptually infinitely far
   * away).
   */
  _drawDirectional(transform, light, colorHex) {
    const half = 4000;
    const alpha = Math.min(1, AMBIENT_DARKNESS * light.intensity);
    this.lightGraphics.beginFill(colorHex, alpha);
    this.lightGraphics.drawRect(-half, -half, half * 2, half * 2);
    this.lightGraphics.endFill();
  }

  /**
   * Spot light: a radial gradient identical to Point, but clipped to a
   * cone `angle` degrees wide aimed along transform.rotation, by masking
   * the gradient draw with a triangle-fan wedge shape.
   */
  _drawSpot(transform, light, colorHex) {
    const rings = 10;
    const steps = 16;
    const centerX = transform.x;
    const centerY = transform.y;
    const rot = (transform.rotation * Math.PI) / 180;
    const halfAngle = ((light.angle || 45) * Math.PI) / 360;

    for (let r = rings; r >= 1; r--) {
      const t = r / rings; // 1 at outer edge, ~0 near center
      const ringRadius = light.radius * t;
      const alpha = Math.min(1, light.intensity * (1 - t) * 0.9);
      if (alpha <= 0.002) continue;

      this.lightGraphics.beginFill(colorHex, alpha);
      this.lightGraphics.moveTo(centerX, centerY);
      for (let i = 0; i <= steps; i++) {
        const a = rot - halfAngle + (i / steps) * (halfAngle * 2);
        this.lightGraphics.lineTo(centerX + Math.cos(a) * ringRadius, centerY + Math.sin(a) * ringRadius);
      }
      this.lightGraphics.lineTo(centerX, centerY);
      this.lightGraphics.endFill();
    }
  }

  /**
   * Area light: flat-lit rectangle (width x height, centered on the
   * entity) with `radius`-sized soft falloff rings drawn just outside
   * its edge so it doesn't cut off harshly.
   */
  _drawArea(transform, light, colorHex) {
    const w = light.width || 200;
    const h = light.height || 200;
    const falloff = Math.max(0, light.radius || 0);
    const rings = 6;

    // soft falloff, drawn first (further out), so the solid core below
    // overdraws cleanly on top of it
    for (let r = rings; r >= 1; r--) {
      const t = r / rings;
      const pad = falloff * t;
      const alpha = Math.min(1, light.intensity * (1 - t) * 0.8);
      if (alpha <= 0.002) continue;
      this.lightGraphics.beginFill(colorHex, alpha);
      this.lightGraphics.drawRect(
        transform.x - w / 2 - pad,
        transform.y - h / 2 - pad,
        w + pad * 2,
        h + pad * 2
      );
      this.lightGraphics.endFill();
    }

    this.lightGraphics.beginFill(colorHex, Math.min(1, light.intensity));
    this.lightGraphics.drawRect(transform.x - w / 2, transform.y - h / 2, w, h);
    this.lightGraphics.endFill();
  }

  /**
   * Shared radial-gradient-by-rings helper used by Point (and reused by
   * Spot's non-wedge math conceptually) — PIXI.Graphics has no native
   * radial gradient fill, so this approximates one with concentric
   * circles of decreasing alpha from center to edge.
   */
  _radialGradient(cx, cy, radius, intensity, colorHex) {
    const rings = 10;
    for (let r = rings; r >= 1; r--) {
      const t = r / rings;
      const ringRadius = radius * t;
      const alpha = Math.min(1, intensity * (1 - t) * 0.9);
      if (alpha <= 0.002) continue;
      this.lightGraphics.beginFill(colorHex, alpha);
      this.lightGraphics.drawCircle(cx, cy, ringRadius);
      this.lightGraphics.endFill();
    }
  }

  _toHex(colorString) {
    if (PIXI.utils && PIXI.utils.string2hex) return PIXI.utils.string2hex(colorString);
    return parseInt(String(colorString).replace("#", "0x")) || 0xffffff;
  }

  destroy() {
    this.overlay.destroy({ children: true });
  }
}
