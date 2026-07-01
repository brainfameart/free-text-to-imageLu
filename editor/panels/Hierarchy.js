/**
 * editor/panels/Hierarchy.js
 *
 * Scene hierarchy tree. Reads entities live from editorState.world
 * (the runtime's World) instead of a static array — this is the panel
 * that was hardest-coupled to fake data in the original mockup.
 */

import { icon } from "../icons/IconLibrary.js";
import { tabBtn } from "./UIComponents.js";
import { editorState } from "../state/EditorState.js";
import { TRANSFORM } from "../../runtime/components/Transform.js";
import { CAMERA } from "../../runtime/components/Camera.js";
import { LIGHT } from "../../runtime/components/Light.js";

export function renderHierarchy() {
  const world = editorState.world;
  const allEntities = world ? world.getAllEntities() : [];
  const filtered = allEntities.filter((e) =>
    e.name.toLowerCase().includes(editorState.hierarchyFilter.toLowerCase())
  );

  return (
    '<div class="hierarchy-panel">' +
    '<div class="tabbar">' +
    tabBtn(true, "Hierarchy", "listtree") +
    "</div>" +
    '<div class="hierarchy-toolbar">' +
    '<button class="hierarchy-add-btn" data-action="add-entity">' +
    icon("plus", 12) +
    icon("chevrondown", 10) +
    "</button>" +
    '<div class="hierarchy-search">' +
    icon("search", 10) +
    '<input type="text" id="hierarchy-search-input" value="' +
    editorState.hierarchyFilter +
    '" />' +
    "</div>" +
    "</div>" +
    '<div class="hierarchy-tree">' +
    '<div class="scene-root">' +
    icon("chevrondown", 12) +
    icon("box", 12) +
    '<span style="font-size:11px;font-weight:bold;margin-left:4px;">' +
    (world ? world.sceneName : "No Scene") +
    "</span></div>" +
    filtered
      .map((e) => {
        let iconName = "box";
        if (e.hasComponent(CAMERA)) iconName = "camera";
        else if (e.hasComponent(LIGHT)) iconName = "lightbulb";
        return (
          '<div class="entity-row' +
          (editorState.selectedId === e.id ? " selected" : "") +
          '" data-action="select-entity" data-id="' +
          e.id +
          '">' +
          '<div class="entity-inner">' +
          '<span class="entity-icon">' +
          icon(iconName, 11) +
          "</span>" +
          '<span class="entity-name">' +
          e.name +
          "</span>" +
          "</div></div>"
        );
      })
      .join("") +
    "</div>" +
    "</div>"
  );
}
