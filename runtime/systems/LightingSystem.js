/**
 * runtime/systems/LightingSystem.js
 *
 * GPU-driven 2D lighting, rebuilt to match Unity URP's actual 2D
 * Lighting pipeline: TWO separate rendering phases per frame instead
 * of one all-in-one filter.
 *
 *   PHASE 1 — LIGHT TEXTURE (see LightTextureShaderSource.js):
 *     Every Light + ShadowCaster entity's data is uploaded as uniforms
 *     to a filter that draws ONLY light shapes (radial/cone/rect
 *     falloff, directional fill, shadow occlusion) into an offscreen
 *     PIXI.RenderTexture, in screen space, once per frame. This buffer
 *     has zero knowledge of sprites — exactly Unity's "Light Render
 *     Texture," a screen-space buffer containing only light color,
 *     rendered once and shared by every sprite that samples it.
 *
 *   PHASE 2 — SPRITE SAMPLING (see SpriteLightFilter.js):
 *     Every individual sprite RenderSystem tracks gets its own tiny
 *     PIXI.Filter attached that samples Phase 1's light texture at
 *     that sprite's own screen position and MULTIPLIES it into that
 *     sprite's own texture color. This is exactly Unity's Sprite-Lit
 *     shader step: "spriteColor * lightSample", nothing more.
 *
 * WHY TWO PHASES INSTEAD OF ONE FILTER (what changed from the previous
 * single-pass version): the old system ran one filter over the WHOLE
 * rendered scene and tried to do "read scene pixel, read all lights,
 * composite" in a single shader — which made it easy for a light's own
 * additive color term to overpower/replace a sprite's actual color
 * (visible as "sprites turn white under any light"). Splitting into
 * two phases makes that structurally impossible: Phase 1 NEVER touches
 * a sprite pixel (it only ever produces a light VALUE), and Phase 2's
 * only operation is multiplying that value into each sprite's own
 * color. A light can dim/tint/brighten a sprite; it can never replace
 * its color, and a shadow can never crush a pixel to flat (0,0,0)
 * unless ambientDarkness/shadowColor are deliberately set that way.
 *
 * COORDINATE SPACE: both phases work in the same WORLD-CONTAINER-LOCAL
 * pixel space Transform.x/y already live in (see _syncStageTransform),
 * so light positions need zero extra conversion whether
 * gameContentContainer is panned/zoomed (editor) or camera-follow
 * translated (play mode/player) — same guarantee the old system had.
 *
 * SHADOW MODES: unchanged from the previous version — "quad" (cheap
 * analytic per-pixel box-shadow test) or "raymarch" (true per-pixel
 * occlusion marching), both compiled into Phase 1's single shader and
 * switchable at runtime via LightingSettings.shadowMode (see
 * LightTextureShaderSource.js's uShadowMode branch).
 *
 * If a scene has ZERO light entities, Phase 1's light texture is never
 * rendered and every sprite's SpriteLightFilter is detached, so a
 * light-less scene pays exactly zero extra GPU cost and renders
 * pixel-identical to before lighting existed — same guarantee the
 * previous version made.
 *
 * Both the editor's Scene/Game viewport and the standalone player get
 * identical lighting because both go through this one System, same as
 * RenderSystem (see RULES.txt #5 — rendering is centralized). This
 * file keeps the SAME public shape (class name LightingSystem,
 * constructor(worldContainer, renderSystem, pixiApp), .update(world))
 * as the previous version so runtime/index.js and
 * editor/viewport/SceneViewport.js need no changes.
 *
 * RUNTIME-ONLY FILE (depends on PIXI, not on the editor).
 */

import { System } from "../core/System.js";
import { TRANSFORM } from "../components/Transform.js";
import { LIGHT, LightType } from "../components/Light.js";
import { SHADOW_CASTER } from "../components/ShadowCaster.js";
import { LIGHTING_SETTINGS } from "../components/LightingSettings.js";
import { LightingQuality, ShadowMode } from "./LightingQuality.js";
import { buildLightTextureFilter, MAX_LIGHTS, MAX_OCCLUDERS, MAX_RAYMARCH_STEPS } from "./LightTextureShaderSource.js";
import { buildSpriteLightFilter } from "./SpriteLightFilter.js";

// Fallback ambient darkness (see components/LightingSettings.js), used
// only when a scene has no LightingSettings component.
const AMBIENT_DARKNESS = 0.65;

// Fallback occluder half-size (px) for a ShadowCaster with no explicit
// width/height override AND no live rendered sprite yet.
const FALLBACK_OCCLUDER_HALF = 24;

// Base shadow-casting distance (world units/px) for Directional
// lights' parallel shadows (see the old system's identical constant).
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
   *   RenderSystem draws sprites into. Phase 1's light texture is
   *   rendered from a SEPARATE offscreen container (never added to
   *   the visible stage) that mirrors this container's light/occluder
   *   DATA (not its display objects) — see _renderLightTexture.
   * @param {import('./RenderSystem.js').RenderSystem} [renderSystem]
   *   used for TWO things now: (1) reading each ShadowCaster entity's
   *   real rendered sprite bounds (unchanged from before), and (2)
   *   Phase 2 — iterating every live tracked sprite via
   *   getTrackedSprites() to attach/update its SpriteLightFilter.
   * @param {PIXI.Application} [pixiApp] used to read renderer.screen
   *   (so both phases always cover the full visible canvas) and to
   *   actually execute Phase 1's offscreen render each frame via
   *   renderer.render().
   */
  constructor(worldContainer, renderSystem, pixiApp) {
    super();
    this.worldContainer = worldContainer;
    this.renderSystem = renderSystem || null;
    this.pixiApp = pixiApp || null;

    this.quality = new LightingQuality();

    this._filterBroken = false;

    // PHASE 1 state: an offscreen container (never attached to the
    // real stage) holding one full-screen quad with the light-texture
    // filter applied, plus the RenderTexture it gets rendered into
    // each frame.
    this._lightTextureFilter = this._buildLightTextureFilterSafely();
    this._lightRenderTexture = null;
    this._lightSourceContainer = null; // offscreen quad the filter is applied to
    this._lightQuad = null;

    // PHASE 2 state: entityId -> PIXI.Filter, one SpriteLightFilter
    // instance per live sprite, kept in sync with RenderSystem's own
    // tracked-sprite set every frame (see _syncSpriteFilters).
    this._spriteFilters = new Map();

    if (this._lightTextureFilter && this.pixiApp && this.pixiApp.renderer) {
      this._setupLightTextureResources();
    }
  }

  /**
   * Wraps buildLightTextureFilter() so a GLSL compile/link failure is
   * reported through console.error (mirrored into the in-engine
   * Console panel by editor/state/ConsoleCapture.js) instead of
   * throwing out of the constructor and taking the whole engine down.
   */
  _buildLightTextureFilterSafely() {
    try {
      return buildLightTextureFilter();
    } catch (err) {
      this._filterBroken = true;
      console.error("[Lighting] Failed to compile light-texture shader — lighting is disabled for this session:", err);
      return null;
    }
  }

  /**
   * Creates the offscreen RenderTexture + a single full-screen quad
   * (a PIXI.Sprite stretched to renderer.screen size, filter-only, no
   * visible texture content of its own) that Phase 1 renders every
   * frame. This mirrors Unity's Light Render Texture: a screen-space
   * buffer that exists independent of any particular sprite.
   */
  _setupLightTextureResources() {
    const screen = this.pixiApp.renderer.screen;
    this._lightRenderTexture = PIXI.RenderTexture.create({
      width: Math.max(1, screen.width),
      height: Math.max(1, screen.height),
      resolution: this.pixiApp.renderer.resolution,
    });

    // A blank white quad is enough — the light-texture filter computes
    // its ENTIRE output from world-position uniforms/varyings, it
    // never samples this quad's own pixels (see
    // LightTextureShaderSource.js's fragment shader: no uSampler at
    // all). The quad exists purely to give the filter a rectangle to
    // run over.
    this._lightQuad = new PIXI.Sprite(PIXI.Texture.WHITE);
    this._lightQuad.width = screen.width;
    this._lightQuad.height = screen.height;
    this._lightQuad.filters = [this._lightTextureFilter];

    this._lightSourceContainer = new PIXI.Container();
    this._lightSourceContainer.addChild(this._lightQuad);
    // Deliberately NEVER added to pixiApp.stage — rendered manually
    // into _lightRenderTexture via renderer.render() each frame
    // instead, so it's never part of the normal visible draw pass.
  }

  update(world) {
    if (this._filterBroken || !this._lightTextureFilter || !this.pixiApp || !this.pixiApp.renderer) {
      this._teardownAllSpriteFilters();
      return;
    }

    const settings = this._readSettings(world);

    const lightEntities = world
      .query(TRANSFORM, LIGHT)
      .filter((e) => e.getComponent(LIGHT).castsOnWorld);

    if (lightEntities.length === 0) {
      this._teardownAllSpriteFilters();
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
          " light(s) will be ignored — remove or disable some lights, or raise MAX_LIGHTS in LightTextureShaderSource.js."
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

      const filter = this._lightTextureFilter;
      filter.uniforms.uLightCount = Math.min(MAX_LIGHTS, lightEntities.length);
      filter.uniforms.uOccluderCount = Math.min(MAX_OCCLUDERS, occluders.length);
      filter.uniforms.uShadowMode = settings.shadowMode === ShadowMode.RAYMARCH ? 1 : 0;
      filter.uniforms.uRaymarchSteps = Math.min(MAX_RAYMARCH_STEPS, Math.max(1, settings.raymarchSteps));
      filter.uniforms.uAmbientDarkness = Math.min(1, Math.max(0, settings.ambientDarkness));
      this._syncStageTransform(filter);

      // PHASE 1: render the light texture, once, this frame.
      this._renderLightTexture();

      // PHASE 2: make sure every live sprite has an up-to-date
      // SpriteLightFilter pointed at this frame's light texture.
      this._syncSpriteFilters();
    } catch (err) {
      this._filterBroken = true;
      this._teardownAllSpriteFilters();
      console.error("[Lighting] Error while updating lighting — lighting disabled for this session:", err);
    }
  }

  /**
   * Resizes the offscreen RenderTexture/quad to match the renderer's
   * current screen size (canvas resize, resolution change), THEN
   * actually executes Phase 1: renders _lightSourceContainer into
   * _lightRenderTexture. This is the literal equivalent of Unity's
   * "draw the Light Textures for this batch" step — a real, separate
   * render pass that happens before any sprite is touched.
   */
  _renderLightTexture() {
    const screen = this.pixiApp.renderer.screen;
    const w = Math.max(1, Math.round(screen.width));
    const h = Math.max(1, Math.round(screen.height));

    if (this._lightRenderTexture.width !== w || this._lightRenderTexture.height !== h) {
      this._lightRenderTexture.resize(w, h);
      this._lightQuad.width = w;
      this._lightQuad.height = h;
    }

    this.pixiApp.renderer.render(this._lightSourceContainer, {
      renderTexture: this._lightRenderTexture,
      clear: true,
    });
  }

  /**
   * PHASE 2 driver: walks every sprite RenderSystem currently tracks
   * (via the new getTrackedSprites() accessor — see RenderSystem.js)
   * and makes sure each one has a SpriteLightFilter attached and
   * pointed at this frame's light texture, adding filters for newly-
   * appeared sprites and removing them for sprites RenderSystem no
   * longer tracks (matches the entity's own lifecycle exactly, no
   * separate cleanup pass needed).
   */
  _syncSpriteFilters() {
    if (!this.renderSystem) return;

    const seen = new Set();
    const screen = this.pixiApp.renderer.screen;
    // PIXI's default WebGL render-to-texture convention is Y-flipped
    // relative to render-to-screen — this single flag (rather than
    // duplicating the whole shader) lets SpriteLightFilter correct for
    // it without needing to know WHY, just whether to.
    const flipY = 1.0;

    for (const [entityId, sprite] of this.renderSystem.getTrackedSprites()) {
      seen.add(entityId);
      let filter = this._spriteFilters.get(entityId);
      if (!filter) {
        filter = buildSpriteLightFilter();
        this._spriteFilters.set(entityId, filter);
      }

      filter.uniforms.uLightTexture = this._lightRenderTexture;
      filter.uniforms.uLightTexSize[0] = screen.width;
      filter.uniforms.uLightTexSize[1] = screen.height;
      filter.uniforms.uLightTexFlipY = flipY;

      const existing = sprite.filters || [];
      if (existing.indexOf(filter) === -1) {
        sprite.filters = [...existing.filter((f) => f !== filter), filter];
      }
    }

    // Detach + drop filters for sprites that no longer exist.
    for (const [entityId, filter] of this._spriteFilters) {
      if (seen.has(entityId)) continue;
      this._spriteFilters.delete(entityId);
      // The sprite itself is already destroyed by RenderSystem by the
      // time we get here in the normal case, so there's usually
      // nothing left to detach from — this is just belt-and-suspenders
      // cleanup of our own map.
    }
  }

  /**
   * Removes every sprite's SpriteLightFilter (scene has zero active
   * lights, or the light-texture shader is broken) so lighting has
   * exactly zero visual/GPU effect, matching the previous version's
   * "detach filter -> pixel-identical to before lighting existed"
   * guarantee.
   */
  _teardownAllSpriteFilters() {
    if (!this.renderSystem) {
      this._spriteFilters.clear();
      return;
    }
    for (const [entityId, sprite] of this.renderSystem.getTrackedSprites()) {
      const filter = this._spriteFilters.get(entityId);
      if (!filter || !sprite.filters) continue;
      const remaining = sprite.filters.filter((f) => f !== filter);
      sprite.filters = remaining.length ? remaining : null;
    }
    this._spriteFilters.clear();
  }

  /**
   * Reads the scene's LightingSettings component, if any — identical
   * semantics to the previous version.
   */
  _readSettings(world) {
    const entity = world.query(LIGHTING_SETTINGS)[0];
    const settings = entity ? entity.getComponent(LIGHTING_SETTINGS) : null;
    return {
      shadowMode: settings ? settings.shadowMode : this.quality.shadowMode,
      raymarchSteps: settings ? settings.raymarchSteps : this.quality.raymarchSteps,
      ambientDarkness: settings ? settings.ambientDarkness : AMBIENT_DARKNESS,
    };
  }

  /**
   * Uploads gameContentContainer's actual on-screen transform (plain
   * translate + uniform scale) to the given filter so Phase 1's
   * shader can convert screen-space pixels back to world space.
   * Identical approach/rationale to the previous version — walked by
   * hand from .x/.y/.scale.x up the parent chain rather than read off
   * .worldTransform, to always be exactly in sync with the frame
   * about to render rather than one frame stale.
   */
  _syncStageTransform(filter) {
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
    filter.uniforms.uStageOffset[0] = offsetX;
    filter.uniforms.uStageOffset[1] = offsetY;
    filter.uniforms.uStageScale = scale || 1;
  }

  /**
   * Fills Phase 1's per-light uniform arrays. Identical semantics to
   * the previous version — only the shader consuming this data moved
   * files (LightTextureShaderSource.js instead of
   * LightingShaderSource.js).
   */
  _fillLightUniforms(lightEntities, occluders) {
    const u = this._lightTextureFilter.uniforms;
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
      u.uLightShadowReach[i] =
        light.type === LightType.DIRECTIONAL ? DIRECTIONAL_SHADOW_BASE_DISTANCE : Math.max(0.0001, light.radius || 0);
    }
  }

  /**
   * Fills Phase 1's per-occluder uniform arrays. Identical semantics
   * to the previous version (LightTextureShaderSource.js consumes
   * this data now instead of the old LightingShaderSource.js).
   */
  _fillOccluderUniforms(occluders) {
    const u = this._lightTextureFilter.uniforms;
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
   * box. Identical semantics to the previous version.
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
    this._teardownAllSpriteFilters();
    if (this._lightTextureFilter) this._lightTextureFilter.destroy();
    if (this._lightRenderTexture) this._lightRenderTexture.destroy(true);
    if (this._lightSourceContainer) this._lightSourceContainer.destroy({ children: true });
  }
}
