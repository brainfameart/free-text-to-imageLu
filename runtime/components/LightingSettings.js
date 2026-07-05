/**
 * runtime/components/LightingSettings.js
 *
 * Scene-wide lighting/shadow REALISM settings, exposed to end users of
 * the engine (not just the person building the engine) through the
 * Inspector — same idea as Camera's enablePseudo3D: a single toggle
 * that isn't "per light" or "per object," it's a property of the whole
 * scene, so it lives as plain data on a component (see RULES.txt #4)
 * that LightingSystem reads every frame (see LightingSystem.js's
 * _readSettings()).
 *
 * Attach this to any one entity in the scene (the Main Camera is a
 * natural home, same as other scene-wide settings) — if a scene has
 * none, LightingSystem falls back to sensible defaults matching the
 * previous hardcoded behavior, so existing scenes keep working
 * unchanged.
 *
 * FIELD GUIDE (what each one actually changes visually):
 *  - shadowMode:      "Quad" = cheap analytic shadows, closely matches
 *                      the classic look, cheapest on low-end machines.
 *                      "Raymarch" = true per-pixel shadow occlusion,
 *                      correct penumbra/soft edges, costs more GPU
 *                      time per light * occluder * pixel.
 *  - raymarchSteps:    Only matters in Raymarch mode. Higher = smoother
 *                      / more accurate shadow edges and fewer thin-
 *                      occluder "shadow leaks," at a higher GPU cost.
 *                      Lower = cheaper but can look slightly rougher.
 *  - ambientDarkness:  How dark the world gets in areas NO light
 *                      reaches, from 0 (no darkening at all, full
 *                      daylight everywhere) to 1 (pitch black outside
 *                      any light's reach). This is the single biggest
 *                      "how moody/realistic does my lighting look"
 *                      dial — most atmospheric/horror-style scenes
 *                      want this high (0.7-0.9); brighter, cartoonish
 *                      scenes want it low (0.2-0.4).
 *
 * RUNTIME-ONLY FILE. Pure data, no PIXI.
 */

import { ShadowMode } from "../systems/LightingQuality.js";

export const LIGHTING_SETTINGS = "LightingSettings";

export class LightingSettings {
  constructor({ shadowMode = ShadowMode.QUAD, raymarchSteps = 24, ambientDarkness = 0.65 } = {}) {
    /** @type {string} one of ShadowMode ("quad" | "raymarch") */
    this.shadowMode = shadowMode;

    /** @type {number} 1-48, only used when shadowMode === "raymarch" */
    this.raymarchSteps = raymarchSteps;

    /** @type {number} 0-1, how dark unlit areas get */
    this.ambientDarkness = ambientDarkness;
  }
}
