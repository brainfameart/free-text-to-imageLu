/**
 * editor/panels/AnimationWindow.js
 *
 * Animation editor overlay (timeline UI). Currently a UI shell only —
 * not wired to a real animation system yet. See /RULES.txt before
 * adding real animation playback logic; it should live in
 * runtime/systems/AnimationSystem.js, not here.
 */

import { icon } from "../icons/IconLibrary.js";
import { dropdownInput } from "./UIComponents.js";
import { editorState } from "../state/EditorState.js";

export function renderAnimEditor() {
  if (!editorState.animOpen) return "";

  const ticks = [];
  for (let i = 0; i < 10; i++) {
    ticks.push('<div class="tick" style="left:' + i * 10 + '%;"><span>' + i + ":00</span></div>");
  }

  return (
    '<div class="anim-overlay">' +
    '<div class="anim-backdrop" data-action="close-anim"></div>' +
    '<div class="anim-window">' +
    '<div class="anim-header"><div class="title">' +
    icon("film", 12) +
    " Animation</div><button class=\"anim-close\" data-action=\"close-anim\">" +
    icon("x", 12) +
    "</button></div>" +
    '<div class="anim-toolbar">' +
    '<div class="anim-record"><span class="rbadge">R</span>Preview</div>' +
    '<div class="vsep"></div>' +
    '<button class="ibtn">' +
    icon("stepforward", 12) +
    "</button>" +
    '<button class="ibtn">' +
    icon("play", 12) +
    "</button>" +
    '<button class="ibtn">' +
    icon("stepforward", 12) +
    "</button>" +
    '<div class="vsep"></div>' +
    '<span style="color:#ccc;">Samples</span>' +
    '<input type="number" value="12" />' +
    '<div style="flex:1;"></div>' +
    dropdownInput(["Player_Idle", "Player_Run", "Player_Jump", "Create New Clip..."]) +
    "</div>" +
    '<div class="anim-body">' +
    '<div class="anim-props">' +
    '<div class="anim-props-head"><span>Property</span></div>' +
    '<div class="anim-props-list">' +
    '<div class="anim-prop-row">' +
    icon("chevrondown", 10) +
    "<span>SpriteRenderer.Sprite</span></div>" +
    '<div class="anim-prop-row sel">' +
    icon("chevrondown", 10) +
    "<span>Transform.Position</span></div>" +
    '<div class="anim-prop-row sub"><span>Position.x</span></div>' +
    "</div>" +
    '<div class="anim-add-prop"><button>Add Property</button></div>' +
    "</div>" +
    '<div class="anim-timeline">' +
    '<div class="anim-ruler">' +
    ticks.join("") +
    "</div>" +
    '<div class="anim-keys">' +
    '<div class="anim-keyrow"><div class="anim-key" style="left:10%;"></div><div class="anim-key" style="left:30%;"></div><div class="anim-key" style="left:50%;"></div></div>' +
    '<div class="anim-keyrow"><div class="anim-key green" style="left:10%;"></div><div class="anim-key green" style="left:80%;"></div><div class="anim-keyline" style="left:10%;width:70%;"></div></div>' +
    '<div class="anim-keyrow"></div>' +
    '<div class="anim-playhead"></div>' +
    "</div>" +
    "</div>" +
    "</div>" +
    "</div>" +
    "</div>"
  );
}
