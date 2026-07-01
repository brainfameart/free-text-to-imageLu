/**
 * editor/panels/Toolbar.js
 *
 * Top menu bar + tool selection (pan/translate/rotate/scale) + play
 * controls. Editor-only.
 */

import { icon } from "../icons/IconLibrary.js";
import { editorState } from "../state/EditorState.js";

const MENUS = ["File", "Edit", "Assets", "GameObject", "Component", "Window", "Help"];

export function renderToolbar() {
  const tools = [
    { id: "pan", iconName: "hand" },
    { id: "translate", iconName: "move" },
    { id: "rotate", iconName: "refreshcw" },
    { id: "scale", iconName: "maximize2" },
  ];

  return (
    '<div class="toolbar-wrap">' +
    '<div class="menu-bar">' +
    MENUS.map((m) => '<button class="menu-btn">' + m + "</button>").join("") +
    "</div>" +
    '<div class="main-toolbar">' +
    '<div class="tool-group">' +
    tools
      .map(
        (t) =>
          '<button class="tool-btn' +
          (editorState.activeTool === t.id ? " active" : "") +
          '" data-action="set-tool" data-tool="' +
          t.id +
          '">' +
          icon(t.iconName, 13) +
          "</button>"
      )
      .join("") +
    "</div>" +
    '<div class="play-controls-wrap"><div class="play-group">' +
    '<button class="play-btn' +
    (editorState.isPlaying ? " active" : "") +
    '" data-action="toggle-play">' +
    icon("play", 13) +
    "</button>" +
    '<button class="play-btn' +
    (editorState.isPaused ? " paused" : "") +
    '" data-action="toggle-pause">' +
    icon("pause", 13) +
    "</button>" +
    '<button class="play-btn" data-action="step-frame">' +
    icon("stepforward", 13) +
    "</button>" +
    "</div></div>" +
    '<div class="toolbar-right">' +
    '<button class="pill-btn">' +
    icon("layers", 12) +
    " Layers " +
    icon("chevrondown", 10) +
    "</button>" +
    '<button class="pill-btn">Layout ' +
    icon("chevrondown", 10) +
    "</button>" +
    "</div>" +
    "</div>" +
    "</div>"
  );
}
