/**
 * editor/panels/Toolbar.js
 *
 * Top menu bar + tool selection (pan/translate/rotate/scale) + play
 * controls. Editor-only.
 *
 * The "GameObject" menu is the one real dropdown in the menu bar (the
 * rest stay inert labels, matching how they were before — out of scope
 * here). It offers a "Light" submenu with the 4 Unity-style light
 * types (see runtime/components/Light.js); clicking one spawns a new
 * Light entity into the currently-open scene at the world origin, same
 * pattern as the Hierarchy's "+" (Add GameObject) button — see
 * "add-light" in editor/state/EditorEvents.js.
 */

import { icon } from "../icons/IconLibrary.js";
import { editorState } from "../state/EditorState.js";
import { LightType } from "../../runtime/components/Light.js";

const MENUS = ["File", "Edit", "Assets", "GameObject", "Component", "Window", "Help"];

const LIGHT_MENU_ITEMS = [
  { type: LightType.DIRECTIONAL, label: "Directional Light", iconName: "sun" },
  { type: LightType.POINT, label: "Point Light", iconName: "lightbulb" },
  { type: LightType.SPOT, label: "Spot Light", iconName: "flashlight" },
  { type: LightType.AREA, label: "Area Light", iconName: "square" },
];

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
    MENUS.map((m) => renderMenuButton(m)).join("") +
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

function renderMenuButton(name) {
  if (name !== "GameObject") {
    // every other top menu stays an inert label, unchanged from before —
    // only GameObject > Light is in scope for this feature.
    return '<button class="menu-btn">' + name + "</button>";
  }

  const isOpen = editorState.openMenu === "GameObject";
  return (
    '<div class="menu-item-wrap">' +
    '<button class="menu-btn' +
    (isOpen ? " active" : "") +
    '" data-action="toggle-menu" data-menu="GameObject">' +
    name +
    "</button>" +
    (isOpen ? renderGameObjectDropdown() : "") +
    "</div>"
  );
}

function renderGameObjectDropdown() {
  return (
    '<div class="menu-dropdown">' +
    '<div class="menu-dropdown-item has-submenu" data-action="hover-submenu" data-submenu="Light">' +
    icon("lightbulb", 12) +
    "<span>Light</span>" +
    icon("chevronright", 10) +
    (editorState.openSubmenu === "Light" ? renderLightSubmenu() : "") +
    "</div>" +
    "</div>"
  );
}

function renderLightSubmenu() {
  return (
    '<div class="menu-dropdown menu-submenu">' +
    LIGHT_MENU_ITEMS.map(
      (item) =>
        '<div class="menu-dropdown-item" data-action="add-light" data-light-type="' +
        item.type +
        '">' +
        icon(item.iconName, 12) +
        "<span>" +
        item.label +
        "</span></div>"
    ).join("") +
    "</div>"
  );
}
