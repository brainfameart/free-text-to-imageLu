/**
 * runtime/scripting/components/ColliderAPI.js
 *
 * The `this.collider` sub-object exposed to user scripts. Collider settings
 * remain plain component data; this file only provides a safe live view of
 * the settings that are useful to gameplay scripts.
 *
 * RUNTIME-ONLY FILE.
 */

import { COLLIDER_2D } from "../../components/Collider2D.js";

function _tag(err, kind) {
  err.kind = kind;
  return err;
}

function _requireCollider(entity) {
  const collider = entity.getComponent(COLLIDER_2D);
  if (!collider) {
    throw _tag(new Error(
      "'" + (entity.name || "Entity") + "' called this.collider but has no Collider 2D. " +
      "Add one in the Inspector (Add Component → Collider 2D)."
    ), "missing-component");
  }
  return collider;
}

const COLLIDER_MEMBERS = new Set([
  "shape", "width", "height", "radius", "capsuleHalfHeight",
  "capsuleRadius", "offset", "isTrigger", "friction", "restitution",
  "density", "layer", "mask",
]);

export function createColliderAPI(entity) {
  const target = {
    get shape() { return _requireCollider(entity).shape; },
    get width() { return _requireCollider(entity).width; },
    get height() { return _requireCollider(entity).height; },
    get radius() { return _requireCollider(entity).radius; },
    get capsuleHalfHeight() { return _requireCollider(entity).capsuleHalfHeight; },
    get capsuleRadius() { return _requireCollider(entity).capsuleRadius; },
    get offset() {
      const c = _requireCollider(entity);
      return { x: c.offsetX, y: c.offsetY };
    },
    get isTrigger() { return !!_requireCollider(entity).isTrigger; },
    get friction() { return _requireCollider(entity).friction; },
    get restitution() { return _requireCollider(entity).restitution; },
    get density() { return _requireCollider(entity).density; },
    get layer() { return _requireCollider(entity).layer; },
    get mask() { return _requireCollider(entity).mask; },
  };

  return new Proxy(target, {
    get(t, prop) {
      if (typeof prop === "symbol" || prop === "then") return t[prop];
      const key = String(prop);
      if (!(key in t) && !COLLIDER_MEMBERS.has(key)) {
        throw _tag(new Error(
          "this.collider." + key + " does not exist. Check the spelling — " +
          "valid members are: " + Array.from(COLLIDER_MEMBERS).join(", ") + "."
        ), "unknown-api");
      }
      return t[key];
    },
    set(_t, prop) {
      const key = String(prop);
      throw _tag(new Error(
        "this.collider." + key + " is read-only — change Collider 2D settings in the Inspector."
      ), "unsupported-body-type");
    },
  });
}
