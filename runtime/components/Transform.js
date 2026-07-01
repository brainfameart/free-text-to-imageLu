/**
 * runtime/components/Transform.js
 *
 * Position / rotation / scale. Every entity that needs to exist in space
 * has one of these. Rotation is degrees (matches the editor's Inspector
 * field, converted to radians only at render time).
 *
 * RUNTIME-ONLY FILE.
 */

export const TRANSFORM = "Transform";

export class Transform {
  constructor({ x = 0, y = 0, z = 0, rotation = 0, scaleX = 1, scaleY = 1 } = {}) {
    this.x = x;
    this.y = y;
    this.z = z;
    this.rotation = rotation; // degrees, around Z
    this.scaleX = scaleX;
    this.scaleY = scaleY;
  }
}
