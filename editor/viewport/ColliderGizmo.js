/**
 * editor/viewport/ColliderGizmo.js
 *
 * Draws every entity's Collider2D shape as a red outline in the Scene
 * viewport — the same red-box/red-circle convention Unity uses — so you
 * can see exactly how big a collider is and where it sits relative to
 * the sprite, INCLUDING its offset. Editor-only chrome: this file is
 * never imported by /runtime, /player, or the play-mode popup, so the
 * outline only ever appears in the editor's Scene view, never in an
 * actual played/exported game.
 */

import { TRANSFORM } from "../../runtime/components/Transform.js";
import { COLLIDER_2D, ColliderShape } from "../../runtime/components/Collider2D.js";

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

    const color = collider.isTrigger ? TRIGGER_COLOR : COLLIDER_COLOR;
    const alpha = isSelected ? SELECTED_ALPHA : UNSELECTED_ALPHA;
    const lineWidth = isSelected ? 2.5 : 1.5;

    const g = new PIXI.Graphics();
    g.lineStyle(lineWidth, color, alpha);

    // Collider2D's offset + size/radius are in the entity's LOCAL space
    // (matches how Rapier attaches the collider to the body in
    // PhysicsWorld.js), so world position = transform position + offset,
    // scaled by the entity's Transform scale — keeps the drawn box
    // exactly matching where Rapier actually puts the physical shape.
    const worldX = transform.x + collider.offsetX * transform.scaleX;
    const worldY = transform.y + collider.offsetY * transform.scaleY;

    if (collider.shape === ColliderShape.CIRCLE) {
      const r = collider.radius * Math.max(Math.abs(transform.scaleX), Math.abs(transform.scaleY));
      g.drawCircle(worldX, worldY, r);
    } else {
      const w = collider.width * Math.abs(transform.scaleX);
      const h = collider.height * Math.abs(transform.scaleY);
      g.drawRect(worldX - w / 2, worldY - h / 2, w, h);
    }

    // small crosshair at the collider's own center so the offset from
    // the sprite's pivot is obvious at a glance, not just implied by
    // the outline's position
    g.moveTo(worldX - 5, worldY);
    g.lineTo(worldX + 5, worldY);
    g.moveTo(worldX, worldY - 5);
    g.lineTo(worldX, worldY + 5);

    container.addChild(g);

    if (isSelected) {
      const dims =
        collider.shape === ColliderShape.CIRCLE
          ? "r=" + Math.round(collider.radius)
          : Math.round(collider.width) + "x" + Math.round(collider.height);
      const label = new PIXI.Text(
        (collider.isTrigger ? "Trigger " : "Collider ") + dims,
        { fontSize: 10, fill: color, fontFamily: "monospace" }
      );
      label.x = worldX + 6;
      label.y = worldY - (collider.shape === ColliderShape.CIRCLE ? collider.radius : collider.height / 2) - 14;
      container.addChild(label);
    }
  }
}
