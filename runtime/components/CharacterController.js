/**
 * runtime/components/CharacterController.js
 *
 * Plain data describing WHICH movement scheme an entity uses (Character
 * Controller / Platformer / Top-Down / Car / Follow / Free) and that
 * scheme's tunables (move speed, jump force, acceleration, etc). This
 * is the "movement type" (a.k.a. controller type) the Inspector's Add
 * Component menu offers, per the same Unity-style convention
 * Rigidbody2D/Collider2D already follow (RULES.txt section 4: plain
 * data only, no behavior).
 *
 * IMPORTANT: this component does NOT implement its own physics. All
 * actual force/velocity integration and collision detection still goes
 * through Rapier via Rigidbody2D + runtime/physics/PhysicsWorld.js —
 * see runtime/systems/ControllerSystem.js, which reads this component
 * each frame and only ever writes into Rigidbody2D's velocity fields
 * (the same fields the Inspector's Kinematic velocity sliders already
 * write to), never touching Rapier directly. An entity needs a
 * Rigidbody2D (Kinematic works best) for this component to have any
 * physical effect — CharacterController describes intent/tuning,
 * Rigidbody2D + Rapier still do the actual moving and colliding.
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
  CAR: "Car", // arcade-style car: throttle/brake + steer, moves along heading
  FOLLOW: "Follow", // AI pursuit: homes toward a named target entity at set speed
  FREE: "Free", // no built-in input mapping — script-driven only, tunables still available for scripts to read
});

export class CharacterController {
  constructor({
    controllerType = ControllerType.CHARACTER,

    // Movement (Character / Platformer / Top-Down)
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

    // Car-specific (Car controller only)
    maxSpeed = 350, // top forward speed in px/s
    carAcceleration = 200, // how fast the car speeds up (px/s^2)
    brakeForce = 400, // how fast it brakes / goes into reverse (px/s^2)
    turnSpeed = 150, // max turn rate in deg/s (at full speed; scales down at lower speeds)
    driftFactor = 0.92, // 0-1: how much lateral velocity is retained (higher = more slide)

    // Follow-specific (Follow controller only)
    targetName = "", // name of the entity to pursue
    followSpeed = 150, // pursuit speed in px/s
    followDistance = 5, // stop when within this many pixels of the target
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

    this.maxSpeed = maxSpeed;
    this.carAcceleration = carAcceleration;
    this.brakeForce = brakeForce;
    this.turnSpeed = turnSpeed;
    this.driftFactor = driftFactor;

    this.targetName = targetName;
    this.followSpeed = followSpeed;
    this.followDistance = followDistance;
  }
}
