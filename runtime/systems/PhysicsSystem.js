/**
 * runtime/systems/PhysicsSystem.js
 *
 * Thin System wrapper around runtime/physics/PhysicsWorld.js. ALL
 * physics integration and collision detection/resolution is handled by
 * Rapier inside PhysicsWorld — no custom AABB sweep, no hand-rolled
 * integrator lives here or anywhere else in the engine. This file's
 * only job is to fit PhysicsWorld into the System/update(world, dt)
 * lifecycle the rest of the engine uses.
 *
 * Rapier's WASM loads asynchronously, so for the first few frames after
 * a scene starts this update() is a no-op (PhysicsWorld.step() itself
 * guards on `ready` and returns immediately until loaded) — physics
 * "turns on" the moment loading finishes, with no explicit await needed
 * anywhere else in the engine.
 *
 * RUNTIME-ONLY FILE.
 */

import { System } from "../core/System.js";
import { PhysicsWorld } from "../physics/PhysicsWorld.js";

export class PhysicsSystem extends System {
  constructor() {
    super();
    this.physicsWorld = new PhysicsWorld();
  }

  update(world, dt) {
    this.physicsWorld.step(world, dt);
  }
}
