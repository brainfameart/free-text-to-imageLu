/**
 * editor/panels/Toolbar.js
 *
 * Top menu bar + tool selection (pan/translate/rotate/scale) + play
 * controls. Editor-only.
 *
 * The "GameObject" menu is the Unity-style entry point for spawning new
 * entities into the scene, including the 4 light types (Directional,
 * Point, Spot, Area — see runtime/components/Light.js). Clicking
 * "GameObject" opens a dropdown; hovering/clicking "Light" opens a
 * submenu listing the 4 types; clicking a type creates that light
 * centered in the current scene (see EditorEvents.js "create-light").
 */

import { icon } from "../icons/IconLibrary.js";
import { editorState } from "../state/EditorState.js";
import { LightType } from "../../runtime/components/Light.js";

const MENUS = ["File", "Edit", "Assets", "GameObject", "Component", "Window", "Help"];

const LIGHT_MENU_ITEMS = [
  { type: LightType.DIRECTIONAL, label: "Directional Light" },
  { type: LightType.POINT, label: "Point Light" },
  { type: LightType.SPOT, label: "Spot Light" },
  { type: LightType.AREA, label: "Area Light" },
  { type: LightType.GOD_RAYS, label: "God Rays" },
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
    MENUS.map((m) => renderMenu(m)).join("") +
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

function renderMenu(name) {
  const isOpen = editorState.openMenu === name;
  return (
    '<div class="menu-wrap" style="position:relative;display:inline-block;">' +
    '<button class="menu-btn' +
    (isOpen ? " active" : "") +
    '" data-action="toggle-menu" data-menu="' +
    name +
    '">' +
    name +
    "</button>" +
    (isOpen && name === "GameObject" ? renderGameObjectMenu() : "") +
    "</div>"
  );
}

function renderGameObjectMenu() {
  return (
    '<div class="dropdown-menu" style="position:absolute;top:100%;left:0;background:#2a2a2a;border:1px solid #444;' +
    'border-radius:4px;min-width:160px;z-index:100;box-shadow:0 4px 12px rgba(0,0,0,.4);padding:4px 0;">' +
    '<button class="dropdown-menu-item" data-action="add-entity" style="' +
    DROPDOWN_ITEM_STYLE +
    '">' +
    icon("box", 12) +
    "<span>Empty GameObject</span>" +
    "</button>" +
    '<div class="dropdown-submenu-wrap" style="position:relative;">' +
    '<button class="dropdown-menu-item" data-action="toggle-submenu" data-submenu="Light" style="' +
    DROPDOWN_ITEM_STYLE +
    'justify-content:space-between;">' +
    '<span style="display:flex;align-items:center;gap:6px;">' +
    icon("lightbulb", 12) +
    "<span>Light</span></span>" +
    icon("chevronright", 10) +
    "</button>" +
    (editorState.openSubmenu === "Light" ? renderLightSubmenu() : "") +
    "</div>" +
    "</div>"
  );
}

function renderLightSubmenu() {
  return (
    '<div class="dropdown-menu" style="position:absolute;top:0;left:100%;background:#2a2a2a;border:1px solid #444;' +
    'border-radius:4px;min-width:170px;z-index:101;box-shadow:0 4px 12px rgba(0,0,0,.4);padding:4px 0;">' +
    LIGHT_MENU_ITEMS.map(
      (item) =>
        '<button class="dropdown-menu-item" data-action="create-light" data-light-type="' +
        item.type +
        '" style="' +
        DROPDOWN_ITEM_STYLE +
        '">' +
        icon("lightbulb", 12) +
        "<span>" +
        item.label +
        "</span>" +
        "</button>"
    ).join("") +
    "</div>"
  );
}

const DROPDOWN_ITEM_STYLE =
  "display:flex;align-items:center;gap:6px;width:100%;text-align:left;padding:6px 12px;background:none;" +
  "border:none;color:#ddd;cursor:pointer;font-size:11px;white-space:nowrap;";
