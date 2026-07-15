/**
 * editor/main.js
 *
 * Editor bootstrap and root render() function. This is the editor's
 * single entry point — it imports panels, viewport, and event wiring,
 * and is the only file that assembles the full app shell.
 *
 * This file (and everything else under /editor) may import from
 * /runtime, but nothing in /runtime may ever import from /editor.
 * See /RULES.txt.
 */

import { renderToolbar } from "./panels/Toolbar.js";
import { renderHierarchy } from "./panels/Hierarchy.js";
import { renderViewport } from "./panels/Viewport.js";
import { renderInspector } from "./panels/Inspector.js";
import { renderBottom } from "./panels/BottomPanel.js";
import { renderAnimEditor } from "./panels/AnimationWindow.js";
import { renderTilesetEditor } from "./panels/TilesetPanel.js";
import { renderStatusBar, startLiveStats } from "./panels/StatusBar.js";
import { mountOrUpdateSceneViewport, getGame } from "./viewport/SceneViewport.js";
import { openPlayWindow, closePlayWindow, isPlayWindowOpen } from "./viewport/PlayWindow.js";
import { attachEditorEvents } from "./state/EditorEvents.js";
import { editorState } from "./state/EditorState.js";
import { installConsoleCapture } from "./state/ConsoleCapture.js";

// Installed first, before anything else boots, so PIXI's own boot-time
// warnings/errors and any early uncaught exceptions are captured too.
installConsoleCapture();

function render() {
  // reflect the popup being closed manually (e.g. the user clicked its
  // native close button) back onto the toolbar's Play button state
  if (editorState.isPlaying && !isPlayWindowOpen()) {
    editorState.isPlaying = false;
  }

  const html =
    '<div class="unity-window">' +
    renderToolbar() +
    '<div class="main-layout">' +
    '<div class="col-hierarchy">' + renderHierarchy() + "</div>" +
    '<div class="col-center">' +
    renderViewport() +
    '<div class="col-bottom-wrap">' + renderBottom() + "</div>" +
    "</div>" +
    '<div class="col-inspector">' + renderInspector() + "</div>" +
    "</div>" +
    renderStatusBar() +
    "</div>" +
    renderAnimEditor() +
    renderTilesetEditor();

  const app = document.getElementById("app");

  // preserve focus / caret for the search input across re-render
  const active = document.activeElement;
  const wasSearchFocused = active && active.id === "hierarchy-search-input";
  const caret = wasSearchFocused ? active.selectionStart : null;
  const wasNameFocused = active && active.dataset && active.dataset.action === "rename-entity";
  const nameCaret = wasNameFocused ? active.selectionStart : null;
  const wasSceneRenameFocused = active && active.dataset && active.dataset.action === "rename-scene-input";
  const sceneRenameCaret = wasSceneRenameFocused ? active.selectionStart : null;

  app.innerHTML = html;

  if (wasSearchFocused) {
    const el = document.getElementById("hierarchy-search-input");
    if (el) {
      el.focus();
      if (caret !== null) el.setSelectionRange(caret, caret);
    }
  }
  if (wasNameFocused) {
    const el = document.querySelector('[data-action="rename-entity"]');
    if (el) {
      el.focus();
      if (nameCaret !== null) el.setSelectionRange(nameCaret, nameCaret);
    }
  }
  const sceneRenameEl = document.querySelector('[data-action="rename-scene-input"]');
  if (sceneRenameEl) {
    sceneRenameEl.focus();
    if (wasSceneRenameFocused && sceneRenameCaret !== null) {
      sceneRenameEl.setSelectionRange(sceneRenameCaret, sceneRenameCaret);
    } else {
      sceneRenameEl.select(); // first appearance (just double-clicked, or a brand-new scene) — select all for easy overtyping
    }
  }

  mountOrUpdateSceneViewport(render);
}

function onTogglePlay(isPlaying) {
  const game = getGame();
  if (!game) return;
  if (isPlaying) {
    openPlayWindow(game);
  } else {
    closePlayWindow();
  }
}

function boot() {
  attachEditorEvents(render, onTogglePlay);
  startLiveStats(editorState);
  render();
  setInterval(() => {
    if (editorState.isPlaying && !isPlayWindowOpen()) render();
  }, 500);
}

boot();
