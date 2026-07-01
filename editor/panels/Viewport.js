/**
 * editor/panels/Viewport.js
 *
 * The Scene/Game tab bar + viewport toolbar (2D toggle, lighting, zoom
 * label) wrapping the canvas mount point that SceneViewport.js attaches
 * a real PIXI Application to.
 */

import { icon } from "../icons/IconLibrary.js";
import { tabBtn } from "./UIComponents.js";
import { editorState } from "../state/EditorState.js";
import { getZoomPercent } from "../viewport/SceneViewport.js";

export function renderViewport() {
  const zoomPercent = getZoomPercent();
  return (
    '<div class="col-viewport-wrap">' +
    '<div class="tabbar">' +
    tabBtn(true, "Scene", "grid") +
    tabBtn(false, "Game", "monitor") +
    "</div>" +
    '<div class="viewport-toolbar2">' +
    "<button>2D</button><div class=\"vsep\"></div>" +
    "<button>" +
    icon("lightbulb", 10) +
    "</button>" +
    "<button>" +
    icon("info", 10) +
    "</button>" +
    '<div class="vsep"></div>' +
    '<span class="zoom-label" id="zoom-label">' +
    zoomPercent +
    "%</span>" +
    '<span class="pan-hint">' +
    (editorState.activeTool === "pan" ? "Drag to pan \u2022 Scroll to zoom" : "Select the Hand tool to pan \u2022 Scroll to zoom") +
    "</span>" +
    "</div>" +
    '<div class="viewport-canvas" id="pixi-viewport-canvas"></div>' +
    "</div>"
  );
}
