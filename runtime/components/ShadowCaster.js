/**
 * runtime/components/ShadowCaster.js
 *
 * Marks an entity as a shadow-casting occluder — something that blocks
 * light and projects a dynamic shadow, the 2D equivalent of Unity's
 * per-renderer "Cast Shadows" toggle.
 *
 * By default an occluder's blocking shape is read from its own live
 * rendered sprite bounds (same real, post-scale pixel size RenderSystem
 * already tracks for click-hit-testing — see
 * RenderSystem.getSpriteWorldHalfExtents), so a shadow automatically
 * matches what the sprite actually looks like with zero extra setup.
 * `width`/`height` here are an OPTIONAL override for entities that need
 * a shadow shape different from their sprite (a thin sprite that should
 * cast a wide shadow, or an invisible occluder with no SpriteRenderer at
 * all) — leave them null to use the sprite's real bounds.
 *
 * This component only marks INTENT ("this entity blocks light"); the
 * actual shadow-polygon math lives in
 * runtime/systems/LightingSystem.js, which is also the only place that
 * decides whether a given Light even casts shadows (Light.castShadows —
 * see components/Light.js). Kept as its own small component rather than
 * folded into SpriteRenderer so occluders don't require a visible sprite
 * (RULES.txt #3/#4: one feature = new file, components stay plain data).
 *
 * RUNTIME-ONLY FILE.
 */

export const SHADOW_CASTER = "ShadowCaster";

export class ShadowCaster {
  constructor({ enabled = true, width = null, height = null } = {}) {
    // Per-entity on/off, same spirit as Light.castsOnWorld — lets a
    // caster be temporarily excluded from shadow casting (e.g. a
    // see-through window sprite) without removing the component or
    // touching entity.active.
    this.enabled = enabled;

    // Optional explicit occluder size override, in world units/px
    // (same space as Transform.x/y). null means "use this entity's real
    // rendered sprite bounds" (see file header).
    this.width = width;
    this.height = height;
  }
}
