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
  const game = editorState.game;
  const allEntities = world ? world.getAllEntities() : [];
  const filtered = allEntities.filter((e) =>
    e.name.toLowerCase().includes(editorState.hierarchyFilter.toLowerCase())
  );

  const sceneList = game ? game.getSceneList() : [];
  const activeSceneId = game ? game.getActiveSceneId() : null;
  const renamingSceneId = editorState.renamingSceneId;

  return (
    '<div class="hierarchy-panel">' +
    '<div class="tabbar">' +
    tabBtn(true, "Hierarchy", "listtree") +
    "</div>" +
    renderSceneSwitcher(sceneList, activeSceneId, renamingSceneId) +
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

/**
 * Scene tab strip: every scene in the project is a tab. Click switches
 * to it (saving the current scene's live edits first — see
 * SceneViewport.js switchScene()); double-click starts an inline rename;
 * the + button creates a new empty scene and switches to it.
 */
function renderSceneSwitcher(sceneList, activeSceneId, renamingSceneId) {
  return (
    '<div class="scene-switcher">' +
    sceneList
      .map((s) => {
        const isActive = s.id === activeSceneId;
        const isRenaming = s.id === renamingSceneId;
        return (
          '<div class="scene-tab' +
          (isActive ? " active" : "") +
          '"' +
          (isRenaming ? "" : ' data-action="switch-scene"') +
          ' data-scene-id="' +
          s.id +
          '" data-dblclick-action="rename-scene-start">' +
          (isRenaming
            ? '<input type="text" class="scene-tab-rename-input" data-action="rename-scene-input" data-scene-id="' +
              s.id +
              '" value="' +
              s.name +
              '" />'
            : '<span class="scene-tab-name">' + s.name + "</span>") +
          "</div>"
        );
      })
      .join("") +
    '<button class="scene-tab-add" data-action="add-scene" title="New Scene">' +
    icon("plus", 12) +
    "</button>" +
    "</div>"
  );
}
