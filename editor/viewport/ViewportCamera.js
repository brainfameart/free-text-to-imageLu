/**
 * editor/viewport/ViewportCamera.js
 *
 * Pan + zoom controls for the Scene viewport. Purely an editor-side
 * camera transform over the PIXI stage — does not touch game logic.
 */

import { editorState } from "../state/EditorState.js";

const MIN_ZOOM = 0.2;
const MAX_ZOOM = 5;

export class ViewportCamera {
  /**
   * @param {PIXI.Application} pixiApp
   * @param {PIXI.Container} worldContainer the container entities render into
   */
  constructor(pixiApp, worldContainer) {
    this.pixiApp = pixiApp;
    this.worldContainer = worldContainer;
    this.zoomPercent = 100;
    this._panState = { dragging: false, lastX: 0, lastY: 0 };
    this._onZoomChange = null;
  }

  /** @param {(percent:number)=>void} cb */
  onZoomChange(cb) {
    this._onZoomChange = cb;
  }

  attach(mountEl) {
    const el = this.pixiApp.view;
    el.style.touchAction = "none";

    el.addEventListener("pointerdown", (e) => {
      const isPanTool = editorState.activeTool === "pan";
      const isMiddleClick = e.button === 1;
      if (!isPanTool && !isMiddleClick) return;
      this._panState.dragging = true;
      this._panState.lastX = e.clientX;
      this._panState.lastY = e.clientY;
      try {
        el.setPointerCapture(e.pointerId);
      } catch (err) {}
      this.updateCursor();
      e.preventDefault();
    });

    el.addEventListener("pointermove", (e) => {
      if (!this._panState.dragging) return;
      const dx = e.clientX - this._panState.lastX;
      const dy = e.clientY - this._panState.lastY;
      this.worldContainer.x += dx;
      this.worldContainer.y += dy;
      this._panState.lastX = e.clientX;
      this._panState.lastY = e.clientY;
    });

    const endPan = (e) => {
      if (!this._panState.dragging) return;
      this._panState.dragging = false;
      try {
        el.releasePointerCapture(e.pointerId);
      } catch (err) {}
      this.updateCursor();
    };
    el.addEventListener("pointerup", endPan);
    el.addEventListener("pointercancel", endPan);
    el.addEventListener("pointerleave", (e) => {
      if (e.buttons === 0) endPan(e);
    });

    el.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        const rect = el.getBoundingClientRect();
        const mouseX = e.clientX - rect.left;
        const mouseY = e.clientY - rect.top;
        const direction = e.deltaY < 0 ? 1 : -1;
        const factor = 1 + direction * 0.1;
        this.zoomAt(mouseX, mouseY, factor);
      },
      { passive: false }
    );

    window.addEventListener("resize", () => {
      if (mountEl && this.pixiApp) this.pixiApp.renderer.resize(mountEl.clientWidth, mountEl.clientHeight);
    });

    this.updateZoomLabel();
    this.updateCursor();
  }

  zoomAt(screenX, screenY, factor) {
    const newScale = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, this.worldContainer.scale.x * factor));
    const actualFactor = newScale / this.worldContainer.scale.x;
    this.worldContainer.x = screenX - (screenX - this.worldContainer.x) * actualFactor;
    this.worldContainer.y = screenY - (screenY - this.worldContainer.y) * actualFactor;
    this.worldContainer.scale.set(newScale);
    this.updateZoomLabel();
  }

  updateZoomLabel() {
    this.zoomPercent = Math.round(this.worldContainer.scale.x * 100);
    if (this._onZoomChange) this._onZoomChange(this.zoomPercent);
  }

  updateCursor() {
    if (!this.pixiApp) return;
    const el = this.pixiApp.view;
    if (editorState.activeTool === "pan") {
      el.style.cursor = this._panState.dragging ? "grabbing" : "grab";
    } else {
      el.style.cursor = "default";
    }
  }
}
