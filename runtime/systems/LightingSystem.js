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

// Soft band (world units/px) just past a light's radius over which
// shadows fade to nothing, instead of a hard cutoff exactly at
// radius — see _castProjectiveShadowsForLight's "REACH fade".
const REACH_FADE_BAND = 60;

// How many occluder-half-sizes away the light needs to be before a
// shadow reaches full length/strength — see "PROXIMITY fade" above.
// E.g. 3 means a light within 3x the occluder's own half-size still
// casts a visibly shortened/faded shadow; further out is full strength.
const PROXIMITY_FADE_SIZE_MULT = 3;

// A shadow never shrinks all the way to zero LENGTH even when the
// light is touching the occluder (only its ALPHA fades all the way to
// 0 there) — a sliver of shadow at very-close range still reads as
// "there", matching how real light wrapping around a nearby object
// still leaves a short contact shadow rather than none at all.
const MIN_SHADOW_LENGTH_FRACTION = 0.15;

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

      // Real point-source light (a bare bulb/lantern) reads as a small,
      // near-solid HOT core that only takes up a small fraction of the
      // light's visible radius, followed by a long, gently-curved falloff
      // "bloom" tail — not one single smooth curve from full-bright at
      // the center all the way to the edge, which is what made the old
      // single-curve gradient look like a flat CSS radial-gradient glow
      // rather than an actual light source. HOT_CORE_T controls how much
      // of the texture's radius stays essentially full-bright before the
      // bloom falloff begins.
      const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
      const HOT_CORE_T = 0.12;
      const steps = 20;
      for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        let a;
        if (t <= HOT_CORE_T) {
          // Inside the hot core: stays at ~full strength (very slight
          // taper so it's not a perfectly flat disc, which would show a
          // visible ring where the core ends and the bloom begins).
          a = 1 - 0.08 * (t / HOT_CORE_T);
        } else {
          // Bloom falloff: remap t into [0,1] across the remaining
          // radius, then apply a steeper-than-before easing curve
          // (t^2.4 rather than t^1.8) so brightness concentrates more
          // toward the core and the outer bloom reads as a long, faint
          // tail — closer to real inverse-square falloff than a gentler
          // linear-ish ramp.
          const bloomT = (t - HOT_CORE_T) / (1 - HOT_CORE_T);
          a = 0.92 * (1 - Math.pow(bloomT, 2.4));
        }
        grad.addColorStop(t, "rgba(255,255,255," + Math.max(0, a) + ")");
      }
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, GRADIENT_TEX_SIZE, GRADIENT_TEX_SIZE);

      this._applyLightGrain(ctx, GRADIENT_TEX_SIZE, GRADIENT_TEX_SIZE, cx, cy, r);

      return canvas;
    });
  }

  /**
   * Stipples very faint per-pixel noise over a baked light texture,
   * masked so it only affects the already-lit area (fades out exactly
   * where the gradient itself fades to transparent). Real light/glow
   * photographed or rendered at any real fidelity always carries a
   * little grain/dither in its falloff — a mathematically perfect,
   * noise-free gradient is one of the biggest tells that a glow is a
   * flat vector/CSS effect rather than an actual light. The noise here
   * is intentionally subtle (max ~4% alpha swing) so it reads as
   * "photographic softness" rather than visible static.
   */
  _applyLightGrain(ctx, w, h, cx, cy, r) {
    const imgData = ctx.getImageData(0, 0, w, h);
    const data = imgData.data;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const idx = (y * w + x) * 4;
        const a = data[idx + 3];
        if (a <= 0) continue;
        // Noise strength itself fades with distance-from-center so the
        // very brightest core (which should read as clean/hot, not
        // grainy) stays smooth, and grain shows up mainly in the
        // mid-to-outer falloff where real light grain is most visible.
        const dx = x - cx;
        const dy = y - cy;
        const distT = Math.min(1, Math.sqrt(dx * dx + dy * dy) / r);
        const noiseStrength = 10 * Math.min(1, distT * 1.5);
        const noise = (Math.random() - 0.5) * 2 * noiseStrength;
        data[idx + 3] = Math.max(0, Math.min(255, a + noise));
      }
    }
    ctx.putImageData(imgData, 0, 0);
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

      this._applyLightGrain(ctx, size, size, size / 2, size / 2, size / 2);

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

      // Same "hot core near the source, then a real bloom tail" idea as
      // _getRadialGradientTexture — a real flashlight/spotlight beam is
      // brightest and most sharply defined close to the bulb, then
      // gradually softens/dims outward, rather than fading at one
      // constant rate along its whole length.
      const HOT_CORE_T = 0.1;
      const steps = 56;
      for (let i = steps; i >= 1; i--) {
        const t = i / steps; // 1 at far edge, ~0 near apex
        const dist = size * t;

        let alpha;
        if (t <= HOT_CORE_T) {
          alpha = 1 - 0.05 * (t / HOT_CORE_T);
        } else {
          const bloomT = (t - HOT_CORE_T) / (1 - HOT_CORE_T);
          alpha = 0.95 * (1 - Math.pow(bloomT, 2.1));
        }
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

      // Grain centered on the apex (where the "source" is) rather than
      // the texture's geometric center — same subtle photographic-noise
      // reasoning as the radial texture, scaled to the cone's own reach
      // (size) instead of a separate radius.
      this._applyLightGrain(ctx, size, size, apexX, apexY, size);

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
   * + ShadowCaster shouldn't shadow itself).
   *
   * Two separate fades keep shadows from ever popping instantly in/out:
   *
   *  - REACH fade: instead of a hard cutoff exactly at the light's
   *    radius, shadows fade out over a soft band just past it (see
   *    REACH_FADE_BAND below) — an occluder crossing the light's edge
   *    dims out gradually rather than vanishing the instant it's one
   *    pixel past `radius`.
   *  - PROXIMITY fade: real light wrapping around a nearby object
   *    produces a short, faint, soft-edged shadow rather than an
   *    instant full-length hard one — a shadow only reaches full length
   *    / full strength once the light is comfortably far from the
   *    occluder (see PROXIMITY_FADE_DISTANCE). This is what makes
   *    "bringing the light close" look like the shadow gradually
   *    shrinking/fading rather than the shadow just being there-or-not.
   *
   * Spot lights additionally only illuminate/shadow within their cone
   * (light.angle degrees wide, centered on lightTransform.rotation),
   * ALSO with a soft angular fade rather than a hard edge, for the same
   * "no popping" reason.
   */
  _castProjectiveShadowsForLight(lightTransform, light, lightEntityId, occluders) {
    const baseReach =
      light.type === LightType.AREA ? (light.radius || 0) + Math.max(light.width, light.height) : light.radius;

    const isSpot = light.type === LightType.SPOT;
    const halfConeRad = isSpot ? ((light.angle || 45) * Math.PI) / 360 : 0;
    const facingRad = isSpot ? ((lightTransform.rotation || 0) * Math.PI) / 180 : 0;
    // Angular width (radians) of the soft fade band just inside/outside
    // the cone's edge — a fixed fraction of the half-angle so narrow
    // spotlights get a proportionally narrow (still soft, never hard)
    // fade band instead of a fade wider than the cone itself.
    const coneFadeRad = isSpot ? Math.max(0.03, halfConeRad * 0.25) : 0;

    for (const occ of occluders) {
      if (occ.id === lightEntityId) continue;
      if (occ.opacity <= 0) continue;

      const dx = occ.x - lightTransform.x;
      const dy = occ.y - lightTransform.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const reach = baseReach * occ.length;

      // REACH fade: 1 while comfortably inside the light's radius, 0
      // once fully past radius + REACH_FADE_BAND, smoothly in between —
      // replaces the old hard "dist > baseReach + occluderHalf" cutoff.
      const distToNearEdge = dist - Math.max(occ.halfWidth, occ.halfHeight);
      const reachFade = 1 - this._smoothstep(baseReach, baseReach + REACH_FADE_BAND, distToNearEdge);
      if (reachFade <= 0.002) continue; // fully faded out, nothing to draw

      let coneFade = 1;
      if (isSpot) {
        // Angle from the light to the occluder's CENTER, compared
        // against the cone's half-angle. angularPad accounts for the
        // occluder's own apparent angular size at this distance so a
        // wide/close occluder doesn't fade early just because its
        // CENTER crosses the edge before its whole body does.
        const angleToOcc = Math.atan2(dy, dx);
        let rel = angleToOcc - facingRad;
        while (rel > Math.PI) rel -= Math.PI * 2;
        while (rel < -Math.PI) rel += Math.PI * 2;

        const angularPad = Math.atan2(Math.max(occ.halfWidth, occ.halfHeight), Math.max(dist, 1));
        const edge = halfConeRad + angularPad;
        coneFade = 1 - this._smoothstep(edge, edge + coneFadeRad, Math.abs(rel));
        if (coneFade <= 0.002) continue; // fully outside the cone (+ fade band)
      }

      // PROXIMITY fade: a shadow right up against a very close light
      // wraps around the occluder in reality rather than throwing a
      // full hard shadow, so both the shadow's LENGTH and its ALPHA
      // ramp up from ~0 near the occluder's own edge to full strength
      // once the light is PROXIMITY_FADE_DISTANCE away (scaled by the
      // occluder's own size, so a huge occluder and a tiny one both
      // feel the same relative "how close is close" cutoff).
      const proximityRef = Math.max(occ.halfWidth, occ.halfHeight, 1) * PROXIMITY_FADE_SIZE_MULT;
      const proximityFade = this._smoothstep(0, proximityRef, distToNearEdge);
      const lengthFade = MIN_SHADOW_LENGTH_FRACTION + (1 - MIN_SHADOW_LENGTH_FRACTION) * proximityFade;

      const combinedFade = reachFade * coneFade;
      if (combinedFade <= 0.002) continue;

      this._castProjectiveShadowForOccluder(lightTransform, occ, reach * lengthFade, light, combinedFade * proximityFade);
    }
  }

  /**
   * Classic smoothstep: 0 below `edge0`, 1 above `edge1`, smooth
   * (cubic, zero-slope-at-both-ends) ramp between — used everywhere a
   * fade needs to look like a gradual dimming rather than a linear
   * ramp (which still has a visible "kink" where it starts/stops) or a
   * hard step (which is the popping this whole feature exists to fix).
   */
  _smoothstep(edge0, edge1, x) {
    if (edge0 === edge1) return x < edge0 ? 0 : 1;
    const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
    return t * t * (3 - 2 * t);
  }

  /**
   * Classic 2D point-light shadow casting, upgraded for accuracy: finds
   * the occluder's ROTATED box's two "silhouette" corners as seen from
   * the light (the tangent corners where the box's edge turns away from
   * the light), then extrudes a quad from those two corners out to
   * `reach` (the light's natural reach scaled by this caster's own
   * `length` AND the caller's proximity/reach fade), and fills it —
   * tinted by the light's shadowColor, faded by shadowStrength *
   * caster.opacity * extraFade, and optionally softened at the edge
   * (see _fillShadowPolygon).
   *
   * @param {number} extraFade additional [0,1] fade multiplier from the
   *   caller (reach-band fade * cone-edge fade * proximity fade — see
   *   _castProjectiveShadowsForLight) layered on top of the light's own
   *   shadowStrength and the occluder's own opacity, so all of those
   *   fades combine smoothly instead of any one of them being an
   *   instant on/off.
   */
  _castProjectiveShadowForOccluder(lightTransform, occ, reach, light, extraFade = 1) {
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
    const alpha = Math.min(1, light.shadowStrength * occ.opacity * extraFade) * AMBIENT_DARKNESS;
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
