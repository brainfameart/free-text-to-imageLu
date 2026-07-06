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

/** Tracks currently-held keys. One instance per ControllerSystem (per game). */
class InputState {
  constructor() {
    this.keys = new Set();
    this._onKeyDown = (e) => this.keys.add(e.code);
    this._onKeyUp = (e) => this.keys.delete(e.code);
    window.addEventListener("keydown", this._onKeyDown);
    window.addEventListener("keyup", this._onKeyUp);
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
  }

  update(world, dt) {
    const entities = world.query(TRANSFORM, CHARACTER_CONTROLLER, RIGIDBODY_2D);

    for (const entity of entities) {
      const controller = entity.getComponent(CHARACTER_CONTROLLER);
      const rigidbody = entity.getComponent(RIGIDBODY_2D);

      if (!controller.useDefaultInput || controller.controllerType === ControllerType.FREE) continue;
      // Static bodies never move — nothing to drive.
      if (rigidbody.bodyType === BodyType.STATIC) continue;

      if (rigidbody.bodyType === BodyType.DYNAMIC) {
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
    const left = this.input.isDown("ArrowLeft", "KeyA");
    const right = this.input.isDown("ArrowRight", "KeyD");
    const up = this.input.isDown("ArrowUp", "KeyW");
    const down = this.input.isDown("ArrowDown", "KeyS");
    const jumpPressed = this.input.isDown("Space");

    const moveX = (right ? 1 : 0) - (left ? 1 : 0);
    const targetX = moveX * controller.moveSpeed;

    // Smoothly approach the target horizontal speed rather than snapping.
    const lerpT = Math.min(1, controller.acceleration * dt);
    const currentX = rigidbody.velocityX; // last value PhysicsWorld read back from Rapier
    rigidbody.driveVelocityX = currentX + (targetX - currentX) * lerpT;

    if (controller.controllerType === ControllerType.TOP_DOWN) {
      // Top-Down has no gravity concept even on a Dynamic body — drive Y
      // directly too via the same transient channel, bypassing gravity.
      const moveY = (down ? 1 : 0) - (up ? 1 : 0);
      const targetY = moveY * controller.moveSpeed;
      const currentY = rigidbody.velocityY;
      rigidbody.driveVelocityY = currentY + (targetY - currentY) * lerpT;
      return;
    }

    // Character Controller / Platformer on a Dynamic body: let Rapier's
    // own gravityScale integrate falling. We only ever touch Y to apply
    // a jump impulse (a velocity kick), never to simulate gravity
    // ourselves — that would double up with Rapier's.
    const grounded = Math.abs(rigidbody.velocityY) < 20; // small epsilon: resting/near-zero vertical speed
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
    const left = this.input.isDown("ArrowLeft", "KeyA");
    const right = this.input.isDown("ArrowRight", "KeyD");
    const up = this.input.isDown("ArrowUp", "KeyW");
    const down = this.input.isDown("ArrowDown", "KeyS");
    const jumpPressed = this.input.isDown("Space");

    const moveX = (right ? 1 : 0) - (left ? 1 : 0);
    const targetX = moveX * controller.moveSpeed;

    const lerpT = Math.min(1, controller.acceleration * dt);
    rigidbody.velocityX += (targetX - rigidbody.velocityX) * lerpT;

    const usesGravity =
      controller.controllerType === ControllerType.PLATFORMER
        ? true
        : controller.controllerType === ControllerType.TOP_DOWN
        ? false
        : controller.useGravity;

    if (controller.controllerType === ControllerType.TOP_DOWN) {
      const moveY = (down ? 1 : 0) - (up ? 1 : 0);
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
    // zeroing vy the instant it's true breaks that feedback loop.
    const grounded = rigidbody.grounded;

    if (grounded) {
      vy = 0;
      const jumpsUsed = this._jumpsUsed.get(entityId) || 0;
      if (jumpsUsed > 0) this._jumpsUsed.set(entityId, 0);
    }

    if (usesGravity) {
      vy += GRAVITY_Y * dt;
    } else if (controller.controllerType === ControllerType.CHARACTER) {
      // Character Controller with gravity off: vertical is direct move
      // input too (e.g. a floating/flying controller).
      const moveY = (down ? 1 : 0) - (up ? 1 : 0);
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

  destroy() {
    this.input.destroy();
  }
}
