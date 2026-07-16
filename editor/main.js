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
import { renderScriptEditor, mountScriptEditor } from "./panels/ScriptEditorWindow.js";
import { renderStatusBar, startLiveStats } from "./panels/StatusBar.js";
import { mountOrUpdateSceneViewport, getGame, detachViewportCanvas } from "./viewport/SceneViewport.js";
import { openPlayWindow, closePlayWindow, isPlayWindowOpen } from "./viewport/PlayWindow.js";
import { attachEditorEvents } from "./state/EditorEvents.js";
import { editorState, pushLog } from "./state/EditorState.js";
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
    renderTilesetEditor() +
    renderScriptEditor();

  const app = document.getElementById("app");

  // preserve focus / caret for the search input across re-render
  const active = document.activeElement;
  const wasSearchFocused = active && active.id === "hierarchy-search-input";
  const caret = wasSearchFocused ? active.selectionStart : null;
  const wasNameFocused = active && active.dataset && active.dataset.action === "rename-entity";
  const nameCaret = wasNameFocused ? active.selectionStart : null;
  const wasSceneRenameFocused = active && active.dataset && active.dataset.action === "rename-scene-input";
  const sceneRenameCaret = wasSceneRenameFocused ? active.selectionStart : null;

  // Park the live PixiJS canvas in a hidden holder BEFORE overwriting
  // the app shell. If the canvas remains inside #app when innerHTML
  // runs, PIXI's internal ResizeObserver/RAF callbacks can race with
  // the DOM removal and throw "node to be removed is no longer a child
  // of this node". Moving the canvas to a stable hidden parent OUTSIDE
  // #app prevents the conflict entirely. This is done inline here
  // (rather than only in SceneViewport.js's detachViewportCanvas) so
  // it takes effect immediately even if the browser serves a cached
  // copy of SceneViewport.js — main.js is always cache-busted via
  // import("./main.js?t=" + Date.now()).
  const _canvas = app.querySelector("canvas");
  if (_canvas) {
    let _hold = document.getElementById("_pixi-canvas-hold");
    if (!_hold) {
      _hold = document.createElement("div");
      _hold.id = "_pixi-canvas-hold";
      _hold.style.cssText =
        "position:absolute;left:-99999px;top:0;width:0;height:0;overflow:hidden;pointer-events:none;";
      document.body.appendChild(_hold);
    }
    _hold.appendChild(_canvas);
  }

  // Park the Monaco editor's DOM node in a hidden holder BEFORE
  // overwriting #app innerHTML. If the Monaco node stays inside #app
  // during the bulk innerHTML rebuild, its internal input textarea /
  // event wiring gets destroyed and the editor can no longer accept
  // typing after a tab switch, folder open, or API toggle (all of
  // which trigger renderFn). Moving the live node to a stable parent
  // outside #app keeps it intact; mountScriptEditor() re-attaches it.
  const _monacoEl = app.querySelector("#se-monaco-container .monaco-editor");
  if (_monacoEl) {
    let _mhold = document.getElementById("_monaco-node-hold");
    if (!_mhold) {
      _mhold = document.createElement("div");
      _mhold.id = "_monaco-node-hold";
      _mhold.style.cssText =
        "position:absolute;left:-99999px;top:0;width:0;height:0;overflow:hidden;pointer-events:none;";
      document.body.appendChild(_mhold);
    }
    _mhold.appendChild(_monacoEl);
  }

  // Set innerHTML with fallback: PIXI's ResizeObserver on the canvas can
  // race with the bulk innerHTML child-removal and throw "node to be
  // removed is no longer a child". If that happens, manually remove each
  // child individually (catching per-node failures) then retry.
  try {
    app.innerHTML = html;
  } catch (_domErr) {
    while (app.firstChild) {
      try { app.removeChild(app.firstChild); } catch (_) {}
    }
    app.innerHTML = html;
  }

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
  mountScriptEditor();
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
  editorState.renderFn = render;
  attachEditorEvents(render, onTogglePlay);
  // Close script editor on Escape
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && editorState.scriptEditor.open) {
      editorState.scriptEditor.open = false;
      render();
    }
  });
  // Receive error reports from the play popup — both script-lifecycle
  // errors (scriptName is a real user script) and engine/runtime errors
  // forwarded from the popup's window "error"/"unhandledrejection"
  // listeners (scriptName is the literal "(engine)" sentinel — see
  // editor/viewport/play-popup.js's _wireGlobalErrorForwarding).
  window.addEventListener("message", function (e) {
    if (e.data && e.data.type === "zengine_script_error") {
      var label = e.data.scriptName === "(engine)"
        ? "[Engine/" + e.data.method + "]"
        : "[Script] " + e.data.scriptName + "." + e.data.method + "() line " + e.data.line + ":";
      pushLog("error", label + " " + e.data.message);
      render();
    }
  });
  startLiveStats(editorState);
  render();
  setInterval(() => {
    if (editorState.isPlaying && !isPlayWindowOpen()) render();
  }, 500);
}

boot();
