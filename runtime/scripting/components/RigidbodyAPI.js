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
 * IMPLEMENTATION NOTE — why the "unsupported on this body type" checks
 * live in the Proxy, not as throwing getters inside each body-type's
 * object literal: `Object.assign(target, { get x() { throw ... } })`
 * (or any object literal with a throwing getter) evaluates that getter
 * IMMEDIATELY while building the source object, not lazily when
 * something later reads `.x`. A throwing getter placed straight in one
 * of the _create*API object literals below would crash API
 * CONSTRUCTION itself, not just misuse of it. So instead, each body
 * type's object literal only defines what it actually supports, and
 * MEMBERS_BY_TYPE (below) records which extra names are valid on OTHER
 * body types — the Proxy consults that map to tell "wrong body type"
 * (throws unsupported-body-type) apart from "not a real member at all"
 * (throws unknown-api).
 *
 * RUNTIME-ONLY FILE.
 */

import { RIGIDBODY_2D, BodyType } from "../../components/Rigidbody2D.js";

function _rb(entity) {
  return entity.getComponent(RIGIDBODY_2D);
}

/** Tags an Error with a machine-readable `kind` so ScriptSystem can
 *  format a specific, actionable console message instead of a generic
 *  "X is not a function" — see ScriptSystem.js's _formatError(). */
function _tag(err, kind) {
  err.kind = kind;
  return err;
}

function _missingComponentError(entity, member) {
  return _tag(new Error(
    "'" + (entity.name || "Entity") + "' called this.rigidbody." + member +
    " but has no Rigidbody 2D. Add one in the Inspector (Add Component → Rigidbody 2D)."
  ), "missing-component");
}

function _unknownMemberError(entity, bodyType, member) {
  return _tag(new Error(
    "this.rigidbody." + member + " does not exist. Check the spelling — " +
    "see the autocomplete list for this.rigidbody on a " + bodyType + " body."
  ), "unknown-api");
}

function _unsupportedError(bodyType, member) {
  return _tag(new Error(
    "rigidbody." + member + " is not available on a " + bodyType +
    " body. " +
    (bodyType === BodyType.STATIC
      ? "Static bodies never move — change the Body Type to Dynamic or Kinematic in the Inspector if this object needs to move."
      : bodyType === BodyType.KINEMATIC
      ? "Kinematic bodies are moved directly (use rigidbody.velocity or rigidbody.move(dx, dy)), not by forces — Rapier never applies forces/impulses to a kinematic body. Use Dynamic if you want physics-driven forces."
      : "This body type does not support that operation.")
  ), "unsupported-body-type");
}

/** DYNAMIC: full force/impulse/torque API. Rapier's solver owns everything. */
function _createDynamicAPI(entity) {
  return {
    get type() { var r = _rb(entity); return r ? r.bodyType : null; },

    get velocity() { var r = _rb(entity); return r ? { x: r.velocityX, y: r.velocityY } : { x: 0, y: 0 }; },
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

    get grounded() { return false; },
  };
}

/** KINEMATIC: velocity drives the character-controller sweep; move()
 * is a one-shot swept nudge; grounded/resolvedVelocity are read-only
 * results of that sweep. No force/impulse/torque — Rapier never
 * integrates forces into a kinematic body. */
function _createKinematicAPI(entity) {
  return {
    get type() { var r = _rb(entity); return r ? r.bodyType : null; },

    get velocity() { var r = _rb(entity); return r ? { x: r.velocityX, y: r.velocityY } : { x: 0, y: 0 }; },
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
    /** True when the character controller's sweep says the body is on the ground. */
    get isGrounded() { var r = _rb(entity); return r ? r.grounded : false; },
    /** Alias for isGrounded — kept for compatibility with existing scripts. */
    get grounded() { var r = _rb(entity); return r ? r.grounded : false; },
    /** True when the controller has detected a ceiling contact above the body. */
    get isOnCeiling() { var r = _rb(entity); return r ? r.isOnCeiling : false; },
    /** True when the controller has detected a wall contact on either side. */
    get isOnWall() { var r = _rb(entity); return r ? r.isOnWall : false; },
    /** True when the body is grounded on a sloped surface (groundAngle > 5°). */
    get isOnSlope() { var r = _rb(entity); return r ? r.isOnSlope : false; },
    /** Angle of the ground surface in degrees from horizontal (0=flat, 45=steep). Alias: slopeAngle. */
    get groundAngle() { var r = _rb(entity); return r ? r.groundAngle : 0; },
    /** Alias for groundAngle — matches Unity naming convention. */
    get slopeAngle() { var r = _rb(entity); return r ? r.groundAngle : 0; },
    /** The ACTUAL (possibly blocked/slid) movement achieved last step — use this instead of velocity to check "did I really move?". */
    get resolvedVelocity() {
      var r = _rb(entity);
      return r ? { x: r.resolvedVelocityX, y: r.resolvedVelocityY } : { x: 0, y: 0 };
    },

    get gravityScale() { return 0; },
  };
}

/** STATIC: read-only stub. A static body never moves by definition —
 * every member below is read-only or a fixed zero value; anything
 * that would mutate it (or any Dynamic/Kinematic-only member) is
 * handled by the Proxy's unsupported-body-type check instead of being
 * defined here. */
function _createStaticAPI(entity) {
  return {
    get type() { var r = _rb(entity); return r ? r.bodyType : BodyType.STATIC; },
    get velocity() { return { x: 0, y: 0 }; },
    get velocityX() { return 0; },
    get velocityY() { return 0; },
    get grounded() { return false; },
  };
}

// Every member name that exists on AT LEAST ONE body type. Used by the
// Proxy to tell "this doesn't exist anywhere" (unknown-api / a typo)
// apart from "this exists, but not for the CURRENT body type"
// (unsupported-body-type — e.g. addForce on Kinematic/Static).
const ALL_KNOWN_MEMBERS = new Set([
  "type", "velocity", "velocityX", "velocityY", "mass", "gravityScale",
  "linearDamping", "angularDamping", "addForce", "addImpulse",
  "addTorque", "addAngularImpulse", "move", "grounded", "isGrounded",
  "isOnCeiling", "isOnWall", "isOnSlope", "groundAngle", "slopeAngle",
  "resolvedVelocity",
]);

// Members that exist but are READ-ONLY on Static specifically (used to
// give "velocity = ..." on a Static body its own clear message instead
// of a generic "unknown member" or a silent no-op).
const STATIC_READONLY_MEMBERS = new Set(["velocity", "velocityX", "velocityY", "type", "grounded"]);

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
        if (typeof prop === "symbol") return undefined;
        var key = String(prop);
        if (key === "then") return undefined; // avoid Promise-like duck-typing false positives
        // No Rigidbody2D component at all — distinct from "wrong body
        // type", since adding ANY Rigidbody 2D fixes this, whereas
        // "wrong body type" needs a specific type change.
        if (!_rb(entity)) throw _missingComponentError(entity, key);

        var current = _current();
        if (key in current) {
          var value = current[key];
          // Re-bind methods so `this` inside them still resolves via
          // the real per-body-type object, not this Proxy wrapper.
          return typeof value === "function" ? value.bind(current) : value;
        }
        if (ALL_KNOWN_MEMBERS.has(key)) {
          throw _unsupportedError(current.type || "?", key);
        }
        throw _unknownMemberError(entity, current.type || "?", key);
      },
      set: function (_target, prop, value) {
        var key = String(prop);
        if (!_rb(entity)) throw _missingComponentError(entity, key);
        var current = _current();
        if (key in current) {
          if (current.type === BodyType.STATIC && STATIC_READONLY_MEMBERS.has(key)) {
            throw _unsupportedError(BodyType.STATIC, key);
          }
          current[key] = value;
          return true;
        }
        if (ALL_KNOWN_MEMBERS.has(key)) {
          throw _unsupportedError(current.type || "?", key);
        }
        throw _unknownMemberError(entity, current.type || "?", key);
      },
      has: function (_target, prop) {
        var key = String(prop);
        return _rb(entity) ? key in _current() : ALL_KNOWN_MEMBERS.has(key);
      },
    }
  );
}
