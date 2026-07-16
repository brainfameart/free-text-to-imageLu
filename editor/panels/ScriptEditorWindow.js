/**
 * editor/panels/ScriptEditorWindow.js
 *
 * Full-screen Monaco code editor for ZenEngine scripts. Loaded via
 * CDN on first open. Features: dark theme, tabs, auto-save, syntax
 * highlighting, line numbers, code folding, find & replace, minimap,
 * a Scripts folder sidebar (every stored script, one click to open),
 * and context-aware IntelliSense (see ScriptIntelliSense.js).
 *
 * The editor NEVER executes user code — it's a text editor only.
 * Compilation and execution happen exclusively in the play-mode popup
 * via ScriptSystem (see runtime/systems/ScriptSystem.js).
 *
 * In-editor diagnostics (red squiggles) are disabled — script errors
 * surface only in the Console tab (see BottomPanel.js). The Monaco
 * instance is disposed on close so reopening always produces a
 * fresh, working editor (content survives via cached models).
 *
 * Also includes the API Management panel: a checklist of component
 * APIs that forces them to appear in autocomplete regardless of the
 * owning object's components.
 *
 * EDITOR-ONLY FILE.
 */

import { editorState } from "../state/EditorState.js";
import { getScriptSource, saveScript, getAllScripts, renameScript } from "../scripting/ScriptStorage.js";
import { registerIntelliSense } from "../scripting/ScriptIntelliSense.js";

// Inject CSS once
(function () {
  if (document.getElementById("zengine-script-editor-css")) return;
  var style = document.createElement("style");
  style.id = "zengine-script-editor-css";
  style.textContent =
    ".script-editor-overlay{position:fixed;top:0;left:0;right:0;bottom:0;z-index:100000;background:#1e1e1e;display:flex;flex-direction:column;}" +
    ".script-editor-topbar{display:flex;align-items:center;justify-content:space-between;background:#252526;border-bottom:1px solid #3c3c3c;padding:0 4px;height:40px;flex-shrink:0;}" +
    ".se-tabs{display:flex;gap:0;overflow-x:auto;flex:1;}" +
    ".se-tab{display:flex;align-items:center;gap:4px;padding:6px 12px;background:#2d2d2d;border:1px solid #3c3c3c;border-bottom:none;border-radius:4px 4px 0 0;cursor:pointer;color:#cccccc;font-size:12px;white-space:nowrap;}" +
    ".se-tab-active{background:#1e1e1e;color:#ffffff;border-bottom:2px solid #007acc;}" +
    ".se-tab-close{background:none;border:none;color:#888;cursor:pointer;font-size:14px;line-height:1;padding:0 2px;}" +
    ".se-tab-close:hover{color:#f48771;}" +
    ".se-actions{display:flex;gap:4px;align-items:center;flex-shrink:0;padding-left:8px;}" +
    ".se-btn{padding:5px 12px;background:#3c3c3c;border:1px solid #505050;border-radius:3px;color:#cccccc;cursor:pointer;font-size:12px;}" +
    ".se-btn:hover{background:#4c4c4c;color:#fff;}" +
    ".se-btn-active{background:#0e639c;border-color:#1177bb;color:#fff;}" +
    ".se-btn-close:hover{background:#a12628;border-color:#c43131;color:#fff;}" +
    ".se-api-panel{background:#252526;border-bottom:1px solid #3c3c3c;flex-shrink:0;}" +
    ".se-api-item{display:flex;align-items:center;gap:4px;color:#cccccc;font-size:12px;cursor:pointer;padding:3px 8px;background:#333;border:1px solid #444;border-radius:3px;}" +
    ".se-api-item:hover{background:#3c3c3c;}" +
    ".se-api-item input{margin:0;cursor:pointer;}" +
    ".se-body{display:flex;flex:1;min-height:0;}" +
    ".se-sidebar{width:210px;background:#252526;border-right:1px solid #3c3c3c;overflow-y:auto;flex-shrink:0;display:flex;flex-direction:column;}" +
    ".se-sidebar-header{padding:8px 12px;font-size:11px;color:#8a93a0;text-transform:uppercase;letter-spacing:0.5px;border-bottom:1px solid #3c3c3c;position:sticky;top:0;background:#252526;z-index:1;}" +
    ".se-script-item{display:flex;align-items:center;gap:6px;padding:6px 10px;cursor:pointer;color:#cccccc;font-size:12px;border-bottom:1px solid #2d2d2d;}" +
    ".se-script-item:hover{background:#2d2d2d;}" +
    ".se-script-item.active{background:#094771;color:#fff;}" +
    ".se-script-ico{color:#dcdcaa;font-size:10px;font-weight:600;background:#37373d;border-radius:3px;padding:1px 4px;flex-shrink:0;}" +
    ".se-script-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;}" +
    ".se-script-owners{font-size:10px;color:#8a93a0;background:#333;border-radius:8px;padding:1px 6px;flex-shrink:0;}" +
    ".se-script-item.active .se-script-owners{background:#0b3a5e;color:#cce4ff;}" +
    ".se-editor-area{flex:1;overflow:hidden;min-height:0;}" +
    ".se-statusbar{background:#007acc;color:#fff;font-size:11px;padding:2px 12px;flex-shrink:0;display:flex;align-items:center;justify-content:space-between;}" +
    "@media(max-width:600px){.se-btn{padding:5px 8px;font-size:11px;}.se-tab{padding:6px 8px;font-size:11px;}.se-sidebar{width:150px;}}";
  document.head.appendChild(style);
})();

let _monaco = null;
let _monacoLoading = false;
let _monacoLoadCallbacks = [];
let _editor = null;
let _models = {}; // scriptName -> monaco.editor.ITextModel
let _saveTimer = null;
let _apiPanelOpen = false;

const MONACO_LOADER_URL = "https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.45.0/min/vs/loader.min.js";
const MONACO_BASE = "https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.45.0/min/vs";

function _ensureMonaco(callback) {
  if (_monaco) { callback(_monaco); return; }
  _monacoLoadCallbacks.push(callback);
  if (_monacoLoading) return;
  _monacoLoading = true;

  const existing = document.querySelector('script[src="' + MONACO_LOADER_URL + '"]');
  if (existing) {
    // Already loading — wait for it
    const check = setInterval(() => {
      if (window.monaco) {
        clearInterval(check);
        _monaco = window.monaco;
        _monacoLoading = false;
        _monacoLoadCallbacks.forEach(function (cb) { cb(_monaco); });
        _monacoLoadCallbacks = [];
      }
    }, 100);
    return;
  }

  const script = document.createElement("script");
  script.src = MONACO_LOADER_URL;
  script.onload = function () {
    window.require.config({ paths: { vs: MONACO_BASE } });
    window.require(["vs/editor/editor.main"], function () {
      _monaco = window.monaco;
      _monacoLoading = false;
      // Configure Monaco to suppress browser-global suggestions.
      _monaco.languages.typescript.javascriptDefaults.setCompilerOptions({
        noLib: true,
        allowNonTsExtensions: true,
      });
      // No in-editor diagnostics — script errors surface only in the
      // Console tab (see BottomPanel.js), never as red squiggles here.
      _monaco.languages.typescript.javascriptDefaults.setDiagnosticsOptions({
        noSemanticValidation: true,
        noSyntaxValidation: true,
      });
      registerIntelliSense(_monaco);
      _monacoLoadCallbacks.forEach(function (cb) { cb(_monaco); });
      _monacoLoadCallbacks = [];
    });
  };
  document.head.appendChild(script);
}

function _getModel(scriptName) {
  if (_models[scriptName]) return _models[scriptName];
  var source = getScriptSource(scriptName) || "";
  var model = _monaco.editor.createModel(source, "javascript");
  _models[scriptName] = model;
  return model;
}

function _openTab(scriptName) {
  if (!editorState.scriptEditor.openTabs.includes(scriptName)) {
    editorState.scriptEditor.openTabs.push(scriptName);
  }
  editorState.scriptEditor.activeTab = scriptName;
}

function _switchTab(scriptName) {
  editorState.scriptEditor.activeTab = scriptName;
  if (!_editor || !_monaco) return;
  var model = _getModel(scriptName);
  _editor.setModel(model);
}

function _closeTab(scriptName) {
  var idx = editorState.scriptEditor.openTabs.indexOf(scriptName);
  if (idx < 0) return;
  editorState.scriptEditor.openTabs.splice(idx, 1);
  if (_models[scriptName]) {
    _models[scriptName].dispose();
    delete _models[scriptName];
  }
  if (editorState.scriptEditor.activeTab === scriptName) {
    editorState.scriptEditor.activeTab = editorState.scriptEditor.openTabs[0] || null;
  }
}

function _scheduleSave(scriptName) {
  clearTimeout(_saveTimer);
  _saveTimer = setTimeout(function () {
    var model = _models[scriptName];
    if (!model) return;
    var source = model.getValue();
    saveScript(scriptName, source);
    // Sync back to every entity whose Script component uses this
    // script, so the scene serializes with the latest source.
    _syncSourceToEntities(scriptName, source);
  }, 500);
}

function _syncSourceToEntities(scriptName, source) {
  if (!editorState.world) return;
  var entities = editorState.world.getAllEntities();
  for (var i = 0; i < entities.length; i++) {
    var comp = entities[i].getComponent("Script");
    if (comp && comp.scriptName === scriptName) {
      comp.source = source;
    }
  }
}

// Every entity whose Script component references scriptName.
function _findScriptOwners(scriptName) {
  if (!editorState.world) return [];
  var entities = editorState.world.getAllEntities();
  var owners = [];
  for (var i = 0; i < entities.length; i++) {
    var comp = entities[i].getComponent("Script");
    if (comp && comp.scriptName === scriptName) owners.push(entities[i]);
  }
  return owners;
}

// --- Targeted DOM updates (avoid full re-render that destroys Monaco) ---

function _refreshTabsDom() {
  var tabsContainer = document.querySelector(".se-tabs");
  if (!tabsContainer) return;
  var se = editorState.scriptEditor;
  tabsContainer.innerHTML = se.openTabs.map(function (name) {
    var active = name === se.activeTab;
    return (
      '<div class="se-tab' + (active ? " se-tab-active" : "") + '" data-action="script-tab" data-script="' + name + '">' +
      "<span>" + name + "</span>" +
      '<button class="se-tab-close" data-action="script-tab-close" data-script="' + name + '" title="Close tab">&times;</button>' +
      "</div>"
    );
  }).join("");
}

function _refreshSidebarDom() {
  var sidebar = document.querySelector(".se-sidebar");
  if (!sidebar) return;
  var se = editorState.scriptEditor;
  var allScripts = getAllScripts();
  var html = '<div class="se-sidebar-header">Scripts <small style="text-transform:none;color:#6a6a6a;font-weight:normal;">(dbl-click to rename)</small></div>';
  if (allScripts.length) {
    html += allScripts.map(function (name) {
      var isActive = name === se.activeTab;
      var owners = _findScriptOwners(name);
      var ownerBadge = owners.length > 0
        ? '<span class="se-script-owners" title="Used by ' + owners.length + " object" + (owners.length > 1 ? "s" : "") + '">' + owners.length + "</span>"
        : "";
      var title = "Open " + name + (owners.length ? " (used by " + owners.length + " object" + (owners.length > 1 ? "s" : "") + ")" : " (unused)") + " — double-click to rename";
      return (
        '<div class="se-script-item' + (isActive ? " active" : "") + '" data-action="script-folder-open" data-dblclick-action="script-rename" data-script="' + name + '" title="' + title + '">' +
        '<span class="se-script-ico">JS</span>' +
        '<span class="se-script-name">' + name + "</span>" +
        ownerBadge +
        "</div>"
      );
    }).join("");
  } else {
    html += '<div style="padding:10px 12px;color:#8a93a0;font-size:12px;line-height:1.5;">No scripts yet. Attach a Script component to an object (in the Inspector) to create one.</div>';
  }
  sidebar.innerHTML = html;
}

function _refreshActiveStatesDom() {
  var active = editorState.scriptEditor.activeTab;
  var tabs = document.querySelectorAll(".se-tab");
  for (var i = 0; i < tabs.length; i++) {
    var name = tabs[i].getAttribute("data-script");
    if (name === active) tabs[i].classList.add("se-tab-active");
    else tabs[i].classList.remove("se-tab-active");
  }
  var items = document.querySelectorAll(".se-script-item");
  for (var i = 0; i < items.length; i++) {
    var name = items[i].getAttribute("data-script");
    if (name === active) items[i].classList.add("active");
    else items[i].classList.remove("active");
  }
  var status = document.getElementById("se-status-text");
  if (status) status.textContent = active || "No script open";
  if (_apiPanelOpen) _refreshApiPanelDom();
}

function _refreshApiPanelDom() {
  var panel = document.querySelector(".se-api-panel");
  if (!panel) return;
  panel.innerHTML = _renderApiPanel();
}

function _refreshApiToggleDom() {
  var existingPanel = document.querySelector(".se-api-panel");
  if (_apiPanelOpen) {
    if (!existingPanel) {
      var panelDiv = document.createElement("div");
      panelDiv.className = "se-api-panel";
      panelDiv.innerHTML = _renderApiPanel();
      var body = document.querySelector(".se-body");
      if (body) body.parentNode.insertBefore(panelDiv, body);
    }
  } else {
    if (existingPanel) existingPanel.remove();
  }
  var apiBtn = document.querySelector('[data-action="script-api-toggle"]');
  if (apiBtn) {
    if (_apiPanelOpen) apiBtn.classList.add("se-btn-active");
    else apiBtn.classList.remove("se-btn-active");
  }
}

function _renameScriptOnEntities(oldName, newName) {
  if (!editorState.world) return;
  var entities = editorState.world.getAllEntities();
  for (var i = 0; i < entities.length; i++) {
    var comp = entities[i].getComponent("Script");
    if (comp && comp.scriptName === oldName) {
      comp.scriptName = newName;
    }
  }
}

function _getActiveScriptContextEntities() {
  var se = editorState.scriptEditor;
  var ctx = se.contextByScript ? se.contextByScript[se.activeTab] : null;
  if (!ctx || !editorState.world) return [];
  var ids = ctx.entityId ? [ctx.entityId] : (ctx.entityIds || []);
  var out = [];
  for (var i = 0; i < ids.length; i++) {
    var e = editorState.world.getEntity(ids[i]);
    if (e) out.push(e);
  }
  return out;
}

// Records which object(s) drive `this.` autocomplete for this script.
// - Opened via an object (contextEntityId given): use that object.
// - Opened via the Scripts folder (null): if exactly one object owns
//   it, use that object; if several share it, use the UNION of every
//   owner's components so every property stays valid.
function _applyContext(scriptName, contextEntityId) {
  if (!editorState.scriptEditor.contextByScript) {
    editorState.scriptEditor.contextByScript = {};
  }
  if (contextEntityId) {
    editorState.scriptEditor.contextByScript[scriptName] = { entityId: contextEntityId, entityIds: null };
    return;
  }
  var owners = _findScriptOwners(scriptName);
  if (owners.length === 1) {
    editorState.scriptEditor.contextByScript[scriptName] = { entityId: owners[0].id, entityIds: null };
  } else if (owners.length >= 2) {
    editorState.scriptEditor.contextByScript[scriptName] = { entityId: null, entityIds: owners.map(function (o) { return o.id; }) };
  } else {
    editorState.scriptEditor.contextByScript[scriptName] = { entityId: null, entityIds: null };
  }
}

function _mountEditor(container) {
  _ensureMonaco(function (monaco) {
    if (!editorState.scriptEditor.activeTab) return;
    if (_editor) {
      // Editor already exists — just re-attach to the new container
      if (_editor.getDomNode().parentNode !== container) {
        container.appendChild(_editor.getDomNode());
      }
      _switchTab(editorState.scriptEditor.activeTab);
      return;
    }

    _editor = monaco.editor.create(container, {
      value: "",
      language: "javascript",
      theme: "vs-dark",
      automaticLayout: true,
      fontSize: 14,
      minimap: { enabled: true },
      scrollBeyondLastLine: false,
      folding: true,
      lineNumbers: "on",
      renderWhitespace: "selection",
      tabSize: 2,
      wordBasedSuggestions: false,
      suggestOnTriggerCharacters: true,
      parameterHints: { enabled: true },
    });

    // Auto-save on content change
    _editor.onDidChangeModelContent(function () {
      var active = editorState.scriptEditor.activeTab;
      if (active) _scheduleSave(active);
    });

    _switchTab(editorState.scriptEditor.activeTab);
  });
}

export function openScriptEditor(scriptName, source, contextEntityId) {
  if (scriptName && source !== undefined) {
    saveScript(scriptName, source);
  }
  if (scriptName) {
    _openTab(scriptName);
    _applyContext(scriptName, contextEntityId);
  }
  editorState.scriptEditor.open = true;
  if (editorState.renderFn) editorState.renderFn();
}

export function closeScriptEditor() {
  editorState.scriptEditor.open = false;
  // Dispose the Monaco instance so the next open creates a fresh,
  // working editor. Models are cached in _models, so content survives.
  if (_editor) {
    try { _editor.dispose(); } catch (e) {}
    _editor = null;
  }
  if (editorState.renderFn) editorState.renderFn();
}

export function isScriptEditorOpen() {
  return editorState.scriptEditor.open;
}

function _renderApiPanel() {
  // Use the ACTIVE SCRIPT's context entities (not the viewport selection)
  // so the checkboxes auto-adjust when switching between scripts that
  // belong to objects with different components.
  var entities = _getActiveScriptContextEntities();
  var forced = editorState.scriptEditor.forcedApis;

  var modules = [
    { name: "Transform", key: "Transform" },
    { name: "Sprite", key: "SpriteRenderer" },
    { name: "Rigidbody", key: "Rigidbody2D" },
    { name: "Movement", key: "CharacterController" },
    { name: "Collider", key: "Collider2D" },
    { name: "Camera", key: "Camera" },
    { name: "Audio", key: "AudioSource" },
    { name: "Animator", key: "SpriteAnimation" },
    { name: "Light", key: "Light" },
  ];

  var items = modules.map(function (m) {
    var has = false;
    for (var i = 0; i < entities.length; i++) {
      if (entities[i].hasComponent(m.key)) { has = true; break; }
    }
    var isForced = forced.indexOf(m.key) >= 0;
    var checked = isForced || has;
    var disabled = has ? "disabled" : "";
    return (
      '<label class="se-api-item">' +
      '<input type="checkbox" data-action="script-api-toggle-module" data-module="' + m.key + '" ' +
      (checked ? "checked" : "") + " " + disabled + " />" +
      "<span>" + m.name + "</span>" +
      (has ? ' <small style="color:#8a93a0;">(on entity)</small>' : "") +
      "</label>"
    );
  }).join("");

  return (
    '<div style="padding:8px 12px;">' +
    "<div style=\"font-size:11px;color:#8a93a0;margin-bottom:6px;text-transform:uppercase;letter-spacing:0.5px;\">Available APIs — checked modules appear in autocomplete even if the owning object doesn't have that component</div>" +
    '<div style="display:flex;flex-wrap:wrap;gap:6px;">' + items + "</div>" +
    "</div>"
  );
}

export function renderScriptEditor() {
  if (!editorState.scriptEditor.open) return "";

  var se = editorState.scriptEditor;
  var tabs = se.openTabs.map(function (name) {
    var active = name === se.activeTab;
    return (
      '<div class="se-tab' + (active ? " se-tab-active" : "") + '" data-action="script-tab" data-script="' + name + '">' +
      '<span>' + name + '</span>' +
      '<button class="se-tab-close" data-action="script-tab-close" data-script="' + name + '" title="Close tab">&times;</button>' +
      '</div>'
    );
  }).join("");

  var apiPanelHtml = _apiPanelOpen ? _renderApiPanel() : "";

  // Scripts folder sidebar — every stored script, one click to open.
  var allScripts = getAllScripts();
  var scriptListHtml = allScripts.length
    ? allScripts.map(function (name) {
        var isActive = name === se.activeTab;
        var owners = _findScriptOwners(name);
        var ownerBadge = owners.length > 0
          ? '<span class="se-script-owners" title="Used by ' + owners.length + ' object' + (owners.length > 1 ? "s" : "") + '">' + owners.length + "</span>"
          : "";
        var title = "Open " + name + (owners.length ? " (used by " + owners.length + " object" + (owners.length > 1 ? "s" : "") + ")" : " (unused)");
        return (
          '<div class="se-script-item' + (isActive ? " active" : "") + '" data-action="script-folder-open" data-dblclick-action="script-rename" data-script="' + name + '" title="' + title + '">' +
          '<span class="se-script-ico">JS</span>' +
          '<span class="se-script-name">' + name + "</span>" +
          ownerBadge +
          "</div>"
        );
      }).join("")
    : '<div style="padding:10px 12px;color:#8a93a0;font-size:12px;line-height:1.5;">No scripts yet. Attach a Script component to an object (in the Inspector) to create one.</div>';

  return (
    '<div class="script-editor-overlay" id="script-editor-overlay">' +
    '<div class="script-editor-topbar">' +
    '<div class="se-tabs">' + tabs + '</div>' +
    '<div class="se-actions">' +
    '<button class="se-btn' + (_apiPanelOpen ? " se-btn-active" : "") + '" data-action="script-api-toggle" title="API Management">API</button>' +
    '<button class="se-btn se-btn-close" data-action="script-close" title="Close editor (Esc)">&times; Close</button>' +
    '</div>' +
    '</div>' +
    (apiPanelHtml ? '<div class="se-api-panel">' + apiPanelHtml + '</div>' : '') +
    '<div class="se-body">' +
    '<div class="se-sidebar">' +
    '<div class="se-sidebar-header">Scripts <small style="text-transform:none;color:#6a6a6a;font-weight:normal;">(dbl-click to rename)</small></div>' +
    scriptListHtml +
    '</div>' +
    '<div class="se-editor-area" id="se-monaco-container"></div>' +
    '</div>' +
    '<div class="se-statusbar">' +
    '<span id="se-status-text">' + (se.activeTab || "No script open") + '</span>' +
    '<span style="float:right;color:#8a93a0;font-size:11px;">Auto-saved • Scripts run only in Play mode</span>' +
    '</div>' +
    '</div>'
  );
}

export function mountScriptEditor() {
  if (!editorState.scriptEditor.open) {
    // Editor closed — dispose the instance so the next open is fresh.
    if (_editor) {
      try { _editor.dispose(); } catch (e) {}
      _editor = null;
    }
    return;
  }
  var container = document.getElementById("se-monaco-container");
  if (!container) return;
  _mountEditor(container);
}

export function handleScriptEditorAction(action, el) {
  switch (action) {
    case "script-close":
      closeScriptEditor();
      break;
    case "script-folder-open": {
      var scriptName = el.getAttribute("data-script");
      _openTab(scriptName);
      _applyContext(scriptName, null);
      _switchTab(scriptName);
      // Targeted DOM update — no full re-render (preserves Monaco).
      _refreshTabsDom();
      _refreshSidebarDom();
      _refreshActiveStatesDom();
      break;
    }
    case "script-tab": {
      var sn = el.getAttribute("data-script");
      _switchTab(sn);
      _refreshActiveStatesDom();
      break;
    }
    case "script-tab-close": {
      var name2 = el.getAttribute("data-script");
      _closeTab(name2);
      if (editorState.scriptEditor.activeTab) {
        _switchTab(editorState.scriptEditor.activeTab);
      }
      _refreshTabsDom();
      _refreshActiveStatesDom();
      break;
    }
    case "script-rename": {
      var oldName = el.getAttribute("data-script");
      var newName = prompt("Rename script to:", oldName);
      if (!newName || !newName.trim() || newName.trim() === oldName) break;
      newName = newName.trim();
      renameScript(oldName, newName);
      if (_models[oldName]) {
        _models[newName] = _models[oldName];
        delete _models[oldName];
      }
      var tabIdx = editorState.scriptEditor.openTabs.indexOf(oldName);
      if (tabIdx >= 0) editorState.scriptEditor.openTabs[tabIdx] = newName;
      if (editorState.scriptEditor.activeTab === oldName) {
        editorState.scriptEditor.activeTab = newName;
      }
      if (editorState.scriptEditor.contextByScript && editorState.scriptEditor.contextByScript[oldName]) {
        editorState.scriptEditor.contextByScript[newName] = editorState.scriptEditor.contextByScript[oldName];
        delete editorState.scriptEditor.contextByScript[oldName];
      }
      _renameScriptOnEntities(oldName, newName);
      _refreshTabsDom();
      _refreshSidebarDom();
      _refreshActiveStatesDom();
      break;
    }
    case "script-api-toggle":
      _apiPanelOpen = !_apiPanelOpen;
      _refreshApiToggleDom();
      break;
    case "script-api-toggle-module": {
      var mod = el.getAttribute("data-module");
      var idx = editorState.scriptEditor.forcedApis.indexOf(mod);
      if (el.checked && idx < 0) {
        editorState.scriptEditor.forcedApis.push(mod);
      } else if (!el.checked && idx >= 0) {
        editorState.scriptEditor.forcedApis.splice(idx, 1);
      }
      break;
    }
  }
}
