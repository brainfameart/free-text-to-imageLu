/**
 * runtime/systems/PhysicsSystem.js
 *
 * Very small integrator: applies gravity scale + linear drag to dynamic
 * bodies and writes the result back into Transform. This is intentionally
 * simple — swap in a real physics library later by replacing only this
 * file, since components stay plain data.
 *
 * RUNTIME-ONLY FILE.
 */

import { System } from "../core/System.js";
import { TRANSFORM } from "../components/Transform.js";
import { RIGIDBODY_2D, BodyType } from "../components/Rigidbody2D.js";

const GRAVITY = 980; // px/s^2, arbitrary "2D pixels" gravity constant

export class PhysicsSystem extends System {
  update(world, dt) {
    const entities = world.query(TRANSFORM, RIGIDBODY_2D);

    for (const entity of entities) {
      const rb = entity.getComponent(RIGIDBODY_2D);
      if (!rb.simulated || rb.bodyType !== BodyType.DYNAMIC) continue;

      const transform = entity.getComponent(TRANSFORM);

      rb.velocityY += GRAVITY * rb.gravityScale * dt;

      const dragFactor = Math.max(0, 1 - rb.linearDrag * dt);
      rb.velocityX *= dragFactor;
      rb.velocityY *= dragFactor;

      transform.x += rb.velocityX * dt;
      transform.y += rb.velocityY * dt;
    }
  }
}
