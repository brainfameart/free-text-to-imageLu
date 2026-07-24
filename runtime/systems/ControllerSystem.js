/**
 * runtime/systems/ControllerSystem.js
 *
 * Reads CharacterController + Rigidbody2D and, every frame, decides what
 * this frame's move/jump intent is. It NEVER talks to Rapier directly
 * and does no collision detection or force integration of its own —
 * that is 100% still done by Rapier inside runtime/physics/PhysicsWorld.js.
 * Depending on the entity's Rigidbody2D.bodyType, the intent is hooked
 * up differently, both ending up going through Rapier's own setLinvel:
 *
 *  - KINEMATIC: this system writes the full target velocity straight
 *    into Rigidbody2D.velocityX/velocityY, the same fields the
 *    Inspector's Kinematic velocity sliders already write to.
 *    PhysicsWorld.js applies them verbatim via setLinvel every step —
 *    Rapier still does collision sweeping/detection, but nothing pushes
 *    the body around with real forces (no gravity, no being shoved).
 *
 *  - DYNAMIC: this system instead sets the transient
 *    Rigidbody2D.driveVelocityX / driveVelocityY fields (see
 *    components/Rigidbody2D.js) each frame. PhysicsWorld.js seeds only
 *    those axes into Rapier's linear velocity via setLinvel and then
 *    clears them — everything else (falling under gravity, being pushed
 *    by other dynamic bodies, landing on slopes) is still fully owned by
 *    Rapier's solver, exactly like a real physics-based character
 *    controller (e.g. Unity's Rigidbody-driven CharacterController
 *    convention) instead of a kinematic sweep. This is the body type
 *    generally recommended for platformers/character controllers, since
 *    only Dynamic bodies get correct push-back/contact response from
 *    the solver.
 *
 * Runs BEFORE PhysicsSystem in the systems list (see runtime/index.js)
 * so whatever it writes is picked up by the same physics step.
 *
 * Supported controllerType values (see components/CharacterController.js):
 *  - "Character Controller": 8-directional move, optional gravity, jump.
 *  - "Platformer":           horizontal move + jump, gravity always on.
 *  - "Top-Down":             8-directional move, no gravity, no jump.
 *  - "Free":                 no built-in input mapping — velocity is
 *                            left alone for a user script to drive.
 *
 * RUNTIME-ONLY FILE.
 */

import { System } from "../core/System.js";
import { TRANSFORM } from "../components/Transform.js";
import { RIGIDBODY_2D, BodyType } from "../components/Rigidbody2D.js";
import { CHARACTER_CONTROLLER, ControllerType } from "../components/CharacterController.js";

const GRAVITY_Y = 980; // px/s^2 — matches PhysicsWorld.js's GRAVITY_Y. Only
// used for the KINEMATIC path (which gets none of Rapier's own gravity
// integration for free) so a gravity-enabled Kinematic controller still
// falls at a visually consistent rate. Dynamic bodies never use this —
// they get real gravity straight from Rapier via gravityScale.

// A grounded KINEMATIC body used to get vy hard-zeroed every frame,
// which fed Rapier's character-controller sweep (PhysicsWorld.js's
// computeColliderMovement) a desired movement with EXACTLY zero
// vertical component whenever the character walked on flat ground.
// Rapier's own character controller has a documented gotcha for
// exactly that case — a fully zero desired-movement vector produces
// degenerate/unreliable contact resolution against the very floor
// the character is resting on (see Rapier issue #485: a zeroed
// vertical axis makes the sweep treat contacts inconsistently versus
// even a tiny nonzero one) — which is what made horizontal movement
// feel sticky/blocked specifically while standing on the ground.
// Rapier's own docs/community guidance for kinematic character
// controllers is to keep a small constant downward "stick to ground"
// bias rather than ever passing a literal zero — snap-to-ground
// (already enabled in PhysicsWorld.js) then absorbs this small
// per-frame push and keeps the character glued to the floor instead of
// visibly sinking. 40 px/s is far below the 2px snap-to-ground
// distance's per-frame travel at normal frame rates, so it's
// imperceptible as "falling" but keeps the sweep's vertical component
// reliably nonzero every single grounded frame.
const GROUND_STICK_VY = 40; // px/s downward bias applied only while grounded

// Keys this engine's default input binds to game actions (see isDown()
// calls throughout this file: ArrowLeft/Right/Up/Down, WASD, Space).
// Their default browser behavior (arrow keys and Space scroll the
// page; Space also "clicks" whatever element currently has focus) is
// suppressed ONLY for these specific codes — not blanket-blocked for
// every key — so normal browser/editor shortcuts and any text inputs
// elsewhere on the page keep working normally.
const GAME_KEY_CODES = new Set([
  "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown",
  "KeyW", "KeyA", "KeyS", "KeyD",
  "Space",
]);

/** Tracks currently-held keys. One instance per ControllerSystem (per game). */
class InputState {
  constructor() {
    this.keys = new Set();
    this._onKeyDown = (e) => {
      // BUG FIX: without this, holding an arrow key or Space scrolled
      // the whole page (taking the game canvas out of view), and
      // Space could "click" a focused button/link on the page. Either
      // one can shift keyboard focus away from the game, which
      // sometimes drops the matching keyup event entirely — leaving
      // that key stuck "down" in this Set forever, i.e. a character
      // that keeps walking/jumping on its own after the key was
      // actually released. preventDefault() only for the specific
      // codes this engine binds to game actions (see GAME_KEY_CODES
      // above), so nothing else on the page is affected.
      //
      // BUG FIX 2: this listener is attached to `window` and this
      // system lives for as long as the editor's own live preview is
      // running (SceneViewport.js calls createGame() to drive it),
      // not just inside actual Play mode. That means it was ALWAYS
      // active while using the editor — including while typing in the
      // Monaco script editor. Since WASD/Space/arrows are exactly the
      // codes this handler preventDefault()s unconditionally, every
      // one of those keystrokes was swallowed before Monaco's own
      // hidden textarea ever saw them, while every other key typed
      // normally. Guard against that: skip entirely when a normal
      // text input/textarea or the Monaco editor currently has focus.
      if (InputState._isTypingTarget(e.target)) return;
      if (GAME_KEY_CODES.has(e.code)) e.preventDefault();
      this.keys.add(e.code);
    };
    this._onKeyUp = (e) => {
      if (InputState._isTypingTarget(e.target)) return;
      this.keys.delete(e.code);
    };
    window.addEventListener("keydown", this._onKeyDown);
    window.addEventListener("keyup", this._onKeyUp);
  }

  /**
   * True when the event's target is a normal text field or Monaco's
   * own editing surface, meaning the keystroke is meant for typing —
   * not game input — and this system should get completely out of
   * its way (no preventDefault, no key tracking). Checked on both
   * keydown and keyup so a key held while focus moves in/out of a
   * text field doesn't leave a stuck entry in `keys`.
   */
  static _isTypingTarget(target) {
    if (!target) return false;
    if (/^(input|textarea)$/i.test(target.tagName)) return true;
    if (target.isContentEditable) return true;
    // Monaco's real keyboard-capturing element is a hidden textarea
    // with class "inputarea" inside .monaco-editor — some browsers
    // report its tagName oddly, so also check via closest() as a
    // belt-and-suspenders match against the editor's outer container.
    if (target.closest && target.closest(".monaco-editor")) return true;
    return false;
  }

  isDown(...codes) {
    return codes.some((c) => this.keys.has(c));
  }

  destroy() {
    window.removeEventListener("keydown", this._onKeyDown);
    window.removeEventListener("keyup", this._onKeyUp);
    this.keys.clear();
  }
}

export class ControllerSystem extends System {
  constructor() {
    super();
    this.input = new InputState();
    /** @type {Map<string, number>} entityId -> vertical velocity carried between frames (KINEMATIC path only — DYNAMIC gets real gravity from Rapier) */
    this._verticalVelocity = new Map();
    /** @type {Map<string, number>} entityId -> jumps used since last grounded */
    this._jumpsUsed = new Map();
    /** @type {Map<string, number>} entityId -> current forward speed (Car controller) */
    this._carSpeed = new Map();
  }

  update(world, dt) {
    const entities = world.query(TRANSFORM, CHARACTER_CONTROLLER, RIGIDBODY_2D);

    for (const entity of entities) {
      const controller = entity.getComponent(CHARACTER_CONTROLLER);
      const rigidbody = entity.getComponent(RIGIDBODY_2D);

      // FREE means "fully script-driven" (see CharacterController.js's
      // doc comment) — this system does nothing at all for it, so a
      // script's own this.rigidbody calls are never fought/overridden.
      if (controller.controllerType === ControllerType.FREE) continue;
      // Static bodies never move — nothing to drive.
      if (rigidbody.bodyType === BodyType.STATIC) continue;

      const type = controller.controllerType;
      if (type === ControllerType.CAR) {
        if (controller.useDefaultInput) this._applyCar(entity, controller, rigidbody, dt);
      } else if (type === ControllerType.FOLLOW) {
        this._applyFollow(entity, controller, rigidbody, dt, world);
      } else if (rigidbody.bodyType === BodyType.DYNAMIC) {
        // NOTE: unlike useDefaultInput's old all-or-nothing gate, this
        // still runs even with useDefaultInput=false for Character/
        // Platformer/Top-Down — it just skips reading the keyboard
        // (see the `controller.useDefaultInput ? ... : false` reads
        // inside _applyDynamic/_applyKinematic below) so gravity and
        // controller.simulateJump() (scripting/components/
        // ControllerAPI.js) still work for a controller a script wants
        // to trigger jumps on without also taking over WASD.
        this._applyDynamic(entity.id, controller, rigidbody, dt);
      } else {
        this._applyKinematic(entity.id, controller, rigidbody, dt);
      }
    }
  }

  /**
   * DYNAMIC path: seeds Rapier's velocity via the transient
   * driveVelocityX/driveVelocityY fields (consumed + cleared each step by
   * PhysicsWorld.js) instead of owning velocity outright, so gravity,
   * contact pushback, and landing on slopes all stay fully Rapier's.
   */
  _applyDynamic(entityId, controller, rigidbody, dt) {
    const useKeys = controller.useDefaultInput;
    const left = useKeys && this.input.isDown("ArrowLeft", "KeyA");
    const right = useKeys && this.input.isDown("ArrowRight", "KeyD");
    const up = useKeys && this.input.isDown("ArrowUp", "KeyW");
    const down = useKeys && this.input.isDown("ArrowDown", "KeyS");
    // A script can request a jump via this.controller.simulateJump()
    // (scripting/components/ControllerAPI.js sets requestJump=true on
    // the component); consumed here alongside the keyboard Space key
    // so both trigger the exact same jump logic/limits.
    const jumpPressed = (useKeys && this.input.isDown("Space")) || controller.requestJump;
    controller.requestJump = false;

    // A script can request movement via this.controller.simulateMove(x, y)
    // (ControllerAPI.js) — consumed here as a one-shot per-frame axis
    // request, same lifecycle as requestJump above. When present it
    // OVERRIDES the keyboard's own -1/0/1 read for that axis rather than
    // adding to it, so simulateMove(-1, 0) reliably means "move left"
    // regardless of what keys happen to be held at the same time.
    const keyMoveX = (right ? 1 : 0) - (left ? 1 : 0);
    const keyMoveY = (down ? 1 : 0) - (up ? 1 : 0);
    const moveX = controller.requestMoveX !== null ? controller.requestMoveX : keyMoveX;
    const moveY = controller.requestMoveY !== null ? controller.requestMoveY : keyMoveY;
    controller.requestMoveX = null;
    controller.requestMoveY = null;

    const targetX = moveX * controller.moveSpeed;

    // AIR CONTROL FIX: same gap as the Kinematic path below — airControl
    // (0-1 multiplier on acceleration while airborne) was previously
    // never read here, so a Dynamic Character Controller/Platformer
    // always accelerated at full ground acceleration in mid-air. Uses
    // the "near-zero vertical speed" grounded epsilon (defined below,
    // moved up here so both the lerp and the later grounded/jump logic
    // can share the same value) rather than rigidbody.grounded's
    // previous-frame value, so this reacts the same frame gravity
    // starts pulling the body down. Top-Down has no gravity/air concept
    // at all, so it always uses full acceleration.
    const grounded = controller.controllerType === ControllerType.TOP_DOWN
      ? true
      : Math.abs(rigidbody.velocityY) < 20; // small epsilon: resting/near-zero vertical speed
    const airborneMultiplier = grounded ? 1 : controller.airControl;

    // Smoothly approach the target horizontal speed rather than snapping.
    const lerpT = Math.min(1, controller.acceleration * airborneMultiplier * dt);
    const currentX = rigidbody.velocityX; // last value PhysicsWorld read back from Rapier
    rigidbody.driveVelocityX = currentX + (targetX - currentX) * lerpT;

    if (controller.controllerType === ControllerType.TOP_DOWN) {
      // Top-Down has no gravity concept even on a Dynamic body — drive Y
      // directly too via the same transient channel, bypassing gravity.
      const targetY = moveY * controller.moveSpeed;
      const currentY = rigidbody.velocityY;
      rigidbody.driveVelocityY = currentY + (targetY - currentY) * lerpT;
      return;
    }

    // Character Controller / Platformer on a Dynamic body: let Rapier's
    // own gravityScale integrate falling. We only ever touch Y to apply
    // a jump impulse (a velocity kick), never to simulate gravity
    // ourselves — that would double up with Rapier's.
    // (grounded was already computed above, before the air-control lerp.)
    // Store back onto the component (same field the Kinematic sweep in
    // PhysicsWorld.js already populates) so this.controller.isGrounded
    // (see scripting/components/ControllerAPI.js) reads real state on a
    // Dynamic body too, not just Kinematic. This IS a coarser signal
    // than Kinematic's real sweep-based grounded (no isOnCeiling/
    // isOnWall/isOnSlope/groundAngle equivalent exists for Dynamic —
    // Rapier's own solver handles those contacts, this engine doesn't
    // track them per-axis for Dynamic bodies), but it's the same
    // approximation this system already used internally, just now
    // exposed instead of staying a local-only const.
    rigidbody.grounded = grounded;
    if (grounded) this._jumpsUsed.set(entityId, 0);

    if (controller.canJump && jumpPressed) {
      const jumpsUsed = this._jumpsUsed.get(entityId) || 0;
      if (jumpsUsed < controller.maxJumps) {
        rigidbody.driveVelocityY = -controller.jumpForce; // negative = up (this engine is Y-down)
        this._jumpsUsed.set(entityId, jumpsUsed + 1);
      }
    }
  }

  /**
   * KINEMATIC path: this system owns velocity outright (Rapier applies
   * no forces to a Kinematic body), so it has to simulate its own
   * gravity/jump-arc using the same GRAVITY_Y constant PhysicsWorld.js
   * uses for Dynamic bodies, to keep the two body types feeling similar.
   */
  _applyKinematic(entityId, controller, rigidbody, dt) {
    const useKeys = controller.useDefaultInput;
    const left = useKeys && this.input.isDown("ArrowLeft", "KeyA");
    const right = useKeys && this.input.isDown("ArrowRight", "KeyD");
    const up = useKeys && this.input.isDown("ArrowUp", "KeyW");
    const down = useKeys && this.input.isDown("ArrowDown", "KeyS");
    const jumpPressed = (useKeys && this.input.isDown("Space")) || controller.requestJump;
    controller.requestJump = false;

    // A script can request movement via this.controller.simulateMove(x, y)
    // (ControllerAPI.js) — same one-shot lifecycle as requestJump, and
    // same override-not-add semantics as the Dynamic path above: when
    // set, it replaces the keyboard's -1/0/1 read for that axis rather
    // than combining with it.
    const keyMoveX = (right ? 1 : 0) - (left ? 1 : 0);
    const keyMoveY = (down ? 1 : 0) - (up ? 1 : 0);
    const moveX = controller.requestMoveX !== null ? controller.requestMoveX : keyMoveX;
    const moveY = controller.requestMoveY !== null ? controller.requestMoveY : keyMoveY;
    controller.requestMoveX = null;
    controller.requestMoveY = null;

    const targetX = moveX * controller.moveSpeed;

    // AIR CONTROL FIX: controller.airControl (0-1 multiplier on
    // acceleration while airborne — see CharacterController.js's doc
    // comment, the Inspector's "Air Control" slider, and
    // ControllerAPI.js's this.controller.airControl) was previously
    // defined and fully wired everywhere EXCEPT here — this system
    // never actually read it, so every controller accelerated at full
    // ground acceleration in mid-air regardless of the slider's value.
    // Applied only for Character Controller/Platformer (their gravity
    // path, resolved a few lines below) — Top-Down has no airborne
    // concept and already returns above.
    const airborneMultiplier = rigidbody.grounded ? 1 : controller.airControl;
    const lerpT = Math.min(1, controller.acceleration * airborneMultiplier * dt);
    rigidbody.velocityX += (targetX - rigidbody.velocityX) * lerpT;

    const usesGravity =
      controller.controllerType === ControllerType.PLATFORMER
        ? true
        : controller.controllerType === ControllerType.TOP_DOWN
        ? false
        : controller.useGravity;

    if (controller.controllerType === ControllerType.TOP_DOWN) {
      const targetY = moveY * controller.moveSpeed;
      rigidbody.velocityY += (targetY - rigidbody.velocityY) * lerpT;
      return;
    }

    let vy = this._verticalVelocity.get(entityId) || 0;
    // Real grounded state from PhysicsWorld's character-controller sweep
    // (see Rigidbody2D.grounded) — NOT a guess from vy itself. The old
    // guess compared vy (this same accumulator) against a small
    // epsilon, but vy keeps accumulating GRAVITY_Y*dt every single
    // frame regardless of whether the sweep actually let the body fall
    // — so once resting on the ground, vy grows every frame while the
    // actual movement stays ~0, the guess never reads "grounded" again,
    // gravity keeps piling up, and the next sweep has to correct a
    // bigger and bigger penetration each frame: exactly the standing
    // jitter/slipping symptom. Using the real grounded flag and
    // resetting vy to a small constant (not a literal zero — see
    // GROUND_STICK_VY above) the instant it's true breaks that feedback
    // loop while keeping the sweep's ground contact resolution stable.
    const grounded = rigidbody.grounded;

    // CEILING-STICKING FIX: rigidbody.isOnCeiling is written every step
    // by PhysicsWorld._syncKinematicMovement from the character
    // controller's real collision normals (a contact whose normal has a
    // downward component — see that method). Before this fix, nothing
    // ever looked at it here: a jumping character kept accumulating a
    // large negative (upward) vy from the jump impulse every frame, and
    // even though the sweep correctly BLOCKED the actual movement at
    // the ceiling (so the character visually stopped there), vy itself
    // was never cleared — so the desired movement handed to the sweep
    // next frame was still "move up fast", the sweep blocked it again,
    // and the character just sat there pressed flush against the
    // ceiling instead of immediately falling back down. Zeroing vy the
    // instant a ceiling contact is detected (mirrors the ground-contact
    // reset just below) lets gravity retake over immediately, exactly
    // like Unity/Rapier's own kinematic character controllers do.
    if (rigidbody.isOnCeiling && vy < 0) {
      vy = 0;
    }

    if (grounded) {
      // PERFORMANCE/CORRECTNESS: this used to hard-zero vy here, which
      // fed PhysicsWorld.js's character-controller sweep a desired
      // movement with EXACTLY zero vertical component every frame the
      // character stood on flat ground. Rapier's own kinematic
      // character controller has a well-documented gotcha for that
      // exact case (see GROUND_STICK_VY's comment above) where a fully
      // zero desired-movement vector produces inconsistent contact
      // resolution — in practice this showed up as horizontal movement
      // feeling sticky/blocked specifically while grounded, since the
      // sweep's floor contact never had a stable nonzero reference to
      // resolve sliding against. Using a small constant downward bias
      // instead keeps the sweep's vertical component reliably nonzero;
      // snap-to-ground (PhysicsWorld.js) absorbs the tiny resulting
      // per-frame dip so the character still visually stays flush with
      // the floor, exactly like before, but the sweep itself now has
      // consistent ground contact info to resolve horizontal sliding
      // against. Only applied when this controller actually wants
      // gravity/ground contact — a gravity-off floating Character
      // Controller has no floor concept to stick to, so it keeps its
      // old vy=0 (its vertical is fully overridden by direct move input
      // in the branch below anyway).
      vy = usesGravity ? GROUND_STICK_VY : 0;
      const jumpsUsed = this._jumpsUsed.get(entityId) || 0;
      if (jumpsUsed > 0) this._jumpsUsed.set(entityId, 0);
    }

    // Only apply gravity when NOT grounded — otherwise the body
    // vibrates: gravity pushes it down a hair each frame, snap-to-
    // ground pulls it back, and the cycle repeats as visible jitter.
    if (!grounded && usesGravity) {
      vy += GRAVITY_Y * dt;
    } else if (controller.controllerType === ControllerType.CHARACTER) {
      // Character Controller with gravity off: vertical is direct move
      // input too (e.g. a floating/flying controller). Reuses the same
      // moveY resolved above (keyboard OR a script's simulateMove(x,y))
      // instead of re-reading up/down directly, so a scripted vertical
      // move request works here exactly like it does for horizontal.
      vy = moveY * controller.moveSpeed;
    }

    if (controller.canJump && jumpPressed) {
      const jumpsUsed = this._jumpsUsed.get(entityId) || 0;
      if (jumpsUsed < controller.maxJumps) {
        vy = -controller.jumpForce;
        this._jumpsUsed.set(entityId, jumpsUsed + 1);
      }
    }

    this._verticalVelocity.set(entityId, vy);
    rigidbody.velocityY = vy;
  }

  /**
   * CAR controller: arcade-style car movement. Up/Down (W/S)
   * accelerate / brake-and-reverse; Left/Right (A/D) steer. Steering
   * is proportional to speed (can't turn when stopped). The car moves
   * along its own forward direction (derived from Transform rotation,
   * 0 deg = up, clockwise). Works on both Kinematic (velocityX/Y +
   * angularVelocity) and Dynamic (driveVelocityX/Y +
   * driveAngularVelocity) bodies.
   */
  _applyCar(entity, controller, rigidbody, dt) {
    const transform = entity.getComponent(TRANSFORM);
    if (!transform) return;

    const accelerate = this.input.isDown("ArrowUp", "KeyW");
    const brake = this.input.isDown("ArrowDown", "KeyS");
    const steerLeft = this.input.isDown("ArrowLeft", "KeyA");
    const steerRight = this.input.isDown("ArrowRight", "KeyD");

    let speed = this._carSpeed.get(entity.id) || 0;

    if (accelerate) {
      speed += controller.carAcceleration * dt;
    } else if (brake) {
      speed -= controller.brakeForce * dt;
    } else {
      // Natural deceleration when no throttle/brake input
      const decay = 200 * dt;
      if (speed > 0) speed = Math.max(0, speed - decay);
      else if (speed < 0) speed = Math.min(0, speed + decay);
    }
    // Clamp: full maxSpeed forward, half maxSpeed in reverse
    speed = Math.max(-controller.maxSpeed * 0.5, Math.min(controller.maxSpeed, speed));
    this._carSpeed.set(entity.id, speed);

    // Steering proportional to speed (can't turn when stopped)
    const speedFactor = Math.abs(speed) / controller.maxSpeed;
    const steer = (steerRight ? 1 : 0) - (steerLeft ? 1 : 0);
    const angVel = steer * controller.turnSpeed * speedFactor;

    // Forward direction from rotation (0 deg = up, clockwise)
    const rad = (transform.rotation * Math.PI) / 180;
    const forwardX = Math.sin(rad);
    const forwardY = -Math.cos(rad);
    const vx = forwardX * speed;
    const vy = forwardY * speed;

    if (rigidbody.bodyType === BodyType.DYNAMIC) {
      rigidbody.driveVelocityX = vx;
      rigidbody.driveVelocityY = vy;
      rigidbody.driveAngularVelocity = angVel;
    } else {
      rigidbody.velocityX = vx;
      rigidbody.velocityY = vy;
      rigidbody.angularVelocity = angVel;
    }
  }

  /**
   * FOLLOW controller: moves toward a named target entity at a set
   * speed, stopping when within followDistance. Useful for simple AI
   * pursuit, escort NPCs, or camera followers. The target is looked
   * up by name every frame via World.findFirstByName.
   */
  _applyFollow(entity, controller, rigidbody, dt, world) {
    if (!controller.targetName) return;
    const target = world.findFirstByName(controller.targetName);
    if (!target) return;
    const targetTransform = target.getComponent(TRANSFORM);
    if (!targetTransform) return;

    const transform = entity.getComponent(TRANSFORM);
    if (!transform) return;

    const dx = targetTransform.x - transform.x;
    const dy = targetTransform.y - transform.y;
    const dist = Math.hypot(dx, dy);

    if (dist <= controller.followDistance) {
      if (rigidbody.bodyType === BodyType.DYNAMIC) {
        rigidbody.driveVelocityX = 0;
        rigidbody.driveVelocityY = 0;
      } else {
        rigidbody.velocityX = 0;
        rigidbody.velocityY = 0;
      }
      return;
    }

    const vx = (dx / dist) * controller.followSpeed;
    const vy = (dy / dist) * controller.followSpeed;

    if (rigidbody.bodyType === BodyType.DYNAMIC) {
      rigidbody.driveVelocityX = vx;
      rigidbody.driveVelocityY = vy;
    } else {
      rigidbody.velocityX = vx;
      rigidbody.velocityY = vy;
    }
  }

  destroy() {
    this.input.destroy();
  }
}
