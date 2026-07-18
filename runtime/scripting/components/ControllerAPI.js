/**
 * runtime/scripting/components/ControllerAPI.js
 *
 * The `this.controller` sub-object exposed to user scripts (see
 * scripting/ScriptAPI.js). One file per scripting component — see
 * TransformAPI.js's header comment for the general rationale.
 *
 * MOVEMENT-TYPE-AWARE, same convention as RigidbodyAPI.js's
 * body-type-aware API: this exposes a DIFFERENT set of members
 * depending on the entity's actual CharacterController.controllerType,
 * matching what that movement type's own tunables/behavior actually
 * are (see components/CharacterController.js) instead of one flat
 * object where most fields are meaningless for most types:
 *
 *   - Character Controller / Platformer / Top-Down (all share the
 *     "walk + optional gravity + optional jump" tunables):
 *       moveSpeed, acceleration, airControl, useGravity,
 *       useDefaultInput
 *     Character Controller + Platformer only (both can jump):
 *       canJump, jumpForce, maxJumps, isGrounded, simulateJump()
 *   - Car:
 *       maxSpeed, acceleration (maps to CharacterController.
 *       carAcceleration — same tunable, Car's own name for it),
 *       brakeForce, turnSpeed, driftFactor, useDefaultInput
 *   - Follow:
 *       targetName, followSpeed, followDistance
 *   - Free: this sub-object still exists (so this.controller.
 *     controllerType reads "Free" and a script can check what type it
 *     is), but every member beyond `type` throws — Free means fully
 *     script-driven (see CharacterController.js's doc comment):
 *     ControllerSystem does nothing for it at all, so there is no
 *     isGrounded/simulateJump/etc. for this.controller to report.
 *
 * Calling/reading a member that doesn't apply to the CURRENT
 * controllerType throws a clear, actionable error (same three-way
 * split as RigidbodyAPI.js: missing-component / unsupported-
 * controller-type / unknown-api) instead of silently returning
 * undefined or a stale/wrong value.
 *
 * isGrounded reads Rigidbody2D.grounded — populated by
 * PhysicsWorld.js's character-controller sweep for Kinematic bodies,
 * and by ControllerSystem.js's own epsilon check for Dynamic bodies
 * (see that file's _applyDynamic). simulateJump() sets
 * CharacterController.requestJump, a one-shot flag ControllerSystem.js
 * consumes on its next update exactly like a literal Space keypress —
 * see ControllerSystem.js's _applyDynamic/_applyKinematic.
 *
 * IMPLEMENTATION NOTE: like RigidbodyAPI.js, this deliberately does
 * NOT put throwing getters inside the per-type object literals below —
 * Object.assign()/an object literal evaluates a getter IMMEDIATELY
 * while being built, not lazily when read, so a throwing getter placed
 * directly in one of these literals would crash API construction
 * itself. Each type's object literal only defines what it actually
 * supports; the Proxy in createControllerAPI() consults
 * ALL_KNOWN_MEMBERS to tell "wrong controller type" apart from
 * "not a real member at all".
 *
 * RUNTIME-ONLY FILE.
 */

import { CHARACTER_CONTROLLER, ControllerType } from "../../components/CharacterController.js";
import { RIGIDBODY_2D, BodyType } from "../../components/Rigidbody2D.js";

function _cc(entity) {
  return entity.getComponent(CHARACTER_CONTROLLER);
}
function _rb(entity) {
  return entity.getComponent(RIGIDBODY_2D);
}

function _tag(err, kind) {
  err.kind = kind;
  return err;
}

function _missingComponentError(entity, member) {
  return _tag(new Error(
    "'" + (entity.name || "Entity") + "' called this.controller." + member +
    " but has no Character Controller component. " +
    "Add one in the Inspector (Add Component → Character Controller) and pick a Movement Type."
  ), "missing-component");
}

function _unknownMemberError(entity, controllerType, member) {
  return _tag(new Error(
    "this.controller." + member + " does not exist. Check the spelling — " +
    "see the autocomplete list for this.controller on a " + controllerType + " controller."
  ), "unknown-api");
}

function _unsupportedError(controllerType, member, why) {
  return _tag(new Error(
    "controller." + member + " is not available on a " + controllerType +
    " controller. " + why
  ), "unsupported-body-type");
}

const JUMP_WHY = "Only Character Controller and Platformer movement types can jump — change the Movement Type in the Inspector if this object needs to jump.";
const CAR_ONLY_WHY = "This is a Car-only tunable — change the Movement Type to Car in the Inspector to use it.";
const FOLLOW_ONLY_WHY = "This is a Follow-only tunable — change the Movement Type to Follow in the Inspector to use it.";
const WALK_ONLY_WHY = "This tunable only applies to Character Controller, Platformer, or Top-Down movement types.";
const FREE_WHY = "Free means fully script-driven — ControllerSystem does not run for it at all (see CharacterController.js), so there is nothing for this.controller to report or trigger here. Drive this.rigidbody directly instead.";

/** Shared "am I currently grounded" read, used by both Character
 * Controller and Platformer — populated by PhysicsWorld.js's sweep
 * (Kinematic) or ControllerSystem.js's own check (Dynamic). */
function _isGrounded(entity) {
  var r = _rb(entity);
  return r ? !!r.grounded : false;
}

/** Shared simulateJump() — sets the one-shot request flag
 * ControllerSystem.js consumes on its next update, exactly like a
 * literal Space keypress would. No-ops (does not throw) if canJump is
 * off or maxJumps is already used up THIS frame — same as a real
 * keypress would silently do nothing in that case; the point of
 * simulateJump() is "ask for a jump", not "force one no matter what". */
function _simulateJump(entity) {
  var c = _cc(entity);
  if (c) c.requestJump = true;
}

/** WALK family: Character Controller, Platformer, Top-Down. All three
 * share moveSpeed/acceleration/airControl/useGravity/useDefaultInput;
 * jump-specific members are added only for Character/Platformer below. */
function _createWalkAPI(entity, canJump) {
  var api = {
    get controllerType() { var c = _cc(entity); return c ? c.controllerType : null; },

    get moveSpeed() { var c = _cc(entity); return c ? c.moveSpeed : 0; },
    set moveSpeed(v) { var c = _cc(entity); if (c) c.moveSpeed = v; },
    get acceleration() { var c = _cc(entity); return c ? c.acceleration : 0; },
    set acceleration(v) { var c = _cc(entity); if (c) c.acceleration = v; },
    get airControl() { var c = _cc(entity); return c ? c.airControl : 0; },
    set airControl(v) { var c = _cc(entity); if (c) c.airControl = v; },
    get useGravity() { var c = _cc(entity); return c ? c.useGravity : false; },
    set useGravity(v) { var c = _cc(entity); if (c) c.useGravity = !!v; },
    get useDefaultInput() { var c = _cc(entity); return c ? c.useDefaultInput : false; },
    set useDefaultInput(v) { var c = _cc(entity); if (c) c.useDefaultInput = !!v; },
  };
  if (canJump) {
    Object.defineProperties(api, {
      canJump: {
        get: function () { var c = _cc(entity); return c ? c.canJump : false; },
        set: function (v) { var c = _cc(entity); if (c) c.canJump = !!v; },
        enumerable: true,
      },
      jumpForce: {
        get: function () { var c = _cc(entity); return c ? c.jumpForce : 0; },
        set: function (v) { var c = _cc(entity); if (c) c.jumpForce = v; },
        enumerable: true,
      },
      maxJumps: {
        get: function () { var c = _cc(entity); return c ? c.maxJumps : 0; },
        set: function (v) { var c = _cc(entity); if (c) c.maxJumps = v; },
        enumerable: true,
      },
      isGrounded: {
        get: function () { return _isGrounded(entity); },
        enumerable: true,
      },
      simulateJump: {
        value: function () { _simulateJump(entity); },
        enumerable: true,
      },
    });
  }
  return api;
}

/** CAR: throttle/brake + steer tunables. `acceleration` here is
 * deliberately the SAME property name as the walk family's
 * acceleration (matches the "controller.acceleration" spelling asked
 * for), but reads/writes CharacterController.carAcceleration — the
 * component's own Car-specific field — since a Car has no separate
 * "acceleration" field of its own; carAcceleration IS its acceleration. */
function _createCarAPI(entity) {
  return {
    get controllerType() { var c = _cc(entity); return c ? c.controllerType : null; },

    get maxSpeed() { var c = _cc(entity); return c ? c.maxSpeed : 0; },
    set maxSpeed(v) { var c = _cc(entity); if (c) c.maxSpeed = v; },
    get acceleration() { var c = _cc(entity); return c ? c.carAcceleration : 0; },
    set acceleration(v) { var c = _cc(entity); if (c) c.carAcceleration = v; },
    get brakeForce() { var c = _cc(entity); return c ? c.brakeForce : 0; },
    set brakeForce(v) { var c = _cc(entity); if (c) c.brakeForce = v; },
    get turnSpeed() { var c = _cc(entity); return c ? c.turnSpeed : 0; },
    set turnSpeed(v) { var c = _cc(entity); if (c) c.turnSpeed = v; },
    get driftFactor() { var c = _cc(entity); return c ? c.driftFactor : 0; },
    set driftFactor(v) { var c = _cc(entity); if (c) c.driftFactor = v; },
    get useDefaultInput() { var c = _cc(entity); return c ? c.useDefaultInput : false; },
    set useDefaultInput(v) { var c = _cc(entity); if (c) c.useDefaultInput = !!v; },
  };
}

/** FOLLOW: pursuit tunables only — no movement/jump concept. */
function _createFollowAPI(entity) {
  return {
    get controllerType() { var c = _cc(entity); return c ? c.controllerType : null; },

    get targetName() { var c = _cc(entity); return c ? c.targetName : ""; },
    set targetName(v) { var c = _cc(entity); if (c) c.targetName = v; },
    get followSpeed() { var c = _cc(entity); return c ? c.followSpeed : 0; },
    set followSpeed(v) { var c = _cc(entity); if (c) c.followSpeed = v; },
    get followDistance() { var c = _cc(entity); return c ? c.followDistance : 0; },
    set followDistance(v) { var c = _cc(entity); if (c) c.followDistance = v; },
  };
}

/** FREE: only `controllerType` is readable — everything else throws
 * (see FREE_WHY) since ControllerSystem does nothing for this type. */
function _createFreeAPI(entity) {
  return {
    get controllerType() { var c = _cc(entity); return c ? c.controllerType : null; },
  };
}

// Every member name that exists on AT LEAST ONE controller type. Used
// by the Proxy to tell "this doesn't exist anywhere" (unknown-api / a
// typo) apart from "this exists, but not for the CURRENT controller
// type" (unsupported-body-type, reusing RigidbodyAPI's `kind` value
// since it's the same concept — "wrong variant of this component").
const ALL_KNOWN_MEMBERS = new Set([
  "controllerType",
  "moveSpeed", "acceleration", "airControl", "useGravity", "useDefaultInput",
  "canJump", "jumpForce", "maxJumps", "isGrounded", "simulateJump",
  "maxSpeed", "brakeForce", "turnSpeed", "driftFactor",
  "targetName", "followSpeed", "followDistance",
]);

// Which "why" explanation to show for each unsupported member, keyed
// by member name — covers every member NOT valid on every type.
function _whyFor(member) {
  if (member === "canJump" || member === "jumpForce" || member === "maxJumps" ||
      member === "isGrounded" || member === "simulateJump") return JUMP_WHY;
  if (member === "maxSpeed" || member === "brakeForce" || member === "turnSpeed" || member === "driftFactor") return CAR_ONLY_WHY;
  if (member === "targetName" || member === "followSpeed" || member === "followDistance") return FOLLOW_ONLY_WHY;
  if (member === "moveSpeed" || member === "airControl" || member === "useGravity") return WALK_ONLY_WHY;
  return "This tunable does not apply to the current Movement Type.";
}

/**
 * Builds the `this.controller` object for a given entity, LIVE-checking
 * the entity's current CharacterController.controllerType on every
 * access (via a Proxy) so the exposed API always matches the Inspector
 * setting — same pattern as createRigidbodyAPI's body-type awareness.
 * @param {import('../../core/World.js').Entity} entity
 * @returns {object}
 */
export function createControllerAPI(entity) {
  var apis = {}; // built lazily, one object per controller type, cached

  function _current() {
    var c = _cc(entity);
    var type = c ? c.controllerType : ControllerType.FREE;
    if (!apis[type]) {
      if (type === ControllerType.CHARACTER) apis[type] = _createWalkAPI(entity, true);
      else if (type === ControllerType.PLATFORMER) apis[type] = _createWalkAPI(entity, true);
      else if (type === ControllerType.TOP_DOWN) apis[type] = _createWalkAPI(entity, false);
      else if (type === ControllerType.CAR) apis[type] = _createCarAPI(entity);
      else if (type === ControllerType.FOLLOW) apis[type] = _createFollowAPI(entity);
      else apis[type] = _createFreeAPI(entity);
    }
    return apis[type];
  }

  return new Proxy(
    {},
    {
      get: function (_target, prop) {
        if (typeof prop === "symbol") return undefined;
        var key = String(prop);
        if (key === "then") return undefined; // avoid Promise-like duck-typing false positives
        if (!_cc(entity)) throw _missingComponentError(entity, key);

        var current = _current();
        if (key in current) {
          var value = current[key];
          return typeof value === "function" ? value.bind(current) : value;
        }
        var type = current.controllerType || "?";
        if (type === ControllerType.FREE && key !== "controllerType" && ALL_KNOWN_MEMBERS.has(key)) {
          throw _unsupportedError(type, key, FREE_WHY);
        }
        if (ALL_KNOWN_MEMBERS.has(key)) {
          throw _unsupportedError(type, key, _whyFor(key));
        }
        throw _unknownMemberError(entity, type, key);
      },
      set: function (_target, prop, value) {
        var key = String(prop);
        if (!_cc(entity)) throw _missingComponentError(entity, key);
        var current = _current();
        if (key in current) {
          var descriptor = Object.getOwnPropertyDescriptor(current, key);
          if (descriptor && !descriptor.set && descriptor.get) {
            // Read-only member for this type (e.g. isGrounded) — exists
            // and is readable, just can't be assigned to. Distinct
            // message from _unsupportedError (which means "doesn't
            // exist for this type AT ALL") so this doesn't read as a
            // contradiction ("not available... but also read-only?").
            throw _tag(new Error(
              "controller." + key + " is read-only — it reflects the controller's real state " +
              "and can't be set directly." +
              (key === "isGrounded" ? " Move the entity via this.rigidbody or this.controller.simulateJump() instead." : "")
            ), "unsupported-body-type");
          }
          current[key] = value;
          return true;
        }
        var type = current.controllerType || "?";
        if (ALL_KNOWN_MEMBERS.has(key)) {
          throw _unsupportedError(type, key, _whyFor(key));
        }
        throw _unknownMemberError(entity, type, key);
      },
      has: function (_target, prop) {
        var key = String(prop);
        return _cc(entity) ? key in _current() : ALL_KNOWN_MEMBERS.has(key);
      },
    }
  );
}
