/**
 * runtime/core/CameraUtils.js
 *
 * Pure helper that resolves a Camera component's `aspectMode` down to an
 * exact pixel resolution. This is the SINGLE source of truth for "what
 * size is the exported/played screen" — the editor's camera gizmo and
 * the play-mode popup window both call this function, so the gizmo's
 * edges always exactly match what play mode (and a real export) shows.
 *
 * RUNTIME-ONLY FILE. Pure data in/out, no PIXI, no DOM.
 */

import { CameraAspectMode } from "../components/Camera.js";

/**
 * @param {import('../components/Camera.js').Camera} camera
 * @returns {{ width: number, height: number }} exact screen resolution in pixels
 */
export function getCameraResolution(camera) {
  switch (camera.aspectMode) {
    case CameraAspectMode.PORTRAIT:
      return { width: camera.portraitWidth, height: camera.portraitHeight };
    case CameraAspectMode.SQUARE:
      return { width: camera.squareSize, height: camera.squareSize };
    case CameraAspectMode.CUSTOM:
      return { width: camera.customWidth, height: camera.customHeight };
    case CameraAspectMode.LANDSCAPE:
    default:
      return { width: camera.landscapeWidth, height: camera.landscapeHeight };
  }
}

/**
 * Resolves the world-space rectangle the camera frames, centered on the
 * camera entity's Transform position. This rectangle IS the exact edge
 * of the exported/played screen — used to draw the camera gizmo in the
 * editor and to letterbox/crop the play-mode popup identically.
 *
 * @param {import('../components/Camera.js').Camera} camera
 * @param {{x:number,y:number}} transform camera entity's Transform
 * @returns {{ x: number, y: number, width: number, height: number, left: number, top: number, right: number, bottom: number }}
 */
export function getCameraWorldRect(camera, transform) {
  const { width, height } = getCameraResolution(camera);
  const x = transform ? transform.x : 0;
  const y = transform ? transform.y : 0;
  return {
    x,
    y,
    width,
    height,
    left: x - width / 2,
    top: y - height / 2,
    right: x + width / 2,
    bottom: y + height / 2,
  };
}
