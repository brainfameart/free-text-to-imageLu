/**
 * editor/panels/BottomPanel.js
 *
 * Project asset browser + Console tabs. The Sprites folder shows the
 * REAL imported assets from runtime/assets/AssetRegistry.js (populated
 * via Assets > Import New Asset, wired in EditorEvents.js). Each asset
 * thumbnail is a native HTML5 drag source (draggable="true") carrying
 * its spriteKey, picked up by editor/viewport/SceneViewport.js's drop
 * handler to place a real Entity + SpriteRenderer into the scene.
 *
 * The Scenes folder shows every scene in the project (from
 * game.getSceneList()) as a file-like item, same visual language as a
 * sprite asset: single click selects it, double-click OPENS it (loads
 * it into the live World, same as the old scene-tab switcher did), and
 * double-clicking its label starts an inline rename. This replaces the
 * old tab-strip that used to sit at the top of the Hierarchy panel —
 * scenes now live as files you open from the Project browser, same as
 * any other asset, instead of always being visible up top.
 *
 * Console reads from editorState.logs (pushed to by the real engine via
 * pushLog()) instead of a static LOGS array.
 */

import { icon } from "../icons/IconLibrary.js";
import { tabBtn } from "./UIComponents.js";
import { editorState } from "../state/EditorState.js";
import { getAllSpriteAssets } from "../../runtime/assets/AssetRegistry.js";

const FOLDER_LABELS = { scenes: "Scenes", sprites: "Sprites", scripts: "Scripts" };

export function renderBottom() {
  const errCount = editorState.logs.filter((l) => l.type === "error").length;
  const warnCount = editorState.logs.filter((l) => l.type === "warn").length;
  const infoCount = editorState.logs.filter((l) => l.type === "log").length;

  let extra = "";
  if (errCount > 0 || warnCount > 0) {
    extra =
      '<span class="tab-extra">' +
      (errCount > 0 ? '<span class="err">' + icon("alerttriangle", 10) + errCount + "</span>" : "") +
      (warnCount > 0 ? '<span class="warn">' + icon("alerttriangle", 10) + warnCount + "</span>" : "") +
      "</span>";
  }

  let bodyHtml = "";
  if (editorState.bottomTab === "project") {
    const folder = editorState.projectFolder;

    let gridHtml;
    let pathToolbarHtml;
    if (folder === "sprites") {
      const assets = getAllSpriteAssets();
      gridHtml = assets.length
        ? assets
            .map(
              (a) =>
                '<div class="asset-item" draggable="true" data-action="drag-sprite-asset" data-sprite-key="' +
                a.key +
                '" title="Drag into the scene view"><div class="asset-thumb"><img src="' +
                a.dataUrl +
                '" alt="' +
                a.name +
                '" style="width:100%;height:100%;object-fit:contain;" draggable="false" /><div class="asset-ext">IMG</div></div><span class="asset-label">' +
                a.name +
                "</span></div>"
            )
            .join("")
        : '<div class="asset-empty-hint">No sprites imported yet. Click "Import Sprite" to add one.</div>';
      pathToolbarHtml =
        '<label class="import-sprite-btn">' +
        icon("plus", 11) +
        " Import Sprite" +
        '<input type="file" accept="image/*" multiple data-action="import-sprite-input" style="display:none;" />' +
        "</label>";
    } else if (folder === "scenes") {
      gridHtml = renderSceneFileGrid();
      pathToolbarHtml =
        '<button class="import-sprite-btn" data-action="add-scene">' + icon("plus", 11) + " New Scene</button>";
    } else {
      gridHtml = '<div class="asset-empty-hint">No scripts yet.</div>';
      pathToolbarHtml = "";
    }

    bodyHtml =
      '<div class="bottom-body">' +
      '<div class="proj-tree">' +
      '<div class="row1">' +
      icon("chevrondown", 12) +
      '<span style="margin-left:4px;display:flex;align-items:center;">' +
      icon("folder", 12) +
      '</span><span style="font-size:11px;margin-left:4px;">Assets</span></div>' +
      renderFolderRow("scenes", folder) +
      renderFolderRow("sprites", folder) +
      renderFolderRow("scripts", folder) +
      "</div>" +
      '<div class="proj-assets">' +
      '<div class="proj-path"><span>Assets &gt; ' +
      FOLDER_LABELS[folder] +
      "</span>" +
      pathToolbarHtml +
      "</div>" +
      '<div class="proj-grid">' +
      gridHtml +
      "</div>" +
      "</div>" +
      "</div>";
  } else {
    bodyHtml =
      '<div class="bottom-body" style="flex-direction:column;background:#282828;overflow:hidden;">' +
      '<div class="console-toolbar">' +
      '<button class="console-clear" data-action="clear-console">Clear</button>' +
      '<button class="console-toggle">Collapse</button>' +
      '<button class="console-toggle">Clear on Play</button>' +
      '<div style="flex:1;"></div>' +
      '<div class="console-counts">' +
      "<button>" +
      icon("info", 10) +
      " " +
      infoCount +
      "</button>" +
      "<button>" +
      icon("alerttriangle", 10) +
      " " +
      warnCount +
      "</button>" +
      "<button>" +
      icon("alerttriangle", 10) +
      " " +
      errCount +
      "</button>" +
      "</div>" +
      "</div>" +
      '<div class="console-list">' +
      editorState.logs
        .map((l) => {
          const ic = l.type === "error" || l.type === "warn" ? "alerttriangle" : "info";
          return '<div class="log-row ' + l.type + '"><span class="licon">' + icon(ic, 12) + '</span><span class="lmsg">' + l.msg + "</span></div>";
        })
        .join("") +
      "</div>" +
      "</div>";
  }

  return (
    '<div class="bottom-panel">' +
    '<div class="tabbar">' +
    tabBtn(editorState.bottomTab === "project", "Project", "folder", null, "tab-project") +
    tabBtn(editorState.bottomTab === "console", "Console", "terminal", extra, "tab-console") +
    "</div>" +
    bodyHtml +
    "</div>"
  );
}

/** One row in the left-hand Assets folder tree (Scenes / Sprites / Scripts). */
function renderFolderRow(folderKey, activeFolder) {
  return (
    '<div class="rowsub' +
    (folderKey === activeFolder ? " selected" : "") +
    '" data-action="select-project-folder" data-folder="' +
    folderKey +
    '">' +
    icon("folder", 12) +
    '<span style="margin-left:4px;">' +
    FOLDER_LABELS[folderKey] +
    "</span></div>"
  );
}

/**
 * Scene files inside the Project > Scenes folder. Visually matches
 * .asset-item (same thumb/label styling as a sprite), but represents a
 * whole scene rather than an image: single click selects, double-click
 * opens (switches the live World to that scene — see
 * SceneViewport.js switchScene()), double-clicking the label starts an
 * inline rename committed on blur/Enter (see EditorEvents.js).
 */
function renderSceneFileGrid() {
  const game = editorState.game;
  const sceneList = game ? game.getSceneList() : [];
  const activeSceneId = game ? game.getActiveSceneId() : null;
  const renamingSceneId = editorState.renamingSceneId;

  if (!sceneList.length) {
    return '<div class="asset-empty-hint">No scenes yet. Click "New Scene" to add one.</div>';
  }

  return sceneList
    .map((s) => {
      const isActive = s.id === activeSceneId;
      const isRenaming = s.id === renamingSceneId;
      return (
        '<div class="asset-item scene-file-item' +
        (isActive ? " active" : "") +
        '" data-action="select-scene-file" data-scene-id="' +
        s.id +
        '" data-dblclick-action="open-scene-file" title="Double-click to open">' +
        '<div class="asset-thumb">' +
        icon("box", 22) +
        '<div class="asset-ext">SCN</div>' +
        "</div>" +
        (isRenaming
          ? '<input type="text" class="scene-file-rename-input" data-action="rename-scene-input" data-scene-id="' +
            s.id +
            '" value="' +
            s.name +
            '" />'
          : '<span class="asset-label" data-dblclick-action="rename-scene-start" data-scene-id="' +
            s.id +
            '">' +
            s.name +
            (isActive ? " (open)" : "") +
            "</span>") +
        "</div>"
      );
    })
    .join("");
}
