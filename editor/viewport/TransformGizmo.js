/**
 * editor/viewport/TransformGizmo.js
 *
 * Interactive translate + scale gizmo drawn around the currently
 * selected entity in the Scene viewport. Purely editor-only chrome —
 * hit-testing and dragging happen here, but the actual value writes go
 * through the entity's real Transform component (runtime data), so
 * changes are identical to typing into the Inspector fields.
 *
 * This file does not touch PIXI Application/stage creation — it's handed
 * a gizmoContainer to draw into and pointer events forwarded to it by
 * SceneViewport.js.
 */

import { TRANSFORM } from "../../runtime/components/Transform.js";
import { editorState } from "../state/EditorState.js";

const AXIS_X_COLOR = 0xe25555;
const AXIS_Y_COLOR = 0x569ce4;
const ARM_LENGTH = 70;
const HANDLE_SIZE = 9;
const HIT_PADDING = 6;

export class TransformGizmo {
  /**
   * @param {PIXI.Container} gizmoContainer editor-only chrome layer
   */
  constructor(gizmoContainer) {
    this.gizmoContainer = gizmoContainer;
    this.graphics = new PIXI.Graphics();
    this.gizmoContainer.addChild(this.graphics);

    /** @type {null | { handle: string, startWorldX:number, startWorldY:number, startTransform:object }} */
    this._drag = null;

    /** current handle hitboxes in WORLD space, recomputed every draw() */
    this._handles = [];
  }

  /**
   * @param {import('../../runtime/core/Entity.js').Entity|null} entity
   */
  draw(entity) {
    this.graphics.clear();
    this._handles = [];

    if (!entity) return;
    const transform = entity.getComponent(TRANSFORM);
    if (!transform) return;

    const tool = editorState.activeTool;
    if (tool !== "translate" && tool !== "scale") {
      this._drawSelectionBox(transform);
      return;
    }

    if (tool === "translate") this._drawTranslateGizmo(transform);
    else this._drawScaleGizmo(transform);
  }

  _drawSelectionBox(transform) {
    const g = this.graphics;
    g.lineStyle(1, 0x8fc153, 1);
    g.drawRect(transform.x - 40, transform.y - 40, 80, 80);
  }

  _drawTranslateGizmo(transform) {
    const g = this.graphics;
    const { x, y } = transform;

    g.lineStyle(2, AXIS_X_COLOR, 1);
    g.moveTo(x, y);
    g.lineTo(x + ARM_LENGTH, y);
    g.beginFill(AXIS_X_COLOR, 1);
    g.drawPolygon([x + ARM_LENGTH, y - 6, x + ARM_LENGTH, y + 6, x + ARM_LENGTH + 12, y]);
    g.endFill();
    this._handles.push({ id: "move-x", minX: x + 20, maxX: x + ARM_LENGTH + 12, minY: y - HIT_PADDING, maxY: y + HIT_PADDING });

    g.lineStyle(2, AXIS_Y_COLOR, 1);
    g.moveTo(x, y);
    g.lineTo(x, y - ARM_LENGTH);
    g.beginFill(AXIS_Y_COLOR, 1);
    g.drawPolygon([x - 6, y - ARM_LENGTH, x + 6, y - ARM_LENGTH, x, y - ARM_LENGTH - 12]);
    g.endFill();
    this._handles.push({ id: "move-y", minX: x - HIT_PADDING, maxX: x + HIT_PADDING, minY: y - ARM_LENGTH - 12, maxY: y - 20 });

    g.lineStyle(1, 0xffffff, 0.9);
    g.beginFill(0xdddddd, 1);
    g.drawRect(x - 6, y - 6, 12, 12);
    g.endFill();
    this._handles.push({ id: "move-xy", minX: x - 10, maxX: x + 10, minY: y - 10, maxY: y + 10 });

    g.lineStyle(1, 0x8fc153, 0.9);
    g.drawRect(x - 40, y - 40, 80, 80);
  }

  _drawScaleGizmo(transform) {
    const g = this.graphics;
    const { x, y } = transform;

    g.lineStyle(2, AXIS_X_COLOR, 1);
    g.moveTo(x, y);
    g.lineTo(x + ARM_LENGTH, y);
    g.lineStyle(1, AXIS_X_COLOR, 1);
    g.beginFill(AXIS_X_COLOR, 1);
    g.drawRect(x + ARM_LENGTH - 5, y - 5, 10, 10);
    g.endFill();
    this._handles.push({ id: "scale-x", minX: x + ARM_LENGTH - HANDLE_SIZE, maxX: x + ARM_LENGTH + HANDLE_SIZE, minY: y - HANDLE_SIZE, maxY: y + HANDLE_SIZE });

    g.lineStyle(2, AXIS_Y_COLOR, 1);
    g.moveTo(x, y);
    g.lineTo(x, y - ARM_LENGTH);
    g.lineStyle(1, AXIS_Y_COLOR, 1);
    g.beginFill(AXIS_Y_COLOR, 1);
    g.drawRect(x - 5, y - ARM_LENGTH - 5, 10, 10);
    g.endFill();
    this._handles.push({ id: "scale-y", minX: x - HANDLE_SIZE, maxX: x + HANDLE_SIZE, minY: y - ARM_LENGTH - HANDLE_SIZE, maxY: y - ARM_LENGTH + HANDLE_SIZE });

    g.lineStyle(1, 0xffffff, 0.9);
    g.beginFill(0xdddddd, 1);
    g.drawRect(x - 6, y - 6, 12, 12);
    g.endFill();
    this._handles.push({ id: "scale-xy", minX: x - 10, maxX: x + 10, minY: y - 10, maxY: y + 10 });

    g.lineStyle(1, 0x8fc153, 0.9);
    g.drawRect(x - 40, y - 40, 80, 80);
  }

  /**
   * Hit-tests a world-space point against the current handles.
   * @returns {string|null} handle id or null
   */
  hitTest(worldX, worldY) {
    for (const h of this._handles) {
      if (worldX >= h.minX && worldX <= h.maxX && worldY >= h.minY && worldY <= h.maxY) {
        return h.id;
      }
    }
    return null;
  }

  /**
   * @param {string} handle
   * @param {number} worldX
   * @param {number} worldY
   * @param {object} transform live Transform component to drag
   */
  beginDrag(handle, worldX, worldY, transform) {
    this._drag = {
      handle,
      startWorldX: worldX,
      startWorldY: worldY,
      startTransform: { x: transform.x, y: transform.y, scaleX: transform.scaleX, scaleY: transform.scaleY },
    };
  }

  isDragging() {
    return !!this._drag;
  }

  /**
   * @param {number} worldX
   * @param {number} worldY
   * @param {object} transform live Transform component being dragged
   */
  updateDrag(worldX, worldY, transform) {
    if (!this._drag) return;
    const dx = worldX - this._drag.startWorldX;
    const dy = worldY - this._drag.startWorldY;
    const start = this._drag.startTransform;

    switch (this._drag.handle) {
      case "move-x":
        transform.x = start.x + dx;
        break;
      case "move-y":
        transform.y = start.y + dy;
        break;
      case "move-xy":
        transform.x = start.x + dx;
        transform.y = start.y + dy;
        break;
      case "scale-x": {
        const delta = dx / ARM_LENGTH;
        transform.scaleX = Math.max(0.01, start.scaleX + delta * start.scaleX);
        break;
      }
      case "scale-y": {
        const delta = -dy / ARM_LENGTH;
        transform.scaleY = Math.max(0.01, start.scaleY + delta * start.scaleY);
        break;
      }
      case "scale-xy": {
        const delta = (dx - dy) / (ARM_LENGTH * 2);
        transform.scaleX = Math.max(0.01, start.scaleX + delta * start.scaleX);
        transform.scaleY = Math.max(0.01, start.scaleY + delta * start.scaleY);
        break;
      }
    }
  }

  endDrag() {
    this._drag = null;
  }
}
