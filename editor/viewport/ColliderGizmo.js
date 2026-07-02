/**
 * editor/viewport/ColliderGizmo.js
 *
 * Draws every entity's Collider2D shape as a red outline in the Scene
 * viewport — the same red-box/red-circle convention Unity uses — so you
 * can see exactly how big a collider is and where it sits relative to
 * the sprite, INCLUDING its offset and Transform scale.
 *
 * Geometry is computed by runtime/physics/ColliderGeometry.js — the
 * SAME function runtime/physics/PhysicsWorld.js uses to build the real
 * Rapier collider. That is a deliberate, load-bearing choice: it's the
 * only thing that guarantees this red outline is always exactly what
 * will physically collide, not just a visual approximation of it. If
 * you ever need to change how offset/scale/size map to world space, do
 * it in ColliderGeometry.js so both stay in sync automatically.
 *
 * Editor-only chrome: this file is never imported by /runtime, /player,
 * or the play-mode popup, so the outline only ever appears in the
 * editor's Scene view, never in an actual played/exported game.
 */

import { TRANSFORM } from "../../runtime/components/Transform.js";
import { COLLIDER_2D, ColliderShape } from "../../runtime/components/Collider2D.js";
import { getColliderWorldGeometry } from "../../runtime/physics/ColliderGeometry.js";

const COLLIDER_COLOR = 0xff2d55; // Unity-style collider red
const TRIGGER_COLOR = 0x2dd4ff; // distinct color for trigger colliders (not solid)
const SELECTED_ALPHA = 1;
const UNSELECTED_ALPHA = 0.55;

/**
 * @param {PIXI.Container} container editor-only chrome layer to draw into
 * @param {import('../../runtime/core/World.js').World|null} world
 * @param {string|null} selectedId currently selected entity id, drawn brighter/thicker
 */
export function drawColliderGizmo(container, world, selectedId) {
  container.removeChildren();
  if (!world) return;

  const entities = world.query(TRANSFORM, COLLIDER_2D);

  for (const entity of entities) {
    const transform = entity.getComponent(TRANSFORM);
    const collider = entity.getComponent(COLLIDER_2D);
    const isSelected = entity.id === selectedId;
    const geo = getColliderWorldGeometry(collider, transform);

    const color = collider.isTrigger ? TRIGGER_COLOR : COLLIDER_COLOR;
    const alpha = isSelected ? SELECTED_ALPHA : UNSELECTED_ALPHA;
    const lineWidth = isSelected ? 2.5 : 1.5;

    const g = new PIXI.Graphics();
    g.lineStyle(lineWidth, color, alpha);

    if (geo.shape === ColliderShape.CIRCLE) {
      g.drawCircle(geo.centerX, geo.centerY, geo.radius);
    } else {
      g.drawRect(geo.centerX - geo.halfWidth, geo.centerY - geo.halfHeight, geo.halfWidth * 2, geo.halfHeight * 2);
    }

    // small crosshair at the collider's own center so the offset from
    // the sprite's pivot is obvious at a glance, not just implied by
    // the outline's position
    g.moveTo(geo.centerX - 5, geo.centerY);
    g.lineTo(geo.centerX + 5, geo.centerY);
    g.moveTo(geo.centerX, geo.centerY - 5);
    g.lineTo(geo.centerX, geo.centerY + 5);

    container.addChild(g);

    if (isSelected) {
      const dims =
        geo.shape === ColliderShape.CIRCLE
          ? "r=" + Math.round(geo.radius)
          : Math.round(geo.halfWidth * 2) + "x" + Math.round(geo.halfHeight * 2);
      const label = new PIXI.Text((collider.isTrigger ? "Trigger " : "Collider ") + dims, {
        fontSize: 10,
        fill: color,
        fontFamily: "monospace",
      });
      label.x = geo.centerX + 6;
      label.y = geo.centerY - (geo.shape === ColliderShape.CIRCLE ? geo.radius : geo.halfHeight) - 14;
      container.addChild(label);
    }
  }
}

