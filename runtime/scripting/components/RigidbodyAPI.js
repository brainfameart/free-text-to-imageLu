/**
 * runtime/scripting/components/RigidbodyAPI.js
 *
 * The `this.rigidbody` sub-object exposed to user scripts (see
 * scripting/ScriptAPI.js). One file per scripting component — see
 * TransformAPI.js's header comment for the general rationale.
 *
 * IMPORTANT — body-type-aware API surface:
 * Unlike the old single-shape rigidbody object, this file builds a
 * DIFFERENT api shape depending on the entity's actual
 * Rigidbody2D.bodyType, matching Unity's own convention of hiding/
 * rejecting operations that don't make physical sense for a given body
 * type:
 *   - Dynamic:   full force/impulse/torque API (addForce, addImpulse,
 *                addTorque, addAngularImpulse) plus velocity + mass +
 *                gravityScale — Rapier's solver owns the body.
 *   - Kinematic: velocity (used to DRIVE the body via the character
 *                controller sweep) + move(dx, dy) for a one-shot swept
 *                nudge, + grounded/resolvedVelocity (read-only, real
 *                sweep results) — but NO addForce/addImpulse, since a
 *                kinematic body has infinite mass and Rapier never
 *                integrates forces into it (calling addForce on one is
 *                a silent no-op in raw Rapier, which is exactly the
 *                confusing footgun this file exists to prevent).
 *   - Static:    read-only stub — a static body never moves by
 *                definition, so every mutator throws a clear, actionable
 *                error instead of silently doing nothing.
 *
 * Calling a method the current body type doesn't support THROWS a
 * descriptive Error (rather than silently no-op-ing) so ScriptSystem's
 * existing per-lifecycle try/catch (see systems/ScriptSystem.js)
 * reports it to the editor console exactly like any other script bug —
 * "why isn't my kinematic enemy moving with addForce" becomes an
 * immediate, readable error instead of a silent mystery.
 *
 * RUNTIME-ONLY FILE.
 */

import { RIGIDBODY_2D, BodyType } from "../../components/Rigidbody2D.js";

function _rb(entity) {
  return entity.getComponent(RIGIDBODY_2D);
}

/** Shared read-only fields every body type exposes (velocity is
 * readable everywhere, even Static, where it's always zero). */
function _baseReadOnly(entity) {
  return {
    get velocity() {
      var r = _rb(entity);
      return r ? { x: r.velocityX, y: r.velocityY } : { x: 0, y: 0 };
    },
    get type() {
      var r = _rb(entity);
      return r ? r.bodyType : null;
    },
  };
}

function _throwUnsupported(bodyType, member) {
  throw new Error(
    "rigidbody." + member + "() is not available on a " + bodyType +
    " body. " +
    (bodyType === BodyType.STATIC
      ? "Static bodies never move — change the Body Type to Dynamic or Kinematic in the Inspector if this object needs to move."
      : bodyType === BodyType.KINEMATIC
      ? "Kinematic bodies are moved directly (use rigidbody.velocity or rigidbody.move(dx, dy)), not by forces — Rapier never applies forces/impulses to a kinematic body. Use Dynamic if you want physics-driven forces."
      : "This body type does not support that operation.")
  );
}

/** DYNAMIC: full force/impulse/torque API. Rapier's solver owns everything. */
function _createDynamicAPI(entity) {
  var base = _baseReadOnly(entity);
  return Object.assign(base, {
    set velocity(v) {
      var r = _rb(entity);
      if (r) { r.velocityX = v.x; r.velocityY = v.y; }
    },
    get velocityX() { var r = _rb(entity); return r ? r.velocityX : 0; },
    set velocityX(v) { var r = _rb(entity); if (r) r.velocityX = v; },
    get velocityY() { var r = _rb(entity); return r ? r.velocityY : 0; },
    set velocityY(v) { var r = _rb(entity); if (r) r.velocityY = v; },

    get mass() { var r = _rb(entity); return r ? r.mass : 1; },
    set mass(v) { var r = _rb(entity); if (r) r.mass = v; },
    get gravityScale() { var r = _rb(entity); return r ? r.gravityScale : 1; },
    set gravityScale(v) { var r = _rb(entity); if (r) r.gravityScale = v; },
    get linearDamping() { var r = _rb(entity); return r ? r.linearDamping : 0; },
    set linearDamping(v) { var r = _rb(entity); if (r) r.linearDamping = v; },
    get angularDamping() { var r = _rb(entity); return r ? r.angularDamping : 0; },
    set angularDamping(v) { var r = _rb(entity); if (r) r.angularDamping = v; },

    /** Continuous force (Newtons-equivalent) — call every frame to sustain a push, like Unity's Rigidbody2D.AddForce. */
    addForce: function (x, y) {
      var r = _rb(entity);
      if (!r) return;
      r.pendingForceX += x;
      r.pendingForceY += y;
    },
    /** Instantaneous velocity change (impulse = mass * delta-v), applied once. */
    addImpulse: function (x, y) {
      var r = _rb(entity);
      if (!r) return;
      r.pendingImpulseX += x;
      r.pendingImpulseY += y;
    },
    /** Continuous rotational force — call every frame to sustain a spin. */
    addTorque: function (t) {
      var r = _rb(entity);
      if (!r) return;
      r.pendingTorque += t;
    },
    /** Instantaneous angular velocity change, applied once. */
    addAngularImpulse: function (t) {
      var r = _rb(entity);
      if (!r) return;
      r.pendingAngularImpulse += t;
    },

    // Explicitly unsupported on Dynamic — kinematic-only concepts.
    move: function () { _throwUnsupported(BodyType.DYNAMIC, "move"); },
    get grounded() { return false; },
  });
}

/** KINEMATIC: velocity drives the character-controller sweep; move()
 * is a one-shot swept nudge; grounded/resolvedVelocity are read-only
 * results of that sweep. No force/impulse/torque — Rapier never
 * integrates forces into a kinematic body. */
function _createKinematicAPI(entity) {
  var base = _baseReadOnly(entity);
  return Object.assign(base, {
    set velocity(v) {
      var r = _rb(entity);
      if (r) { r.velocityX = v.x; r.velocityY = v.y; }
    },
    get velocityX() { var r = _rb(entity); return r ? r.velocityX : 0; },
    set velocityX(v) { var r = _rb(entity); if (r) r.velocityX = v; },
    get velocityY() { var r = _rb(entity); return r ? r.velocityY : 0; },
    set velocityY(v) { var r = _rb(entity); if (r) r.velocityY = v; },

    /** One-shot swept move for this frame (in addition to any standing velocity), blocked/slid by obstacles just like velocity movement. */
    move: function (dx, dy) {
      var r = _rb(entity);
      if (!r) return;
      r.pendingMoveX = (r.pendingMoveX || 0) + dx;
      r.pendingMoveY = (r.pendingMoveY || 0) + dy;
    },

    /** Real sweep-based ground contact from the character controller (see Rigidbody2D.js's `grounded` field doc) — not a velocity-epsilon guess. */
    get grounded() { var r = _rb(entity); return r ? r.grounded : false; },
    /** The ACTUAL (possibly blocked/slid) movement achieved last step — use this instead of velocity to check "did I really move?". */
    get resolvedVelocity() {
      var r = _rb(entity);
      return r ? { x: r.resolvedVelocityX, y: r.resolvedVelocityY } : { x: 0, y: 0 };
    },

    // Explicitly unsupported on Kinematic — dynamic-only concepts.
    addForce: function () { _throwUnsupported(BodyType.KINEMATIC, "addForce"); },
    addImpulse: function () { _throwUnsupported(BodyType.KINEMATIC, "addImpulse"); },
    addTorque: function () { _throwUnsupported(BodyType.KINEMATIC, "addTorque"); },
    addAngularImpulse: function () { _throwUnsupported(BodyType.KINEMATIC, "addAngularImpulse"); },
    get gravityScale() { return 0; },
    set gravityScale(v) { _throwUnsupported(BodyType.KINEMATIC, "gravityScale"); },
  });
}

/** STATIC: read-only stub. A static body never moves by definition, so
 * every mutator throws instead of silently doing nothing. */
function _createStaticAPI(entity) {
  var base = _baseReadOnly(entity);
  return Object.assign(base, {
    set velocity(v) { _throwUnsupported(BodyType.STATIC, "velocity"); },
    get velocityX() { return 0; },
    set velocityX(v) { _throwUnsupported(BodyType.STATIC, "velocityX"); },
    get velocityY() { return 0; },
    set velocityY(v) { _throwUnsupported(BodyType.STATIC, "velocityY"); },
    get grounded() { return false; },

    move: function () { _throwUnsupported(BodyType.STATIC, "move"); },
    addForce: function () { _throwUnsupported(BodyType.STATIC, "addForce"); },
    addImpulse: function () { _throwUnsupported(BodyType.STATIC, "addImpulse"); },
    addTorque: function () { _throwUnsupported(BodyType.STATIC, "addTorque"); },
    addAngularImpulse: function () { _throwUnsupported(BodyType.STATIC, "addAngularImpulse"); },
  });
}

/**
 * Builds the `this.rigidbody` object for a given entity, LIVE-checking
 * the entity's current Rigidbody2D.bodyType on every property/method
 * access (via a Proxy) so the exposed API always matches reality even
 * if a script changes bodyType at runtime (e.g. switching an object
 * from Kinematic to Dynamic mid-game) — no stale API shape from the
 * moment the script started.
 * @param {import('../../core/World.js').Entity} entity
 * @returns {object}
 */
export function createRigidbodyAPI(entity) {
  var apis = {}; // built lazily, one object per body type, cached
  apis[BodyType.DYNAMIC] = null;
  apis[BodyType.KINEMATIC] = null;
  apis[BodyType.STATIC] = null;

  function _current() {
    var r = _rb(entity);
    var bodyType = r ? r.bodyType : BodyType.STATIC;
    if (!apis[bodyType]) {
      if (bodyType === BodyType.DYNAMIC) apis[bodyType] = _createDynamicAPI(entity);
      else if (bodyType === BodyType.KINEMATIC) apis[bodyType] = _createKinematicAPI(entity);
      else apis[bodyType] = _createStaticAPI(entity);
    }
    return apis[bodyType];
  }

  return new Proxy(
    {},
    {
      get: function (_target, prop) {
        return _current()[prop];
      },
      set: function (_target, prop, value) {
        _current()[prop] = value;
        return true;
      },
      has: function (_target, prop) {
        return prop in _current();
      },
    }
  );
}
