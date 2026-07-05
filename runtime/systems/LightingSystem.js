/**
 * runtime/systems/LightingSystem.js
 *
 * GPU-driven 2D lighting. Every Light component (see
 * components/Light.js) and every ShadowCaster (see
 * components/ShadowCaster.js) is uploaded as raw numeric data into a
 * single custom PIXI.Filter's uniforms, and ALL of the actual
 * lighting/shadow math — radial falloff, spot cones, area rectangles,
 * directional sun-fill, shadow occlusion, penumbra softening — runs
 * PER PIXEL on the GPU inside one fragment shader
 * (LightingShaderSource.js), once per frame. Nothing about lighting is
 * drawn with PIXI.Graphics or baked canvas gradient textures anymore:
 * there is no CPU polygon fill, no baked radial-gradient sprite, no
 * "concentric rings" or multi-pass softness approximation. The shader
 * itself computes a true smooth gradient / true shadow test at every
 * pixel, so quality no longer depends on how many draw calls or
 * texture passes we're willing to spend.
 *
 * PIPELINE:
 *   1. The real game scene (sprites, drawn by RenderSystem) renders
 *      normally into worldContainer, same as before this feature
 *      existed.
 *   2. This system applies ONE PIXI.Filter directly to worldContainer.
 *      A filter re-renders its target into a texture and runs a
 *      fragment shader over every output pixel — that's the "GPU
 *      draws the lighting" part: darkness, light falloff, and shadows
 *      are composited in the shader against the already-rendered
 *      scene colors, instead of being separate Graphics/Sprite objects
 *      layered on top with blend modes.
 *   3. Every tick, update() walks Light + ShadowCaster entities and
 *      fills flat Float32Arrays (one slot per light / per occluder, up
 *      to MAX_LIGHTS / MAX_OCCLUDERS) which get assigned straight to
 *      the filter's uniforms — this is the only per-frame CPU cost, no
 *      trig-heavy polygon construction like the old system.
 *
 * COORDINATE SPACE: the filter's uniforms are filled in
 * WORLD-CONTAINER-LOCAL pixel space (i.e. Transform.x/y as-is, the
 * same space sprites already live in), NOT screen space. The vertex
 * shader reconstructs each pixel's local-space world coordinate
 * directly (see LightingShaderSource.js's vWorldCoord), so light
 * positions need zero extra conversion for panning/zooming — the SAME
 * filter instance keeps working correctly whether worldContainer is
 * translated only (play mode) or panned+scaled (editor's free-roam
 * Scene viewport), because the filter is attached to that container
 * and PIXI handles the transform for us.
 *
 * SHADOW MODES (user picks based on their machine): every Light and
 * every ShadowCaster still has all the same fields as before
 * (radius/angle/width/height, castShadows, shadowColor/shadowStrength,
 * offset/opacity/length/softness). What changed is HOW the shadow test
 * runs, controlled by this.quality.shadowMode (see LightingQuality.js):
 *  - "quad": cheap analytic box-shadow test per pixel (same
 *    silhouette-quad extrusion geometry the old CPU version used, just
 *    evaluated in the shader instead of filled as a PIXI.Graphics
 *    polygon) — matches the previous look closely, costs very little
 *    GPU time.
 *  - "raymarch": true per-pixel occlusion — the shader marches a ray
 *    from each shaded pixel toward each light and tests it against
 *    every occluder box along the way, so shadows are exact at every
 *    pixel (correct penumbra from an occluder's own apparent size,
 *    correctly handles overlapping occluders) at a real GPU cost that
 *    scales with lights * occluders * pixels — meant for the "my
 *    computer can take it" case.
 * Both modes are compiled into the SAME shader (branched by the
 * uShadowMode uniform), so switching mid-game needs no shader rebuild
 * — just flip `lightingSystem.quality.shadowMode`.
 *
 * Both the editor's Scene/Game viewport and the standalone player get
 * identical lighting because both go through this one System, same as
 * RenderSystem (see RULES.txt #5 — rendering is centralized).
 *
 * If a scene has ZERO light entities, the filter is removed from
 * worldContainer entirely (filters = null) so a light-less scene has
 * exactly zero lighting overhead and renders pixel-identical to before
 * lighting existed.
 *
 * RUNTIME-ONLY FILE (depends on PIXI, not on the editor).
 */

import { System } from "../core/System.js";
import { TRANSFORM } from "../components/Transform.js";
import { LIGHT, LightType } from "../components/Light.js";
import { SHADOW_CASTER } from "../components/ShadowCaster.js";
import { LightingQuality, ShadowMode } from "./LightingQuality.js";
import { buildLightingFilter, MAX_LIGHTS, MAX_OCCLUDERS, MAX_RAYMARCH_STEPS } from "./LightingShaderSource.js";

// How dark the ambient overlay gets where no light reaches, at
// intensity 1 on whatever lights exist in the scene. 0 = no darkening
// at all, 1 = fully black. Kept well under 1 so scenes read as "dim"
// rather than pitch black outside light range — same value as the old
// CPU system so existing scenes look the same by default.
const AMBIENT_DARKNESS = 0.65;

// Fallback occluder half-size (px) for a ShadowCaster with no explicit
// width/height override AND no live rendered sprite yet (e.g. a
// texture still loading, or no SpriteRenderer at all).
const FALLBACK_OCCLUDER_HALF = 24;

// Base shadow-casting distance (world units/px) used by Directional
// lights' PARALLEL shadows, which have no light.radius of their own to
// scale against. Each ShadowCaster's own `length` multiplies this base.
const DIRECTIONAL_SHADOW_BASE_DISTANCE = 1200;

const LIGHT_TYPE_ID = Object.freeze({
  [LightType.DIRECTIONAL]: 0,
  [LightType.POINT]: 1,
  [LightType.SPOT]: 2,
  [LightType.AREA]: 3,
});

export class LightingSystem extends System {
  /**
   * @param {PIXI.Container} worldContainer the SAME container
   *   RenderSystem draws sprites into — the lighting filter is applied
   *   directly to it, so it composites against exactly the sprites
   *   drawn this frame and pans/zooms/follows-camera in lockstep
   *   automatically (see file header, COORDINATE SPACE).
   * @param {import('./RenderSystem.js').RenderSystem} [renderSystem]
   *   optional reference used ONLY to read each ShadowCaster entity's
   *   real rendered sprite bounds (getSpriteWorldHalfExtents) as the
   *   default occluder shape — see components/ShadowCaster.js.
   * @param {PIXI.Application} [pixiApp] optional reference used ONLY to
   *   read renderer.screen each frame so the lighting filter always
   *   covers the FULL visible canvas (see LightingShaderSource.js's
   *   autoFit=false note) rather than just the bounding box of
   *   currently-rendered sprites — matches the old CPU system always
   *   darkening/lighting a large fixed area regardless of where
   *   sprites happen to be. If omitted, PIXI's own default filter-area
   *   behavior is used instead (a reasonable fallback, just without
   *   the "light empty background too" guarantee).
   */
  constructor(worldContainer, renderSystem, pixiApp) {
    super();
    this.worldContainer = worldContainer;
    this.renderSystem = renderSystem || null;
    this.pixiApp = pixiApp || null;

    // Per-scene/per-player GPU shadow-quality choice, exposed on the
    // instance (not a module constant) so the editor's Inspector or a
    // game's own settings menu can flip it per machine — see
    // LightingQuality.js.
    this.quality = new LightingQuality();

    // Set once the fragment/vertex shader has failed to compile/link
    // (see _buildFilterSafely). While true, update() short-circuits
    // every frame instead of retrying a filter build that's already
    // known to throw, so a bad shader degrades to "no lighting" rather
    // than spamming the console every tick or crashing the game loop.
    this._filterBroken = false;

    this.filter = this._buildFilterSafely();
    if (this.filter) {
      this.filter.uniforms.uAmbientDarkness = AMBIENT_DARKNESS;
    }

    // Attached/detached from worldContainer.filters depending on
    // whether any lights currently exist (see update()) — starts
    // detached so a scene with no Light entities pays exactly zero
    // extra GPU cost, matching the old system's early-return.
    this._filterAttached = false;
  }

  /**
   * Wraps buildLightingFilter() so a GLSL compile/link failure (bad
   * edit to LightingShaderSource.js, a driver that rejects the
   * raymarch branch, uniform count over the GPU's limit, etc.) is
   * reported through the ordinary console.error/warn path instead of
   * throwing out of the constructor and taking the whole engine down.
   * console.error/warn are what editor/state/ConsoleCapture.js mirrors
   * into the in-engine Console panel, so this is how a shader problem
   * ends up visible there without runtime importing anything from
   * /editor (see RULES.txt #1).
   */
  _buildFilterSafely() {
    try {
      return buildLightingFilter();
    } catch (err) {
      this._filterBroken = true;
      console.error("[Lighting] Failed to compile lighting shader — lighting is disabled for this session:", err);
      return null;
    }
  }

  update(world) {
    if (this._filterBroken || !this.filter) {
      this._detachFilter();
      return;
    }

    const lightEntities = world
      .query(TRANSFORM, LIGHT)
      .filter((e) => e.getComponent(LIGHT).castsOnWorld);

    if (lightEntities.length === 0) {
      this._detachFilter();
      return;
    }

    if (lightEntities.length > MAX_LIGHTS) {
      console.warn(
        "[Lighting] Scene has " +
          lightEntities.length +
          " active lights but the shader only supports " +
          MAX_LIGHTS +
          " at once. The extra " +
          (lightEntities.length - MAX_LIGHTS) +
          " light(s) will be ignored — remove or disable some lights, or raise MAX_LIGHTS in LightingShaderSource.js."
      );
    }

    const occluders = this._collectOccluders(world);
    if (occluders.length > MAX_OCCLUDERS) {
      console.warn(
        "[Lighting] Scene has " +
          occluders.length +
          " enabled Shadow Casters but the shader only supports " +
          MAX_OCCLUDERS +
          " at once. The extra " +
          (occluders.length - MAX_OCCLUDERS) +
          " will not cast shadows."
      );
    }

    try {
      this._fillLightUniforms(lightEntities, occluders);
      this._fillOccluderUniforms(occluders);

      this.filter.uniforms.uLightCount = Math.min(MAX_LIGHTS, lightEntities.length);
      this.filter.uniforms.uOccluderCount = Math.min(MAX_OCCLUDERS, occluders.length);
      this.filter.uniforms.uShadowMode = this.quality.shadowMode === ShadowMode.RAYMARCH ? 1 : 0;
      this.filter.uniforms.uRaymarchSteps = Math.min(MAX_RAYMARCH_STEPS, Math.max(1, this.quality.raymarchSteps));
      this.filter.uniforms.uAmbientDarkness = AMBIENT_DARKNESS;
      this._syncStageTransform();
      this._syncFilterArea();

      this._attachFilter();
    } catch (err) {
      // A bad value slipping into a uniform (NaN transform, a light
      // with a corrupt color string, etc.) throws deep inside PIXI's
      // filter upload rather than here, so this catch is the last
      // line of defense: log it clearly and drop lighting for this
      // frame instead of breaking the whole render loop.
      this._filterBroken = true;
      this._detachFilter();
      console.error("[Lighting] Error while updating lighting uniforms — lighting disabled for this session:", err);
    }
  }

  /**
   * Points the filter at the renderer's full screen rect (see
   * LightingShaderSource.js's autoFit=false note) instead of letting
   * PIXI auto-fit to gameContentContainer's current sprite bounding
   * box, so empty background areas of the scene still get darkened/lit
   * exactly like the old system's large fixed-size darkness rect did.
   */
  _syncFilterArea() {
    if (!this.pixiApp || !this.pixiApp.renderer) return;
    this.filter.filterArea = this.pixiApp.renderer.screen;
  }

  /**
   * Uploads gameContentContainer's actual on-screen transform (plain
   * translate + uniform scale — nothing in this engine ever rotates
   * this container or any of its ancestors, see file header) so the
   * shader can convert screen-space pixels back to world space (see
   * LightingShaderSource.js's vertex shader). Walked by hand from
   * .x/.y/.scale.x up the parent chain rather than read off
   * .worldTransform, since PIXI only recomputes worldTransform during
   * its OWN render pass (driven by the shared ticker), which may not
   * have run yet for this tick by the time this System's update() is
   * called — reading .worldTransform here could be one frame stale
   * during a fast pan/zoom. Walking the plain x/y/scale numbers
   * ourselves is always exactly in sync with what THIS frame is about
   * to render.
   */
  _syncStageTransform() {
    let offsetX = 0;
    let offsetY = 0;
    let scale = 1;
    let node = this.worldContainer;
    while (node) {
      offsetX = offsetX * node.scale.x + node.x;
      offsetY = offsetY * node.scale.y + node.y;
      scale *= node.scale.x;
      node = node.parent;
    }
    this.filter.uniforms.uStageOffset[0] = offsetX;
    this.filter.uniforms.uStageOffset[1] = offsetY;
    this.filter.uniforms.uStageScale = scale || 1;
  }

  _attachFilter() {
    if (this._filterAttached) return;
    const existing = this.worldContainer.filters || [];
    this.worldContainer.filters = [...existing.filter((f) => f !== this.filter), this.filter];
    this._filterAttached = true;
  }

  _detachFilter() {
    if (!this._filterAttached) return;
    const existing = this.worldContainer.filters || [];
    const remaining = existing.filter((f) => f !== this.filter);
    this.worldContainer.filters = remaining.length ? remaining : null;
    this._filterAttached = false;
  }

  /**
   * Fills the shader's per-light uniform arrays (flat, MAX_LIGHTS slots
   * each — GLSL ES 1.00 has no dynamically-sized uniform arrays, so a
   * fixed cap plus an explicit uLightCount is the standard technique;
   * see LightingShaderSource.js's loop, which simply `break`s past
   * uLightCount). One slot's worth of floats fully describes any light
   * type uniformly (type id + shared color/intensity + the 4
   * type-specific fields angle/radius/width/height), which is what
   * lets a single shader branch handle all 4 Light types instead of 4
   * separate shaders.
   */
  _fillLightUniforms(lightEntities, occluders) {
    const u = this.filter.uniforms;
    const count = Math.min(MAX_LIGHTS, lightEntities.length);

    for (let i = 0; i < count; i++) {
      const entity = lightEntities[i];
      const transform = entity.getComponent(TRANSFORM);
      const light = entity.getComponent(LIGHT);
      const rgb = this._toRgbFloats(light.color);
      const shadowRgb = this._toRgbFloats(light.shadowColor);

      u.uLightPos[i * 2 + 0] = transform.x;
      u.uLightPos[i * 2 + 1] = transform.y;
      u.uLightTypeId[i] = LIGHT_TYPE_ID[light.type] ?? 1;
      u.uLightColor[i * 3 + 0] = rgb[0];
      u.uLightColor[i * 3 + 1] = rgb[1];
      u.uLightColor[i * 3 + 2] = rgb[2];
      u.uLightIntensity[i] = Math.max(0, light.intensity);
      u.uLightRadius[i] = Math.max(0.0001, light.radius || 0);
      u.uLightAngle[i] = ((light.angle ?? 45) * Math.PI) / 180;
      u.uLightRotation[i] = ((transform.rotation || 0) * Math.PI) / 180;
      u.uLightWidth[i] = Math.max(0, light.width || 0);
      u.uLightHeight[i] = Math.max(0, light.height || 0);
      u.uLightCastsShadows[i] = light.castShadows && occluders.length ? 1 : 0;
      u.uLightShadowStrength[i] = Math.max(0, light.shadowStrength ?? 1);
      u.uLightShadowColor[i * 3 + 0] = shadowRgb[0];
      u.uLightShadowColor[i * 3 + 1] = shadowRgb[1];
      u.uLightShadowColor[i * 3 + 2] = shadowRgb[2];
      // Directional shadow reach is fixed (parallel/"sun" shadows have
      // no natural radius to scale against — see components/Light.js);
      // Point/Spot/Area reach is just the light's own radius, scaled
      // per-occluder by ShadowCaster.length inside the shader.
      u.uLightShadowReach[i] =
        light.type === LightType.DIRECTIONAL ? DIRECTIONAL_SHADOW_BASE_DISTANCE : Math.max(0.0001, light.radius || 0);
    }
  }

  /**
   * Fills the shader's per-occluder uniform arrays (flat, MAX_OCCLUDERS
   * slots). Occluder collection semantics (real sprite bounds ->
   * explicit width/height override -> fallback half-size; local
   * offset rotated by the entity's own rotation before translating;
   * rotated box) are UNCHANGED from the previous CPU system — only
   * where the box gets turned into pixels changed (GPU shadow test
   * instead of CPU polygon fill), so existing scenes' shadow
   * shapes/behavior carry over.
   */
  _fillOccluderUniforms(occluders) {
    const u = this.filter.uniforms;
    const count = Math.min(MAX_OCCLUDERS, occluders.length);

    for (let i = 0; i < count; i++) {
      const occ = occluders[i];
      u.uOccPos[i * 2 + 0] = occ.x;
      u.uOccPos[i * 2 + 1] = occ.y;
      u.uOccHalfExtents[i * 2 + 0] = occ.halfWidth;
      u.uOccHalfExtents[i * 2 + 1] = occ.halfHeight;
      u.uOccRotation[i] = (occ.rotationDeg * Math.PI) / 180;
      u.uOccOpacity[i] = occ.opacity;
      u.uOccLength[i] = occ.length;
      u.uOccSoftness[i] = occ.softness;
    }
  }

  /**
   * Gathers every enabled ShadowCaster entity's world-space occluder
   * box: {id, x, y, halfWidth, halfHeight, rotationDeg, opacity,
   * length, softness}. Identical semantics to the previous CPU
   * system's _collectOccluders (see components/ShadowCaster.js for the
   * offset/rotation convention) — only the consumer of this data
   * changed (GPU uniforms instead of CPU polygon math).
   */
  _collectOccluders(world) {
    const casters = world.query(TRANSFORM, SHADOW_CASTER);
    const out = [];
    for (const entity of casters) {
      const caster = entity.getComponent(SHADOW_CASTER);
      if (!caster.enabled) continue;
      const transform = entity.getComponent(TRANSFORM);
      const rotationDeg = transform.rotation || 0;
      const angleRad = (rotationDeg * Math.PI) / 180;

      let halfWidth, halfHeight;
      const real = this.renderSystem ? this.renderSystem.getSpriteWorldHalfExtents(entity.id) : null;
      if (caster.width != null && caster.height != null) {
        halfWidth = caster.width / 2;
        halfHeight = caster.height / 2;
      } else if (real) {
        halfWidth = real.halfWidth;
        halfHeight = real.halfHeight;
      } else {
        halfWidth = FALLBACK_OCCLUDER_HALF;
        halfHeight = FALLBACK_OCCLUDER_HALF;
      }

      const localOffsetX = caster.offsetX || 0;
      const localOffsetY = caster.offsetY || 0;
      const rotatedOffsetX = localOffsetX * Math.cos(angleRad) - localOffsetY * Math.sin(angleRad);
      const rotatedOffsetY = localOffsetX * Math.sin(angleRad) + localOffsetY * Math.cos(angleRad);

      out.push({
        id: entity.id,
        x: transform.x + rotatedOffsetX,
        y: transform.y + rotatedOffsetY,
        halfWidth,
        halfHeight,
        rotationDeg,
        opacity: caster.opacity != null ? caster.opacity : 1,
        length: caster.length != null ? caster.length : 1,
        softness: Math.max(0, caster.softness || 0),
      });
    }
    return out;
  }

  _toRgbFloats(colorString) {
    let hex;
    try {
      hex =
        PIXI.utils && PIXI.utils.string2hex
          ? PIXI.utils.string2hex(colorString)
          : parseInt(String(colorString).replace("#", "0x")) || 0xffffff;
    } catch (err) {
      hex = 0xffffff;
    }
    if (!Number.isFinite(hex)) {
      console.warn("[Lighting] Light has an invalid color value '" + colorString + "' — falling back to white.");
      hex = 0xffffff;
    }
    return [((hex >> 16) & 0xff) / 255, ((hex >> 8) & 0xff) / 255, (hex & 0xff) / 255];
  }

  destroy() {
    this._detachFilter();
    this.filter.destroy();
  }
}
