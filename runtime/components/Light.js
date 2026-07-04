/**
 * runtime/components/Light.js
 *
 * Light descriptor, modeled after Unity's 4 light types (adapted to 2D):
 *
 *  - Directional : uniform light across the whole scene from one angle,
 *    like sunlight. No position falloff. `rotation` (degrees) sets the
 *    direction shadows/gradient would lean, `intensity` sets brightness.
 *  - Point       : radiates outward from the entity's Transform position
 *    in all directions, fading out at `radius`. The classic "lightbulb".
 *  - Spot        : radiates from the entity's Transform position within
 *    a cone (`angle` degrees wide, aimed along `rotation`), fading out
 *    at `radius`. Good for flashlights / focused beams.
 *  - Area        : uniform light emitted from a rectangular region
 *    (`width` x `height`) centered on the entity's Transform position,
 *    with a soft `radius`-sized falloff at the rectangle's edge.
 *
 * All types share color/intensity so the Inspector and LightingSystem
 * can treat them uniformly where the math allows, while type-specific
 * fields (radius/angle/width/height) only apply to the relevant type.
 *
 * This component is PLAIN DATA ONLY (see RULES.txt #4) — actually
 * darkening/lighting the world and sprites is LightingSystem's job
 * (runtime/systems/LightingSystem.js), not this file's.
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
    intensity = 1,
    radius = 200,
    angle = 45,
    width = 200,
    height = 200,
    castsOnWorld = true,
    castShadows = false,
  } = {}) {
    this.type = type;
    this.color = color;
    // 0 = off, 1 = normal brightness, >1 = overbright. Drives both how
    // strongly the light punches through the ambient darkness and how
    // much it additively brightens/tints sprites underneath it.
    this.intensity = intensity;

    // Point / Spot / Area only: how far the light reaches before fading
    // to nothing (world units / px).
    this.radius = radius;

    // Spot only: full cone width in degrees, centered on the entity's
    // Transform.rotation (0 = pointing along +X).
    this.angle = angle;

    // Area only: size in world units / px of the flat-lit rectangle
    // before the `radius`-sized soft falloff kicks in at its edges.
    this.width = width;
    this.height = height;

    // When true (default), this light contributes to the scene-wide
    // ambient darkness pass in LightingSystem, visibly lighting up
    // sprites and background underneath it. Turning it off keeps the
    // light purely as scene data (e.g. for a script to read) without
    // any visual effect — matches Unity's light "Enabled" behavior
    // without overloading entity.active, which would also stop the
    // entity from being queried at all.
    this.castsOnWorld = castsOnWorld;

    // When true, this light computes real-time shadow polygons from
    // every ShadowCaster entity in the scene (see components/
    // ShadowCaster.js and systems/LightingSystem.js) and darkens the
    // occluded regions behind them, dynamically — moving either the
    // light or an occluder updates shadows every frame, no baking.
    // Defaults to false: shadow casting is real rendering cost (one
    // shadow polygon per occluder per shadow-casting light per frame),
    // so it's opt-in per light rather than always-on, matching Unity's
    // own per-light "Shadow Type: None" default.
    this.castShadows = castShadows;
  }
}
