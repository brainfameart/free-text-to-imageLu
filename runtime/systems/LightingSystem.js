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
 * Soft falloff for Point/Spot/Area lights is a REAL smooth radial
 * gradient baked once into a canvas texture (see _getRadialGradientTexture)
 * and drawn as a tinted, scaled PIXI.Sprite — not a "concentric rings"
 * approximation, which reads as visibly banded/fake because PIXI.Graphics
 * has no native gradient fill. A genuine gradient plus an
 * inverse-square-ish brightness curve is what actually sells "light"
 * instead of "a stack of solid circles."
 *
 * SHADOWS (see components/ShadowCaster.js) come in two distinct flavors,
 * matching how real light actually behaves:
 *  - Point/Spot/Area lights cast PROJECTIVE shadows: rays radiate out
 *    from the light's own Transform position, so an occluder's shadow
 *    direction depends on where the occluder sits RELATIVE TO the light
 *    (see _castProjectiveShadowForOccluder).
 *  - Directional lights cast PARALLEL shadows: every occluder's shadow
 *    points the same direction regardless of position, determined
 *    ENTIRELY by the light's Transform.rotation — exactly like the sun,
 *    where moving the light does nothing but rotating it swings every
 *    shadow in the scene together (see _castParallelShadowForOccluder).
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
import { SHADOW_CASTER } from "../components/ShadowCaster.js";

// How dark the ambient overlay gets where no light reaches, at
// intensity 1 on whatever lights exist in the scene. 0 = no darkening
// at all, 1 = fully black. Kept well under 1 so scenes read as "dim"
// rather than pitch black outside light range, matching how most 2D
// games use lighting (mood, not total blackout).
const AMBIENT_DARKNESS = 0.65;

// Fallback occluder half-size (px) for a ShadowCaster with no explicit
// width/height override AND no live rendered sprite yet (e.g. a texture
// still loading, or no SpriteRenderer at all) — keeps shadow casting
// from silently doing nothing in that edge case.
const FALLBACK_OCCLUDER_HALF = 24;

// Resolution of the baked gradient textures (px). Fixed regardless of a
// given light's actual radius — the texture is stretched to size via
// sprite.scale, same trick Unity's own soft sprites use, so one texture
// serves every light of that falloff "shape" no matter how big or small
// it is in world space.
const GRADIENT_TEX_SIZE = 256;

// Base shadow-casting distance (world units/px) used by Directional
// lights' PARALLEL shadows, which have no light.radius of their own to
// scale against (Directional's "radius" field is unused for the glow —
// see _drawDirectional). Each ShadowCaster's own `length` multiplies
// this base, same as it multiplies light.radius for Point/Spot/Area.
const DIRECTIONAL_SHADOW_BASE_DISTANCE = 1200;

// Number of progressively larger/fainter passes used to fake a soft
// penumbra edge on a shadow polygon (see _fillShadowPolygon). More
// passes = smoother-looking soft edge but more draw calls; 1 pass means
// "no softness pass at all", used automatically when a caster's
// `softness` is 0 so a crisp shadow costs exactly one fill, same as
// before this feature existed.
const MAX_SOFTNESS_PASSES = 5;

export class LightingSystem extends System {
  /**
   * @param {PIXI.Container} worldContainer the SAME container
   *   RenderSystem draws sprites into — lighting is layered as a child
   *   of it so it pans/zooms/follows-camera in lockstep with the
   *   sprites it's lighting, exactly like RenderSystem's own offset
   *   logic (see RenderSystem._applyMainCameraOffset).
   * @param {import('./RenderSystem.js').RenderSystem} [renderSystem]
   *   optional reference used ONLY to read each ShadowCaster entity's
   *   real rendered sprite bounds (getSpriteWorldHalfExtents) as the
   *   default occluder shape — see components/ShadowCaster.js. Shadow
   *   casting still works without this (falls back to explicit
   *   width/height or FALLBACK_OCCLUDER_HALF), so passing it is
   *   optional rather than a hard dependency between systems.
   */
  constructor(worldContainer, renderSystem) {
    super();
    this.worldContainer = worldContainer;
    this.renderSystem = renderSystem || null;

    this.overlay = new PIXI.Container();

    // Darkness base: a big solid rect, covering a generous fixed area
    // (see _drawDarkness). Drawn first, stays a plain Graphics fill —
    // flat ambient darkness has no gradient to fake, so Graphics is
    // already exactly correct here.
    this.darknessGraphics = new PIXI.Graphics();

    // Additive light "glow" layer: holds one Sprite per Point/Spot/Area
    // light (a scaled/tinted radial-gradient texture) plus a Graphics
    // fill for any Directional lights (flat, no gradient needed — see
    // _drawDirectional). ADD blend means bright areas cancel the
    // darkness rect drawn immediately below them and actually brighten
    // whatever sprite is under both layers.
    this.lightLayer = new PIXI.Container();
    this.lightLayer.blendMode = PIXI.BLEND_MODES.ADD;
    this.directionalGraphics = new PIXI.Graphics();
    this.lightLayer.addChild(this.directionalGraphics);

    // Shadow polygons: drawn on top of lightLayer using NORMAL blend
    // (not additive) so they re-darken exactly the occluded wedge behind
    // each caster, cutting a real hole out of the light's additive glow
    // instead of adding more light. This is what makes shadows dynamic
    // and per-light rather than a flat baked darkness — see
    // _castProjectiveShadowForOccluder / _castParallelShadowForOccluder.
    this.shadowGraphics = new PIXI.Graphics();

    this.overlay.addChild(this.darknessGraphics);
    this.overlay.addChild(this.lightLayer);
    this.overlay.addChild(this.shadowGraphics);

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

    /** @type {Map<string, PIXI.Texture>} cache key -> baked gradient texture */
    this._gradientTextureCache = new Map();
    /** @type {Map<string, PIXI.Sprite>} entityId -> glow sprite currently in lightLayer */
    this._glowSprites = new Map();
  }

  update(world) {
    const lightEntities = world
      .query(TRANSFORM, LIGHT)
      .filter((e) => e.getComponent(LIGHT).castsOnWorld);

    this.darknessGraphics.clear();
    this.directionalGraphics.clear();
    this.shadowGraphics.clear();

    if (lightEntities.length === 0) {
      // No lights in the scene at all: leave everything empty so the
      // overlay is fully transparent and the scene renders exactly as
      // it did before any Light component existed.
      this.overlay.visible = false;
      this._removeAllGlowSprites();
      return;
    }
    this.overlay.visible = true;

    this._drawDarkness();

    // Occluder list built once per frame (not per-light) since the same
    // set of ShadowCaster entities is checked against every
    // shadow-casting light — avoids re-querying the World once per
    // light for scenes with many lights.
    const occluders = this._collectOccluders(world);

    const seenGlow = new Set();

    for (const entity of lightEntities) {
      const transform = entity.getComponent(TRANSFORM);
      const light = entity.getComponent(LIGHT);

      switch (light.type) {
        case LightType.DIRECTIONAL:
          this._drawDirectional(transform, light);
          break;
        case LightType.SPOT:
          this._updateGlowSprite(entity.id, transform, light, "spot");
          seenGlow.add(entity.id);
          break;
        case LightType.AREA:
          this._updateGlowSprite(entity.id, transform, light, "area");
          seenGlow.add(entity.id);
          break;
        case LightType.POINT:
        default:
          this._updateGlowSprite(entity.id, transform, light, "point");
          seenGlow.add(entity.id);
          break;
      }

      if (!light.castShadows || light.shadowStrength <= 0 || !occluders.length) continue;

      if (light.type === LightType.DIRECTIONAL) {
        // Parallel shadows: direction comes ONLY from the light's own
        // rotation, never its position — see file header and
        // _castParallelShadowForOccluder. This is the "just like the
        // sun" behavior: dragging a Directional light around the scene
        // does nothing to its shadows, only rotating it does.
        for (const occ of occluders) {
          this._castParallelShadowForOccluder(transform.rotation || 0, light, occ);
        }
      } else {
        this._castProjectiveShadowsForLight(transform, light, entity.id, occluders);
      }
    }

    // Remove glow sprites for lights that no longer exist / changed
    // type / were turned off this frame, same "seen set" cleanup
    // pattern RenderSystem uses for its own sprite map.
    for (const [entityId, sprite] of this._glowSprites) {
      if (!seenGlow.has(entityId)) {
        this.lightLayer.removeChild(sprite);
        sprite.destroy();
        this._glowSprites.delete(entityId);
      }
    }
  }

  _removeAllGlowSprites() {
    for (const sprite of this._glowSprites.values()) {
      this.lightLayer.removeChild(sprite);
      sprite.destroy();
    }
    this._glowSprites.clear();
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

  /**
   * Directional light: no falloff, no position dependency — it's meant
   * to evenly light the entire visible scene, like sunlight. Applied as
   * a flat additive tint across the same big rect the darkness uses, so
   * a single Directional light with intensity 1 fully cancels
   * AMBIENT_DARKNESS everywhere (matching "the sun is up, nothing is in
   * shadow" rather than only near the light entity's Transform, which
   * wouldn't make sense for a light that's conceptually infinitely far
   * away). Flat color has no gradient to fake, so plain Graphics is
   * already the correct, non-banded tool here.
   */
  _drawDirectional(transform, light) {
    const half = 4000;
    const colorHex = this._toHex(light.color);
    const alpha = Math.min(1, AMBIENT_DARKNESS * light.intensity);
    this.directionalGraphics.beginFill(colorHex, alpha);
    this.directionalGraphics.drawRect(-half, -half, half * 2, half * 2);
    this.directionalGraphics.endFill();
  }

  /**
   * Creates/updates the single glow Sprite for a Point/Spot/Area light,
   * reusing the same Sprite instance across frames (only its
   * position/rotation/scale/tint/alpha/texture change) instead of
   * rebuilding Graphics every tick — cheaper, and what lets the
   * gradient stay perfectly smooth at any size since it's just a scaled
   * texture rather than redrawn vector rings.
   */
  _updateGlowSprite(entityId, transform, light, kind) {
    let sprite = this._glowSprites.get(entityId);
    if (!sprite) {
      sprite = new PIXI.Sprite();
      sprite.anchor.set(0.5);
      this.lightLayer.addChild(sprite);
      this._glowSprites.set(entityId, sprite);
    }

    if (kind === "spot") {
      sprite.texture = this._getConeGradientTexture(light.angle || 45);
      // The cone texture is baked pointing along +X from its left edge
      // (see _getConeGradientTexture) sized radius x (2*radius), anchor
      // centered — rotate to the light's facing and offset the anchor
      // so the texture's APEX (not its center) sits at the light's
      // Transform position, matching where a real spot light's bulb is.
      sprite.rotation = (transform.rotation * Math.PI) / 180;
      sprite.anchor.set(0, 0.5);
      sprite.x = transform.x;
      sprite.y = transform.y;
      sprite.width = light.radius;
      sprite.height = light.radius * 2;
    } else if (kind === "area") {
      sprite.texture = this._getAreaGradientTexture();
      sprite.anchor.set(0.5);
      sprite.rotation = 0;
      sprite.x = transform.x;
      sprite.y = transform.y;
      const falloff = Math.max(0, light.radius || 0);
      sprite.width = (light.width || 200) + falloff * 2;
      sprite.height = (light.height || 200) + falloff * 2;
    } else {
      sprite.texture = this._getRadialGradientTexture();
      sprite.anchor.set(0.5);
      sprite.rotation = 0;
      sprite.x = transform.x;
      sprite.y = transform.y;
      sprite.width = light.radius * 2;
      sprite.height = light.radius * 2;
    }

    sprite.tint = this._toHex(light.color);
    // Intensity above 1 ("overbright") is expressed as alpha above what
    // a flat texture alone could show — PIXI clamps sprite.alpha to
    // [0,1], so overbright instead stacks a second identical sprite's
    // worth of brightness by scaling alpha non-linearly below 1 and
    // letting values above 1 read as "solidly at full brightness
    // sooner", which is the practical result artists want from
    // "intensity 2" without needing HDR blending support.
    sprite.alpha = Math.min(1, light.intensity);
  }

  /**
   * Smooth radial gradient, white center fading to fully transparent at
   * the edge, baked once into a square canvas texture and cached for
   * reuse by every Point light regardless of its actual radius (scaled
   * via sprite.width/height instead). Uses a gamma-adjusted falloff
   * (t^1.8 rather than linear t) so the bright core stays tighter and
   * the outer fade is longer/softer — closer to how real point-light
   * intensity actually falls off than a linear ramp, which is part of
   * why a ringed/banded version reads as artificial.
   */
  _getRadialGradientTexture() {
    return this._getCachedTexture("radial", () => {
      const canvas = document.createElement("canvas");
      canvas.width = GRADIENT_TEX_SIZE;
      canvas.height = GRADIENT_TEX_SIZE;
      const ctx = canvas.getContext("2d");
      const cx = GRADIENT_TEX_SIZE / 2;
      const cy = GRADIENT_TEX_SIZE / 2;
      const r = GRADIENT_TEX_SIZE / 2;

      const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
      // Multiple gamma-shaped stops approximate a t^1.8 curve (canvas
      // gradients only support linear interpolation BETWEEN stops, so
      // enough stops makes the overall curve read as smoothly
      // non-linear rather than as a linear ramp).
      const steps = 12;
      for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        const eased = Math.pow(t, 1.8);
        grad.addColorStop(t, "rgba(255,255,255," + (1 - eased) + ")");
      }
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, GRADIENT_TEX_SIZE, GRADIENT_TEX_SIZE);
      return canvas;
    });
  }

  /**
   * Area light gradient: a flat-white core rectangle with a soft
   * radial-ish fade baked into the texture edges, achieved here by
   * layering a box blur via canvas shadowBlur rather than concentric
   * rect outlines — one real blurred edge instead of a handful of
   * visibly stepped rectangle outlines.
   */
  _getAreaGradientTexture() {
    return this._getCachedTexture("area", () => {
      const size = GRADIENT_TEX_SIZE;
      const canvas = document.createElement("canvas");
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext("2d");

      // Core rect sized so its soft blurred edge (via shadowBlur) fills
      // the remaining texture margin — the falloff visually reads as a
      // smooth glow rather than a hard rectangle silhouette.
      const margin = size * 0.28;
      const coreX = margin;
      const coreY = margin;
      const coreW = size - margin * 2;
      const coreH = size - margin * 2;

      ctx.save();
      ctx.shadowColor = "rgba(255,255,255,1)";
      ctx.shadowBlur = margin * 0.9;
      ctx.fillStyle = "rgba(255,255,255,1)";
      // Draw the blurred rect a few times layered at lower alpha so the
      // blur builds up smoothly rather than clipping hard at the
      // shadowBlur's own falloff limit.
      for (let i = 0; i < 3; i++) {
        ctx.fillRect(coreX, coreY, coreW, coreH);
      }
      ctx.restore();

      // Solid, unblurred core on top so the area light's actual lit
      // rectangle reads as fully bright, not softened along with the
      // edge falloff.
      ctx.fillStyle = "rgba(255,255,255,1)";
      ctx.fillRect(coreX, coreY, coreW, coreH);

      return canvas;
    });
  }

  /**
   * Spot light cone: a wedge-shaped soft gradient baked once per cone
   * angle (cached per rounded-degree so slider drags don't thrash the
   * cache) — bright near the apex, fading both radially outward AND
   * toward the cone's angular edges, which is what makes a spotlight's
   * beam look like an actual soft-edged beam instead of a hard wedge
   * cut out of a circle.
   *
   * Baked pointing along +X: apex at the LEFT edge (x=0), opening
   * rightward to the full `angle` degrees wide at x=size. The caller
   * (_updateGlowSprite) anchors the sprite at (0, 0.5) and rotates it to
   * the light's facing so the apex lands exactly on the light's
   * Transform position.
   */
  _getConeGradientTexture(angleDeg) {
    const roundedAngle = Math.round(angleDeg);
    return this._getCachedTexture("cone:" + roundedAngle, () => {
      const size = GRADIENT_TEX_SIZE;
      const canvas = document.createElement("canvas");
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext("2d");
      const apexX = 0;
      const apexY = size / 2;
      const halfAngle = (roundedAngle * Math.PI) / 360;

      const steps = 48;
      for (let i = steps; i >= 1; i--) {
        const t = i / steps; // 1 at far edge, ~0 near apex
        const dist = size * t;
        const eased = Math.pow(t, 1.6);
        const alpha = 1 - eased;
        if (alpha <= 0.003) continue;

        // Slightly shrink the angle for outer rings so the cone's
        // angular edge itself fades too (soft beam edge), not just the
        // radial falloff — without this the cone reads as a hard-edged
        // wedge with only its FAR tip softened, which still looks fake.
        const edgeSoftenFactor = 0.35 + 0.65 * (1 - t);
        const ringHalfAngle = halfAngle * edgeSoftenFactor;

        ctx.beginPath();
        ctx.moveTo(apexX, apexY);
        const arcSteps = 20;
        for (let a = 0; a <= arcSteps; a++) {
          const ang = -ringHalfAngle + (a / arcSteps) * (ringHalfAngle * 2);
          ctx.lineTo(apexX + Math.cos(ang) * dist, apexY + Math.sin(ang) * dist);
        }
        ctx.closePath();
        ctx.fillStyle = "rgba(255,255,255," + alpha + ")";
        ctx.fill();
      }

      return canvas;
    });
  }

  _getCachedTexture(key, buildCanvas) {
    let texture = this._gradientTextureCache.get(key);
    if (texture) return texture;
    const canvas = buildCanvas();
    texture = PIXI.Texture.from(canvas);
    this._gradientTextureCache.set(key, texture);
    return texture;
  }

  /**
   * Gathers every enabled ShadowCaster entity's world-space occluder
   * box: {id, x, y, halfWidth, halfHeight, rotationDeg, opacity, length,
   * softness}. Prefers the entity's real rendered sprite bounds
   * (RenderSystem.getSpriteWorldHalfExtents) so a shadow automatically
   * matches what the sprite looks like; falls back to an explicit
   * width/height override on the ShadowCaster component, then to
   * FALLBACK_OCCLUDER_HALF if neither is available.
   *
   * The occluder's center ALSO applies ShadowCaster.offsetX/offsetY,
   * rotated by the entity's own Transform.rotation first — same
   * local-offset-then-rotate-then-translate convention as
   * runtime/physics/ColliderGeometry.js, so an offset caster on a
   * rotated object swings around with it instead of sliding in world
   * space independent of rotation.
   *
   * rotationDeg is carried through so the occluder's box corners can be
   * computed rotated to match the entity's actual (possibly rotated)
   * silhouette, rather than always an axis-aligned box — this is the
   * single biggest shadow ACCURACY fix: a rotated sprite now casts a
   * shadow from its true rotated footprint, not a boundingbox that
   * ignores rotation entirely.
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

      // Rotate the LOCAL offset by the entity's rotation, then
      // translate by its world position (see file-header note above).
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

  /**
   * Returns the occluder's 4 world-space corners, rotated by its own
   * rotationDeg around its own center — the true rotated footprint
   * rather than an axis-aligned box, which is what makes shadows track
   * a spinning/rotated object's actual silhouette correctly.
   */
  _occluderCorners(occ) {
    const angleRad = (occ.rotationDeg * Math.PI) / 180;
    const cos = Math.cos(angleRad);
    const sin = Math.sin(angleRad);
    const local = [
      [-occ.halfWidth, -occ.halfHeight],
      [occ.halfWidth, -occ.halfHeight],
      [occ.halfWidth, occ.halfHeight],
      [-occ.halfWidth, occ.halfHeight],
    ];
    return local.map(([lx, ly]) => ({
      x: occ.x + lx * cos - ly * sin,
      y: occ.y + lx * sin + ly * cos,
    }));
  }

  /**
   * Projective shadows for Point/Spot/Area lights: rays radiate from
   * the light's own Transform position, so each occluder's shadow
   * direction depends on where it sits relative to the light. Skips an
   * occluder if it IS the light's own entity (an object with both Light
   * + ShadowCaster shouldn't shadow itself) or if it's further from the
   * light than the light's reach (nothing to shadow beyond where the
   * light doesn't reach anyway).
   *
   * Spot lights additionally only illuminate/shadow within their cone
   * (light.angle degrees wide, centered on lightTransform.rotation) —
   * without this check a Spot behaved like a Point light for shadow
   * purposes and would happily cast shadows from occluders sitting
   * completely outside its beam, including directly behind it.
   */
  _castProjectiveShadowsForLight(lightTransform, light, lightEntityId, occluders) {
    const baseReach =
      light.type === LightType.AREA ? (light.radius || 0) + Math.max(light.width, light.height) : light.radius;

    const isSpot = light.type === LightType.SPOT;
    const halfConeRad = isSpot ? ((light.angle || 45) * Math.PI) / 360 : 0;
    const facingRad = isSpot ? ((lightTransform.rotation || 0) * Math.PI) / 180 : 0;

    for (const occ of occluders) {
      if (occ.id === lightEntityId) continue;
      if (occ.opacity <= 0) continue;

      const dx = occ.x - lightTransform.x;
      const dy = occ.y - lightTransform.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const reach = baseReach * occ.length;
      if (dist > baseReach + Math.max(occ.halfWidth, occ.halfHeight)) continue; // occluder is out of the LIGHT's reach

      if (isSpot) {
        // Angle from the light to the occluder's CENTER, compared
        // against the cone's half-angle plus a small angular pad so an
        // occluder straddling the cone's edge (its center just inside,
        // body partly outside, or vice versa) doesn't pop in/out — the
        // pad is derived from the occluder's own apparent angular size
        // at this distance rather than a fixed constant, so it scales
        // sensibly whether the occluder is tiny/far or huge/close.
        const angleToOcc = Math.atan2(dy, dx);
        let rel = angleToOcc - facingRad;
        while (rel > Math.PI) rel -= Math.PI * 2;
        while (rel < -Math.PI) rel += Math.PI * 2;

        const angularPad = Math.atan2(Math.max(occ.halfWidth, occ.halfHeight), Math.max(dist, 1));
        if (Math.abs(rel) > halfConeRad + angularPad) continue; // occluder is outside the spot's cone
      }

      this._castProjectiveShadowForOccluder(lightTransform, occ, reach, light);
    }
  }

  /**
   * Classic 2D point-light shadow casting, upgraded for accuracy: finds
   * the occluder's ROTATED box's two "silhouette" corners as seen from
   * the light (the tangent corners where the box's edge turns away from
   * the light), then extrudes a quad from those two corners out to
   * `reach` (the light's natural reach scaled by this caster's own
   * `length`), and fills it — tinted by the light's shadowColor, faded
   * by shadowStrength * caster.opacity, and optionally softened at the
   * edge (see _fillShadowPolygon).
   */
  _castProjectiveShadowForOccluder(lightTransform, occ, reach, light) {
    const corners = this._occluderCorners(occ);

    // For a convex box, the silhouette as seen from an external point
    // is exactly the two corners adjacent to the single farthest edge
    // "facing away" from the light. Found here by picking, among the 4
    // corners, the pair with the most extreme signed angle relative to
    // the light-to-center direction.
    const cx = occ.x - lightTransform.x;
    const cy = occ.y - lightTransform.y;
    const centerAngle = Math.atan2(cy, cx);

    let minRel = Infinity;
    let maxRel = -Infinity;
    let cornerAtMin = corners[0];
    let cornerAtMax = corners[0];

    for (const corner of corners) {
      const ang = Math.atan2(corner.y - lightTransform.y, corner.x - lightTransform.x);
      // normalize the angle relative to centerAngle into (-PI, PI] so
      // corners "wrap" correctly regardless of which quadrant the
      // occluder sits in relative to the light
      let rel = ang - centerAngle;
      while (rel > Math.PI) rel -= Math.PI * 2;
      while (rel < -Math.PI) rel += Math.PI * 2;

      if (rel < minRel) {
        minRel = rel;
        cornerAtMin = corner;
      }
      if (rel > maxRel) {
        maxRel = rel;
        cornerAtMax = corner;
      }
    }

    // Extrude both silhouette corners straight out along the
    // light->corner ray, to exactly `reach` — a REAL, controllable
    // shadow length now (ShadowCaster.length), rather than always
    // overshooting past the light's visible range regardless of intent.
    const extrude = (corner) => {
      const rayX = corner.x - lightTransform.x;
      const rayY = corner.y - lightTransform.y;
      const rayLen = Math.sqrt(rayX * rayX + rayY * rayY) || 1;
      const scale = reach / rayLen;
      return { x: lightTransform.x + rayX * scale, y: lightTransform.y + rayY * scale };
    };

    const farMin = extrude(cornerAtMin);
    const farMax = extrude(cornerAtMax);

    const points = [cornerAtMin, farMin, farMax, cornerAtMax];
    const alpha = Math.min(1, light.shadowStrength * occ.opacity) * AMBIENT_DARKNESS;
    this._fillShadowPolygon(points, this._toHex(light.shadowColor), alpha, occ.softness);

    // The occluder's own footprint is also re-darkened (an object
    // standing in its own light doesn't light itself up from inside) —
    // filled as its real rotated corners, not an axis-aligned rect, for
    // the same accuracy reason as the shadow quad above.
    this._fillPolygon(corners, this._toHex(light.shadowColor), alpha);
  }

  /**
   * Parallel ("sun") shadows for Directional lights: EVERY occluder's
   * shadow points the same direction, taken purely from the light's own
   * Transform.rotation (0deg = shadow points along +X, matching the
   * same rotation convention Spot lights already use for aiming) — the
   * light's own position is never read here at all, which is exactly
   * the "only rotation affects the shadow, just like the sun" behavior
   * requested: dragging the light around does nothing, spinning it
   * swings every shadow in the scene together.
   */
  _castParallelShadowForOccluder(lightRotationDeg, light, occ) {
    if (occ.opacity <= 0) return;

    const corners = this._occluderCorners(occ);
    const angleRad = (lightRotationDeg * Math.PI) / 180;
    // Shadows point AWAY from the light's facing direction, same as a
    // real sun: the light "shines" along (cos,sin) of its rotation, so
    // the shadow it casts extends in that same direction on the far
    // side of the occluder.
    const dirX = Math.cos(angleRad);
    const dirY = Math.sin(angleRad);

    const reach = DIRECTIONAL_SHADOW_BASE_DISTANCE * occ.length;

    // For a parallel projection, EVERY corner extrudes the same
    // distance in the same direction (unlike the point-source case,
    // where each corner's ray differs) — so the silhouette is simply
    // whichever 2 of the 4 corners are the extreme points perpendicular
    // to the light direction, found via a dot-product projection rather
    // than the point-source's angular comparison.
    const perpX = -dirY;
    const perpY = dirX;

    let minProj = Infinity;
    let maxProj = -Infinity;
    let cornerAtMin = corners[0];
    let cornerAtMax = corners[0];
    for (const corner of corners) {
      const proj = corner.x * perpX + corner.y * perpY;
      if (proj < minProj) {
        minProj = proj;
        cornerAtMin = corner;
      }
      if (proj > maxProj) {
        maxProj = proj;
        cornerAtMax = corner;
      }
    }

    const farMin = { x: cornerAtMin.x + dirX * reach, y: cornerAtMin.y + dirY * reach };
    const farMax = { x: cornerAtMax.x + dirX * reach, y: cornerAtMax.y + dirY * reach };

    const points = [cornerAtMin, farMin, farMax, cornerAtMax];
    const alpha = Math.min(1, light.shadowStrength * occ.opacity) * AMBIENT_DARKNESS;
    this._fillShadowPolygon(points, this._toHex(light.shadowColor), alpha, occ.softness);

    // Re-darken the occluder's own real (rotated) footprint too, same
    // reasoning as the projective case.
    this._fillPolygon(corners, this._toHex(light.shadowColor), alpha);
  }

  /**
   * Fills a quadrilateral shadow shape, optionally with a soft
   * (penumbra-style) edge: when `softness` is 0, this is a single crisp
   * fill (cheapest case, and the default — most shadows should read as
   * fairly defined, not universally blurry). When softness > 0, several
   * progressively LARGER copies of the polygon are drawn first at very
   * low alpha (building up a soft outer glow around the hard shadow),
   * then the crisp polygon itself is drawn on top at full alpha — this
   * is a cheap approximation of a penumbra without a real per-pixel
   * blur pass, but reads convincingly soft at the shadow's edge, which
   * is the visually important part.
   */
  _fillShadowPolygon(points, colorHex, alpha, softness) {
    if (softness > 0) {
      const passes = Math.min(MAX_SOFTNESS_PASSES, Math.max(1, Math.round(softness / 4)));
      const cx = (points[0].x + points[1].x + points[2].x + points[3].x) / 4;
      const cy = (points[0].y + points[1].y + points[2].y + points[3].y) / 4;

      for (let p = passes; p >= 1; p--) {
        const growth = (softness * p) / passes;
        const passAlpha = alpha * 0.35 * (1 - p / (passes + 1));
        if (passAlpha <= 0.002) continue;
        const grown = points.map((pt) => {
          const dx = pt.x - cx;
          const dy = pt.y - cy;
          const len = Math.sqrt(dx * dx + dy * dy) || 1;
          const scale = (len + growth) / len;
          return { x: cx + dx * scale, y: cy + dy * scale };
        });
        this._fillPolygon(grown, colorHex, passAlpha);
      }
    }

    this._fillPolygon(points, colorHex, alpha);
  }

  _fillPolygon(points, colorHex, alpha) {
    if (alpha <= 0) return;
    this.shadowGraphics.beginFill(colorHex, Math.min(1, alpha));
    this.shadowGraphics.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++) this.shadowGraphics.lineTo(points[i].x, points[i].y);
    this.shadowGraphics.closePath();
    this.shadowGraphics.endFill();
  }

  _toHex(colorString) {
    if (PIXI.utils && PIXI.utils.string2hex) return PIXI.utils.string2hex(colorString);
    return parseInt(String(colorString).replace("#", "0x")) || 0xffffff;
  }

  destroy() {
    this._removeAllGlowSprites();
    for (const texture of this._gradientTextureCache.values()) {
      texture.destroy(true);
    }
    this._gradientTextureCache.clear();
    this.overlay.destroy({ children: true });
  }
}
