/**
 * runtime/components/Light.js
 *
 * Plain light descriptor — 4 Unity-style light types, matching Unity's
 * own Light component naming/behavior split so it's immediately
 * familiar:
 *
 *  - Directional: no falloff, no position dependence — lightens (or
 *    tints) EVERYTHING in the scene uniformly, like sunlight. Only
 *    color/intensity matter; range/angle/width/height are ignored. When
 *    castShadows is on, casts long PARALLEL shadows in a fixed
 *    direction (derived from the entity's Transform.rotation), the same
 *    way real sunlight does.
 *  - Point: radial falloff from the entity's Transform position in every
 *    direction, out to `range`. The classic "light bulb" light. When
 *    castShadows is on, shadows radiate outward from the light's exact
 *    position — near objects cast bigger/longer shadows than far ones.
 *  - Spot: same as Point but constrained to a cone facing
 *    Transform.rotation, width controlled by `spotAngle` (degrees).
 *    Casts radial shadows the same way Point does, clipped to the cone.
 *  - Area: a soft rectangular glow centered on the entity, sized by
 *    `width`/`height` instead of a radius — good for "light coming
 *    through a window" or a glowing floor panel. Shadows radiate
 *    outward from the entity's center, same as Point.
 *
 * `castShadows` is this light's half of shadow casting — see
 * SpriteRenderer.castShadow for the other half (whether a given object
 * blocks light at all). BOTH need to be on for a specific light/object
 * pair to actually produce a shadow — matches Unity's split between a
 * Light's own shadow toggle and a Renderer's "Cast Shadows" checkbox.
 *
 * Rendering (actually dimming the world + brightening sprites near a
 * light, and cutting shadow shapes out of that brightening) is 100% the
 * renderer's job — see runtime/systems/LightingSystem.js — this file
 * only holds numbers.
 *
 * RUNTIME-ONLY FILE.
 */

export const LIGHT = "Light";

export const LightType = Object.freeze({
  DIRECTIONAL: "Directional",
  POINT: "Point",
  SPOT: "Spot",
  AREA: "Area",
});

export class Light {
  constructor({
    type = LightType.POINT,
    color = "#ffffff",
    intensity = 1, // 0-ish (off) to ~3 (blinding); 1 is a natural default brightness
    range = 300, // px — Point/Spot: distance the light reaches before fully fading out

    // Spot-only
    spotAngle = 45, // degrees, full cone width

    // Area-only
    width = 300, // px
    height = 200, // px

    // Global toggle for whether this light contributes to the scene's
    // ambient darkness/lighting pass at all — lets a light be authored
    // and then temporarily switched off without deleting it, matching
    // Unity's Light.enabled checkbox.
    enabled = true,

    // Whether THIS LIGHT casts shadows at all. Off = this light ignores
    // every shadow-caster and just lights straight through them (cheap,
    // useful for a soft fill light that shouldn't itself throw hard
    // shadows). See file header for how this combines with
    // SpriteRenderer.castShadow.
    castShadows = true,
  } = {}) {
    this.type = type;
    this.color = color;
    this.intensity = intensity;
    this.range = range;

    this.spotAngle = spotAngle;

    this.width = width;
    this.height = height;

    this.enabled = enabled;
    this.castShadows = castShadows;
  }
}
