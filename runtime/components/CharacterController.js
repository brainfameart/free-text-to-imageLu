/**
 * runtime/components/CharacterController.js
 *
 * Plain data describing WHICH movement scheme an entity uses (Character
 * Controller / Platformer / Top-Down / Free) and that scheme's tunables
 * (move speed, jump force, acceleration, etc). This is the "movement
 * type" (a.k.a. controller type) the Inspector's Add Component menu
 * offers, per the same Unity-style convention Rigidbody2D/Collider2D
 * already follow (RULES.txt section 4: plain data only, no behavior).
 *
 * IMPORTANT: this component does NOT implement its own physics. All
 * actual force/velocity integration and collision detection still goes
 * through Rapier via Rigidbody2D + runtime/physics/PhysicsWorld.js — see
 * runtime/systems/ControllerSystem.js, which reads this component each
 * frame and only ever writes into Rigidbody2D's velocity fields (the
 * same fields the Inspector's Kinematic velocity sliders already write
 * to), never touching Rapier directly. An entity needs a Rigidbody2D
 * (Kinematic works best) for this component to have any physical effect
 * — CharacterController describes intent/tuning, Rigidbody2D + Rapier
 * still do the actual moving and colliding.
 *
 * RUNTIME-ONLY FILE.
 */

export const CHARACTER_CONTROLLER = "CharacterController";

/**
 * ControllerType is presented to the user as "Movement Type" in the Add
 * Component menu and as "Controller Type" inside this component's own
 * settings (matching the user-facing names requested) — same enum,
 * different label depending on where in the UI it's shown.
 */
export const ControllerType = Object.freeze({
  CHARACTER: "Character Controller", // classic Unity-style CharacterController: 4/8-way move, optional gravity
  PLATFORMER: "Platformer", // side-scroller: horizontal move + jump, gravity always on
  TOP_DOWN: "Top-Down", // 8-directional move, no gravity, no jump
  FREE: "Free", // no built-in input mapping — script-driven only, tunables still available for scripts to read
});

export class CharacterController {
  constructor({
    controllerType = ControllerType.CHARACTER,

    // Movement
    moveSpeed = 200, // px/s
    acceleration = 20, // how fast velocity approaches target (higher = snappier)
    airControl = 0.5, // 0-1 multiplier on acceleration while airborne (Platformer only)

    // Jump (Character Controller + Platformer)
    canJump = true,
    jumpForce = 420, // px/s upward velocity applied on jump
    maxJumps = 1, // 1 = no double jump, 2 = double jump, etc.

    // Gravity (Character Controller can toggle it off for e.g. a floating
    // controller; Platformer always uses gravity; Top-Down never does)
    useGravity = true,

    // Input
    useDefaultInput = true, // WASD/Arrows (+ Space to jump) wired automatically

    // Push — how hard this kinematic body shoves DYNAMIC bodies it runs
    // into (consumed by PhysicsWorld._pushDynamicBodies). Acts as a "push
    // mass": the speed a hit body reaches along the kinematic's travel
    // direction scales with pushMass : the body's mass, so a 1:1 ratio
    // reproduces the original full-transfer push, 2 shoves twice as hard,
    // and a heavier body is pushed proportionally less. Default 1.
    pushMass = 1,
  } = {}) {
    this.controllerType = controllerType;

    this.moveSpeed = moveSpeed;
    this.acceleration = acceleration;
    this.airControl = airControl;

    this.canJump = canJump;
    this.jumpForce = jumpForce;
    this.maxJumps = maxJumps;

    this.useGravity = useGravity;

    this.useDefaultInput = useDefaultInput;

    this.pushMass = pushMass;
  }
}
