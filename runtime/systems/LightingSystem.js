/**
 * runtime/systems/LightingSystem.js
 *
 * Makes Light components (see components/Light.js) actually visible:
 * darkens the whole camera-visible scene, then punches brightness back
 * in wherever a light reaches, using the standard cheap 2D lighting
 * trick — a MULTIPLY-blended darkness rect covering the camera's world
 * rect, with each light's glow drawn on top using ADD blending so it
 * visibly re-lightens both the background AND any sprite sitting under
 * it (this affects "sprites and the world" together, since both the
 * darkness and the glow sit in the SAME container as the sprites and
 * are composited by PIXI in draw order, not as a separate screen-space
 * post effect).
 *
 * Behavior per type (mirrors Unity):
 *  - Directional: no glow shape at all — instead brightens the darkness
 *    rect itself (uniformly, everywhere), like sunlight/ambient light.
 *    Multiple Directional lights combine (their contributions add).
 *  - Point: a radial glow centered on the entity, fading out at `range`.
 *  - Spot: a radial glow masked to a cone facing Transform.rotation,
 *    `spotAngle` degrees wide, fading out at `range`.
 *  - Area: a soft-edged rectangular glow, `width` x `height`, centered
 *    on the entity (no rotation dependence, matching Unity's 2D Area
 *    light).
 *
 * SHADOWS (Light.castShadows + SpriteRenderer.castShadow — see both
 * files' doc comments): for every enabled light with castShadows on,
 * every shadow-casting sprite within reach projects a real-time
 * silhouette AWAY from the light:
 *  - Point/Spot/Area lights: each light owns a small container (glow +
 *    a "shadow blocker" shape drawn after it, both clipped to the same
 *    circle/wedge mask the light already used). The shadow blocker is a
 *    MULTIPLY-blended dark polygon per occluder, radiating outward from
 *    the light's exact position — near objects throw bigger/longer
 *    shadows than far ones, like a real light bulb. Because it's drawn
 *    AFTER the glow inside the same masked group, it re-darkens exactly
 *    the shadowed silhouette back down without needing the shadow shape
 *    itself to be a "hole" cut into anything (avoids PIXI's requirement
 *    that Graphics holes be strictly contained inside their parent
 *    shape, which a shadow polygon reaching out to a light's edge can
 *    easily violate).
 *  - Directional lights: the silhouette is projected in a fixed
 *    direction (from Transform.rotation, since a directional light has
 *    no single position) — drawn as extra MULTIPLY-blended dark quads
 *    on top of the (already-brightened) darkness rect, the same
 *    technique, just without a per-light mask to stay inside of.
 * Every occluder's silhouette is its real rendered bounding box (via
 * RenderSystem.getSpriteWorldHalfExtents — same box used for
 * click-to-select), rotated by the entity's own Transform.rotation, so
 * shadows track an object's actual on-screen size/orientation live.
 *
 * If a scene has ZERO Light entities, this system draws nothing at all
 * — an empty/legacy scene stays exactly as bright as it always was
 * instead of suddenly going dark the moment this feature shipped.
 * Placing the first Light entity is what opts a scene into lighting.
 *
 * RUNTIME-ONLY FILE (depends on PIXI, same exception RenderSystem.js
 * already carries — this is the only other system allowed to touch it,
 * since actually rendering the effect can't be done as inert data).
 */

import { System } from "../core/System.js";
import { TRANSFORM } from "../components/Transform.js";
import { LIGHT, LightType } from "../components/Light.js";
import { SPRITE_RENDERER } from "../components/SpriteRenderer.js";
import { CAMERA } from "../components/Camera.js";
import { getCameraWorldRect } from "../core/CameraUtils.js";

const AMBIENT_WHEN_UNLIT = 0x000000; // darkness color when no Directional light contributes any ambient
const MAX_AMBIENT = 0.9; // Directional lights can brighten the darkness rect up to 90% before it's simply skipped (see update())
const DIRECTIONAL_SHADOW_LENGTH = 2000; // px — how far a directional light's parallel shadows stretch; effectively "as far as the camera can see"
const SHADOW_PROJECT_LENGTH = 4000; // px — how far a Point/Spot/Area shadow polygon's far edge reaches; the shared circle/wedge mask on the parent group clips it back down to that light's actual range, so this just needs to be "far enough" to always reach past any light's range

export class LightingSystem extends System {
  /**
   * @param {PIXI.Container} worldContainer SAME container RenderSystem
   *   draws sprites into — the lighting layer is added as a child of it
   *   so it shares the exact same coordinate space (world units).
   * @param {import('./RenderSystem.js').RenderSystem} [renderSystem]
   *   used to read each shadow-caster's REAL rendered bounding box (see
   *   RenderSystem.getSpriteWorldHalfExtents) so shadow silhouettes
   *   match actual on-screen sprite size. Optional — if omitted (or a
   *   given sprite isn't tracked yet), a conservative fallback box is
   *   used instead so shadows still degrade gracefully rather than
   *   throwing.
   */
  constructor(worldContainer, renderSystem) {
    super();
    this.worldContainer = worldContainer;
    this.renderSystem = renderSystem || null;
    this.layer = new PIXI.Container();
    // worldContainer sorts children by zIndex (see RenderSystem.js,
    // which sets sortableChildren = true so each sprite's Transform.z
    // controls draw order). Sprites use z + a tiny tie-break as their
    // zIndex; Infinity guarantees this lighting layer always draws
    // above every sprite regardless of how high a user sets a
    // sprite's z, without needing to know the scene's actual z range
    // or fight over sibling insertion order.
    this.layer.zIndex = Infinity;
    this.worldContainer.addChild(this.layer);

    this.darkness = new PIXI.Graphics();
    this.darkness.blendMode = PIXI.BLEND_MODES.MULTIPLY;
    this.layer.addChild(this.darkness);

    // Directional-light shadows: extra dark quads drawn on top of the
    // (already ambient-brightened) darkness rect — see file header.
    // One shared Graphics reused across all directional lights/frames.
    this.directionalShadows = new PIXI.Graphics();
    this.directionalShadows.blendMode = PIXI.BLEND_MODES.MULTIPLY;
    this.layer.addChild(this.directionalShadows);

    /** @type {Map<string, {group:PIXI.Container, glow:PIXI.Sprite, shadowBlocker:PIXI.Graphics, mask:PIXI.Graphics}>} entityId -> this light's render pieces (Point/Spot/Area only) */
    this._lights = new Map();

    this._glowTexture = this._buildRadialGlowTexture();
  }

  update(world) {
    const lightEntities = world.query(TRANSFORM, LIGHT).filter((e) => e.getComponent(LIGHT).enabled);

    // Empty scene / no lights placed yet => draw nothing, don't touch
    // brightness at all (see file header).
    if (lightEntities.length === 0) {
      this.darkness.clear();
      this.directionalShadows.clear();
      this._clearAllLights();
      this.layer.visible = false;
      return;
    }
    this.layer.visible = true;

    const cameraEntity = world.query(TRANSFORM, CAMERA).find((e) => e.getComponent(CAMERA).isMain);
    const camera = cameraEntity ? cameraEntity.getComponent(CAMERA) : null;
    const cameraTransform = cameraEntity ? cameraEntity.getComponent(TRANSFORM) : null;
    // Fall back to a generous fixed rect if there's no camera yet (mid
    // scene setup) so lights are still visible while authoring.
    const rect = camera ? getCameraWorldRect(camera, cameraTransform) : { left: -2000, top: -2000, width: 4000, height: 4000 };

    // Shadow-casting sprites, computed once per frame and reused by
    // every light below (each light just decides whether it looks at
    // this list at all, via its own castShadows flag).
    const occluders = this._collectOccluders(world);

    // Ambient contribution: every enabled Directional light brightens
    // the WHOLE darkness rect uniformly (no position/shape), combined
    // additively and capped so the scene can still read as "lit by
    // point lights in the dark" even with one weak directional light.
    let ambient = 0;
    let ambientColor = { r: 0, g: 0, b: 0 };
    const directionalLights = [];
    for (const entity of lightEntities) {
      const light = entity.getComponent(LIGHT);
      if (light.type !== LightType.DIRECTIONAL) continue;
      directionalLights.push(entity);
      const contribution = Math.min(MAX_AMBIENT, Math.max(0, light.intensity)) * (1 / lightEntities.length + 0.5);
      ambient = Math.min(MAX_AMBIENT, ambient + contribution);
      const rgb = hexToRgb(light.color);
      ambientColor.r += rgb.r * contribution;
      ambientColor.g += rgb.g * contribution;
      ambientColor.b += rgb.b * contribution;
    }
    ambient = Math.min(MAX_AMBIENT, ambient);

    this.darkness.clear();
    if (ambient < MAX_AMBIENT) {
      // Draw darkness everywhere the ambient light doesn't already
      // fully cover — tinted toward the combined Directional color so a
      // warm/cool sun tints shadows instead of always going pure black.
      const shadowTint = ambient > 0 ? rgbToHex(clamp01(ambientColor.r), clamp01(ambientColor.g), clamp01(ambientColor.b)) : AMBIENT_WHEN_UNLIT;
      const shadowAlpha = 1 - ambient;
      this.darkness
        .beginFill(shadowTint, shadowAlpha)
        .drawRect(rect.left, rect.top, rect.width, rect.height)
        .endFill();
    }

    // Directional shadows: parallel dark quads projected from each
    // occluder in a fixed direction, drawn back on top of the darkness
    // rect (MULTIPLY again, so shadow-on-shadow doesn't over-darken past
    // the normal darkness level — it just re-applies the same dimming
    // the rest of the unlit scene already has).
    this.directionalShadows.clear();
    if (ambient > 0) {
      for (const dirEntity of directionalLights) {
        const light = dirEntity.getComponent(LIGHT);
        if (!light.castShadows) continue;
        const dirTransform = dirEntity.getComponent(TRANSFORM);
        this._drawDirectionalShadows(dirTransform, occluders, ambient);
      }
    }

    // Point/Spot/Area lights: each gets a small group (mask + glow +
    // shadow blocker), drawn on top of the darkness rect (later in the
    // same container, same draw order as sprites) so they visibly punch
    // light back through both the darkness AND any sprite sitting
    // underneath them, then re-darken exactly the shadow silhouettes.
    const seen = new Set();
    for (const entity of lightEntities) {
      const light = entity.getComponent(LIGHT);
      if (light.type === LightType.DIRECTIONAL) continue; // ambient-only, no shape

      seen.add(entity.id);
      const transform = entity.getComponent(TRANSFORM);
      const pieces = this._getOrCreateLightPieces(entity.id);

      pieces.glow.tint = PIXI.utils ? PIXI.utils.string2hex(light.color) : 0xffffff;
      pieces.glow.alpha = Math.max(0, Math.min(1, light.intensity / 2)); // intensity 2 = fully opaque glow texture; matches Point/Spot/Area feeling roughly as bright as a 2x Directional at the same intensity number
      pieces.glow.x = transform.x;
      pieces.glow.y = transform.y;

      const texSize = this._glowTexture.width;
      const range = Math.max(0.01, light.range || Math.max(light.width || 0, light.height || 0));
      let cone = null;

      if (light.type === LightType.AREA) {
        // Rectangular footprint: scale the (circular) glow texture
        // independently on X/Y so it reads as a soft rectangle rather
        // than a circle — good enough for a 2D "glow panel" without
        // needing a second texture.
        pieces.glow.rotation = 0;
        pieces.glow.scale.set(Math.max(0.01, light.width) / texSize, Math.max(0.01, light.height) / texSize);
      } else if (light.type === LightType.SPOT) {
        // Cone: reuse the radial glow but squash it into a wedge via a
        // mask so it only shows within spotAngle degrees of
        // Transform.rotation, still fading out at `range`.
        const scale = (range * 2) / texSize;
        pieces.glow.scale.set(scale);
        pieces.glow.rotation = 0;
        const halfAngle = (Math.max(1, Math.min(359, light.spotAngle)) * Math.PI) / 360;
        const facing = (transform.rotation * Math.PI) / 180;
        cone = { facing, halfAngle };
      } else {
        // Point
        const scale = (range * 2) / texSize;
        pieces.glow.scale.set(scale);
        pieces.glow.rotation = 0;
      }

      // Mask shape: the light's own circle/wedge — clips BOTH the glow
      // and the shadow blocker to the same footprint, so a shadow
      // polygon can safely extend far past the light's edge (it just
      // gets visually clipped here, no hole-containment math needed).
      pieces.mask.clear();
      pieces.mask.beginFill(0xffffff);
      if (cone) {
        pieces.mask
          .moveTo(transform.x, transform.y)
          .arc(transform.x, transform.y, range, cone.facing - cone.halfAngle, cone.facing + cone.halfAngle)
          .lineTo(transform.x, transform.y);
      } else {
        pieces.mask.drawCircle(transform.x, transform.y, range);
      }
      pieces.mask.endFill();

      // Shadow blocker: one dark polygon per in-range occluder,
      // radiating outward from this light's position, drawn AFTER the
      // glow (same group, same mask) so it re-darkens exactly the
      // shadowed silhouette.
      pieces.shadowBlocker.clear();
      if (light.castShadows) {
        pieces.shadowBlocker.beginFill(0x000000, 1);
        for (const occluder of occluders) {
          const dx = occluder.x - transform.x;
          const dy = occluder.y - transform.y;
          const dist = Math.sqrt(dx * dx + dy * dy);
          if (dist > range + Math.max(occluder.halfWidth, occluder.halfHeight)) continue; // well outside this light's reach, skip

          const silhouette = this._projectRadialSilhouette(transform.x, transform.y, occluder);
          if (!silhouette) continue;

          pieces.shadowBlocker.moveTo(silhouette[0].x, silhouette[0].y);
          for (let i = 1; i < silhouette.length; i++) pieces.shadowBlocker.lineTo(silhouette[i].x, silhouette[i].y);
          pieces.shadowBlocker.closePath();
        }
        pieces.shadowBlocker.endFill();
      }
    }

    // remove light pieces for lights that were deleted or changed away
    // from Point/Spot/Area
    for (const [entityId, pieces] of this._lights) {
      if (!seen.has(entityId)) {
        this._removeLightPieces(entityId, pieces);
      }
    }
  }

  /**
   * Builds (once) a 256x256 white radial-gradient PIXI.Texture — soft,
   * fully opaque center fading smoothly to fully transparent edge —
   * used as every Point/Spot/Area light's glow sprite base, then tinted
   * per-light via sprite.tint and scaled per-light's range/width/height.
   */
  _buildRadialGlowTexture() {
    const size = 256;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d");
    const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    gradient.addColorStop(0, "rgba(255,255,255,1)");
    gradient.addColorStop(0.6, "rgba(255,255,255,0.6)");
    gradient.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, size, size);
    return PIXI.Texture.from(canvas);
  }

  /**
   * Gathers every shadow-casting sprite in the world once per frame:
   * its center, half-extents (real rendered size when RenderSystem is
   * available, else a conservative Transform-scale-derived fallback),
   * and rotation — everything _projectRadialSilhouette needs, regardless
   * of which light/direction is casting against it.
   */
  _collectOccluders(world) {
    const entities = world.query(TRANSFORM, SPRITE_RENDERER);
    const occluders = [];
    for (const entity of entities) {
      const spriteRenderer = entity.getComponent(SPRITE_RENDERER);
      if (!spriteRenderer.castShadow) continue;
      const transform = entity.getComponent(TRANSFORM);
      const real = this.renderSystem ? this.renderSystem.getSpriteWorldHalfExtents(entity.id) : null;
      const halfWidth = real ? real.halfWidth : 40 * Math.max(Math.abs(transform.scaleX), Math.abs(transform.scaleY), 0.2);
      const halfHeight = real ? real.halfHeight : halfWidth;
      occluders.push({
        x: transform.x,
        y: transform.y,
        halfWidth,
        halfHeight,
        rotation: (transform.rotation * Math.PI) / 180,
      });
    }
    return occluders;
  }

  /**
   * Creates (once) or reuses a Point/Spot/Area light's render pieces:
   * a masked group containing the ADD-blended glow sprite, drawn first,
   * and a MULTIPLY-blended shadow-blocker Graphics drawn after it (so it
   * re-darkens shadowed silhouettes on top of the glow), both clipped to
   * the SAME mask shape (that light's circle/wedge) so shadow polygons
   * never need to individually stay inside any boundary — the group's
   * mask does that clipping for free.
   */
  _getOrCreateLightPieces(entityId) {
    let pieces = this._lights.get(entityId);
    if (pieces) return pieces;

    const group = new PIXI.Container();
    const mask = new PIXI.Graphics();
    const glow = new PIXI.Sprite(this._glowTexture);
    glow.anchor.set(0.5);
    glow.blendMode = PIXI.BLEND_MODES.ADD;
    const shadowBlocker = new PIXI.Graphics();
    shadowBlocker.blendMode = PIXI.BLEND_MODES.MULTIPLY;

    group.addChild(mask);
    group.addChild(glow);
    group.addChild(shadowBlocker);
    group.mask = mask;
    this.layer.addChild(group);

    pieces = { group, glow, shadowBlocker, mask };
    this._lights.set(entityId, pieces);
    return pieces;
  }

  /**
   * Projects an occluder's rotated bounding box into a shadow polygon
   * radiating AWAY from a single point light source (lightX, lightY):
   * takes the box's 4 corners, keeps the 2 that are the silhouette
   * edges as seen from the light (the ones "sticking out" toward the
   * light), and extends them outward by SHADOW_PROJECT_LENGTH — the
   * classic 2D point-light shadow-volume technique (near silhouette
   * edge + far projected edge = a quad). The far edge is intentionally
   * allowed to reach past the light's own range/mask — the caller's
   * group mask clips it back down, so this never needs to reason about
   * containment itself.
   *
   * @returns {{x:number,y:number}[]|null} polygon points, or null if
   *   the light is inside the occluder (degenerate — no shadow to cast)
   */
  _projectRadialSilhouette(lightX, lightY, occluder) {
    const cos = Math.cos(occluder.rotation);
    const sin = Math.sin(occluder.rotation);
    const corners = [
      { x: -occluder.halfWidth, y: -occluder.halfHeight },
      { x: occluder.halfWidth, y: -occluder.halfHeight },
      { x: occluder.halfWidth, y: occluder.halfHeight },
      { x: -occluder.halfWidth, y: occluder.halfHeight },
    ].map((c) => ({
      x: occluder.x + c.x * cos - c.y * sin,
      y: occluder.y + c.x * sin + c.y * cos,
    }));

    // Light is (essentially) inside the box — no meaningful shadow.
    if (Math.abs(occluder.x - lightX) < occluder.halfWidth * 0.5 && Math.abs(occluder.y - lightY) < occluder.halfHeight * 0.5) {
      return null;
    }

    // Find the 2 silhouette corners: the ones whose projection is most
    // "sideways" relative to the light direction — a robust proxy is
    // picking the corners with min/max angle-from-light, which for a
    // convex quad reliably picks the 2 outermost edge corners without
    // needing per-edge normal tests.
    let minAngle = Infinity;
    let maxAngle = -Infinity;
    let minCorner = corners[0];
    let maxCorner = corners[0];
    for (const c of corners) {
      const angle = Math.atan2(c.y - lightY, c.x - lightX);
      if (angle < minAngle) {
        minAngle = angle;
        minCorner = c;
      }
      if (angle > maxAngle) {
        maxAngle = angle;
        maxCorner = c;
      }
    }
    if (minCorner === maxCorner) return null;

    const project = (corner) => {
      const dx = corner.x - lightX;
      const dy = corner.y - lightY;
      const dist = Math.sqrt(dx * dx + dy * dy) || 1;
      const t = (dist + SHADOW_PROJECT_LENGTH) / dist;
      return { x: lightX + dx * t, y: lightY + dy * t };
    };

    return [minCorner, maxCorner, project(maxCorner), project(minCorner)];
  }

  /**
   * Directional-light shadow quads: since a directional light has no
   * single position, shadows are parallel (all occluders cast in the
   * SAME fixed direction, derived from the light entity's own
   * Transform.rotation, matching how a real sun's shadows all point
   * the same way regardless of where an object stands).
   */
  _drawDirectionalShadows(dirTransform, occluders, ambient) {
    const dirAngle = (dirTransform.rotation * Math.PI) / 180;
    const dx = Math.cos(dirAngle);
    const dy = Math.sin(dirAngle);
    const alpha = 1 - ambient; // re-apply the same darkness strength the rest of the unlit scene has

    this.directionalShadows.beginFill(0x000000, alpha);
    for (const occluder of occluders) {
      const cos = Math.cos(occluder.rotation);
      const sin = Math.sin(occluder.rotation);
      const corners = [
        { x: -occluder.halfWidth, y: -occluder.halfHeight },
        { x: occluder.halfWidth, y: -occluder.halfHeight },
        { x: occluder.halfWidth, y: occluder.halfHeight },
        { x: -occluder.halfWidth, y: occluder.halfHeight },
      ].map((c) => ({
        x: occluder.x + c.x * cos - c.y * sin,
        y: occluder.y + c.x * sin + c.y * cos,
      }));

      // For a parallel light, every corner projects in the same
      // direction — the shadow polygon is simply the occluder's own
      // footprint extruded along (dx, dy), i.e. the convex hull of the
      // original 4 corners plus the same 4 corners shifted by the
      // projection vector. Drawing original+shifted as an 8-point fan
      // (in a fixed winding order) reliably covers that hull for an
      // axis-aligned-ish box without needing a full hull algorithm.
      const shifted = corners.map((c) => ({ x: c.x + dx * DIRECTIONAL_SHADOW_LENGTH, y: c.y + dy * DIRECTIONAL_SHADOW_LENGTH }));
      const poly = [corners[0], corners[1], corners[2], corners[3], shifted[3], shifted[2], shifted[1], shifted[0]];
      this.directionalShadows.moveTo(poly[0].x, poly[0].y);
      for (let i = 1; i < poly.length; i++) this.directionalShadows.lineTo(poly[i].x, poly[i].y);
      this.directionalShadows.closePath();
    }
    this.directionalShadows.endFill();
  }

  _removeLightPieces(entityId, pieces) {
    pieces.group.mask = null;
    this.layer.removeChild(pieces.group);
    pieces.group.destroy({ children: true });
    this._lights.delete(entityId);
  }

  _clearAllLights() {
    for (const [entityId, pieces] of this._lights) {
      this._removeLightPieces(entityId, pieces);
    }
  }

  destroy() {
    this._clearAllLights();
    this.worldContainer.removeChild(this.layer);
    this.layer.destroy({ children: true });
    if (this._glowTexture) this._glowTexture.destroy(true);
  }
}

function hexToRgb(hex) {
  const clean = hex.replace("#", "");
  const num = parseInt(clean, 16);
  return { r: ((num >> 16) & 255) / 255, g: ((num >> 8) & 255) / 255, b: (num & 255) / 255 };
}

function clamp01(v) {
  return Math.max(0, Math.min(1, v));
}

function rgbToHex(r, g, b) {
  const toByte = (v) => Math.round(v * 255);
  return (toByte(r) << 16) | (toByte(g) << 8) | toByte(b);
}
