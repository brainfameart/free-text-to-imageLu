/**
 * runtime/components/Light.js
 *
 * Minimal light descriptor. Currently only "point" lights are modeled,
 * matching what the editor's Hierarchy mockup referenced. Rendering of
 * lights is the renderer's job, not the component's.
 *
 * RUNTIME-ONLY FILE.
 */

export const LIGHT = "Light";

export const LightType = Object.freeze({
  POINT: "point",
});

export class Light {
  constructor({ type = LightType.POINT, color = "#ffffff", intensity = 1, radius = 200 } = {}) {
    this.type = type;
    this.color = color;
    this.intensity = intensity;
    this.radius = radius;
  }
}
