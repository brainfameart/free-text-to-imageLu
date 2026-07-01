/**
 * editor/panels/BottomPanel.js
 *
 * Project asset browser + Console tabs. The Sprites folder shows the
 * REAL imported assets from runtime/assets/AssetRegistry.js (populated
 * via Assets > Import New Asset, wired in EditorEvents.js). Each asset
 * thumbnail is a native HTML5 drag source (draggable="true") carrying
 * its spriteKey, picked up by editor/viewport/SceneViewport.js's drop
 * handler to place a real Entity + SpriteRenderer into the scene.
 * Console reads from editorState.logs (pushed to by the real engine via
 * pushLog()) instead of a static LOGS array.
 */

import { icon } from "../icons/IconLibrary.js";
import { tabBtn } from "./UIComponents.js";
import { editorState } from "../state/EditorState.js";
import { getAllSpriteAssets } from "../../runtime/assets/AssetRegistry.js";

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
    const assets = getAllSpriteAssets();
    const assetGrid = assets.length
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

    bodyHtml =
      '<div class="bottom-body">' +
      '<div class="proj-tree">' +
      '<div class="row1">' +
      icon("chevrondown", 12) +
      '<span style="margin-left:4px;display:flex;align-items:center;">' +
      icon("folder", 12) +
      '</span><span style="font-size:11px;margin-left:4px;">Assets</span></div>' +
      '<div class="rowsub">' +
      icon("folder", 12) +
      '<span style="margin-left:4px;">Scenes</span></div>' +
      '<div class="rowsub selected">' +
      icon("folder", 12) +
      '<span style="margin-left:4px;">Sprites</span></div>' +
      '<div class="rowsub">' +
      icon("folder", 12) +
      '<span style="margin-left:4px;">Scripts</span></div>' +
      "</div>" +
      '<div class="proj-assets">' +
      '<div class="proj-path"><span>Assets &gt; Sprites</span>' +
      '<label class="import-sprite-btn">' +
      icon("plus", 11) +
      " Import Sprite" +
      '<input type="file" accept="image/*" multiple data-action="import-sprite-input" style="display:none;" />' +
      "</label>" +
      "</div>" +
      '<div class="proj-grid">' +
      assetGrid +
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
