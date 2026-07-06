/**
 * editor/state/EditorEvents.js
 *
 * Single delegated click/input listener for the whole editor. Reads
 * data-action/data-field/data-axis attributes set by the panel renderers
 * and applies changes either to editorState (UI-only) or to live
 * components on editorState.world (real scene data).
 */

import { editorState, pushLog } from "./EditorState.js";
import { Transform, TRANSFORM } from "../../runtime/components/Transform.js";
import { CAMERA } from "../../runtime/components/Camera.js";
import { SPRITE_RENDERER } from "../../runtime/components/SpriteRenderer.js";
import { RIGIDBODY_2D, Rigidbody2D } from "../../runtime/components/Rigidbody2D.js";
import { COLLIDER_2D, Collider2D } from "../../runtime/components/Collider2D.js";
import { CHARACTER_CONTROLLER, CharacterController } from "../../runtime/components/CharacterController.js";
import { LIGHT, Light, LightType } from "../../runtime/components/Light.js";
import { SHADOW_CASTER, ShadowCaster } from "../../runtime/components/ShadowCaster.js";
import { LIGHTING_SETTINGS, LightingSettings } from "../../runtime/components/LightingSettings.js";
import { importSpriteFiles } from "../../runtime/assets/AssetRegistry.js";
import { syncBackgroundColorLive, switchScene } from "../viewport/SceneViewport.js";

const COMPONENT_TYPE_MAP = {
  Transform: TRANSFORM,
  Camera: CAMERA,
  SpriteRenderer: SPRITE_RENDERER,
  Rigidbody2D: RIGIDBODY_2D,
  Collider2D: COLLIDER_2D,
  CharacterController: CHARACTER_CONTROLLER,
  Light: LIGHT,
  ShadowCaster: SHADOW_CASTER,
  LightingSettings: LIGHTING_SETTINGS,
};

const LIGHT_ENTITY_NAMES = {
  [LightType.DIRECTIONAL]: "Directional Light",
  [LightType.POINT]: "Point Light",
  [LightType.SPOT]: "Spot Light",
  [LightType.AREA]: "Area Light",
  [LightType.GOD_RAYS]: "God Rays",
};

/**
 * @param {() => void} render call this to re-render the editor after a
 *   state change
 * @param {() => void} onTogglePlay called when play/pause toggles, so
 *   main.js can start/stop the GameLoop
 */
export function attachEditorEvents(render, onTogglePlay) {
  document.addEventListener("click", (e) => {
    const t = e.target.closest("[data-action]");
    if (!t) {
      // Clicked somewhere with no data-action at all: close any open
      // menu-bar dropdown (standard menu UX — clicking outside closes
      // it), same as toggle-menu on the SAME menu button does.
      if (editorState.openMenu) {
        editorState.openMenu = null;
        editorState.openSubmenu = null;
        render();
      }
      return;
    }
    const action = t.dataset.action;

    // Any click on a real action target OTHER than the menu/submenu
    // toggles themselves (or a light/entity creation, which already
    // closes the menu above) should also close a stray open dropdown —
    // e.g. clicking a tool button while GameObject menu happens to be
    // open. Handled here rather than per-case so it's automatic for
    // every current and future action.
    if (editorState.openMenu && action !== "toggle-menu" && action !== "toggle-submenu" && action !== "create-light" && action !== "add-entity") {
      editorState.openMenu = null;
      editorState.openSubmenu = null;
    }

    switch (action) {
      case "set-tool":
        editorState.activeTool = t.dataset.tool;
        render();
        break;
      case "toggle-play":
        editorState.isPlaying = !editorState.isPlaying;
        editorState.isPaused = false;
        onTogglePlay(editorState.isPlaying);
        render();
        break;
      case "toggle-pause":
        if (editorState.isPlaying) {
          editorState.isPaused = !editorState.isPaused;
          render();
        }
        break;
      case "select-entity":
        editorState.selectedId = t.dataset.id;
        render();
        break;
      case "toggle-section": {
        const k = t.dataset.key;
        editorState.sectionsOpen[k] = !(editorState.sectionsOpen[k] !== false);
        render();
        break;
      }
      case "open-anim":
        editorState.animOpen = true;
        render();
        break;
      case "close-anim":
        editorState.animOpen = false;
        render();
        break;
      case "tab-project":
        editorState.bottomTab = "project";
        render();
        break;
      case "tab-console":
        editorState.bottomTab = "console";
        render();
        break;
      case "clear-console":
        editorState.logs = [];
        render();
        break;
      case "copy-console": {
        const text = editorState.logs.map((l) => "[" + l.type.toUpperCase() + "] " + l.msg).join("\n");
        const onCopied = () => pushLog("log", "Copied " + editorState.logs.length + " console line(s) to clipboard.");
        const onFailed = (err) => pushLog("error", "Failed to copy console to clipboard: " + err.message);
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).then(onCopied, onFailed);
        } else {
          // Fallback for contexts without the async Clipboard API
          // (e.g. non-HTTPS/local file preview): a hidden textarea +
          // execCommand("copy") still works in every browser.
          try {
            const ta = document.createElement("textarea");
            ta.value = text;
            ta.style.position = "fixed";
            ta.style.opacity = "0";
            document.body.appendChild(ta);
            ta.select();
            document.execCommand("copy");
            document.body.removeChild(ta);
            onCopied();
          } catch (err) {
            onFailed(err);
          }
        }
        render();
        break;
      }
      case "add-entity": {
        if (!editorState.world) break;
        const entity = editorState.world.createEntity("GameObject");
        entity.addComponent(TRANSFORM, new Transform());
        editorState.selectedId = entity.id;
        pushLog("log", "Created GameObject '" + entity.name + "'.");
        editorState.openMenu = null;
        editorState.openSubmenu = null;
        render();
        break;
      }
      case "toggle-menu": {
        const menu = t.dataset.menu;
        editorState.openMenu = editorState.openMenu === menu ? null : menu;
        editorState.openSubmenu = null;
        render();
        break;
      }
      case "toggle-submenu": {
        const submenu = t.dataset.submenu;
        editorState.openSubmenu = editorState.openSubmenu === submenu ? null : submenu;
        render();
        break;
      }
      case "create-light": {
        if (!editorState.world) break;
        const lightType = t.dataset.lightType || LightType.POINT;
        const name = LIGHT_ENTITY_NAMES[lightType] || "Light";
        const entity = editorState.world.createEntity(name);
        entity.addComponent(TRANSFORM, new Transform());
        entity.addComponent(LIGHT, new Light({ type: lightType }));
        editorState.selectedId = entity.id;
        pushLog("log", "Created " + name + ".");
        editorState.openMenu = null;
        editorState.openSubmenu = null;
        render();
        break;
      }
      case "toggle-entity-active": {
        const entity = editorState.world && editorState.world.getEntity(editorState.selectedId);
        if (entity) entity.active = !entity.active;
        render();
        break;
      }
      case "add-component": {
        editorState.addComponentMenuOpen = !editorState.addComponentMenuOpen;
        render();
        break;
      }
      case "add-component-choice": {
        const entity = editorState.world && editorState.world.getEntity(editorState.selectedId);
        editorState.addComponentMenuOpen = false;
        if (!entity) break;

        const componentName = t.dataset.component;
        if (componentName === "Rigidbody2D") {
          if (!entity.hasComponent(RIGIDBODY_2D)) {
            entity.addComponent(RIGIDBODY_2D, new Rigidbody2D());
            pushLog("log", "Added Rigidbody2D to '" + entity.name + "'.");
          }
        } else if (componentName === "Collider2D") {
          if (!entity.hasComponent(COLLIDER_2D)) {
            entity.addComponent(COLLIDER_2D, new Collider2D());
            pushLog("log", "Added Collider2D to '" + entity.name + "'.");
          }
        } else if (componentName === "CharacterController") {
          if (!entity.hasComponent(CHARACTER_CONTROLLER)) {
            entity.addComponent(CHARACTER_CONTROLLER, new CharacterController());
            pushLog("log", "Added Movement Type (CharacterController) to '" + entity.name + "'.");
          }
        } else if (componentName === "Light") {
          if (!entity.hasComponent(LIGHT)) {
            entity.addComponent(LIGHT, new Light());
            pushLog("log", "Added Light to '" + entity.name + "'.");
          }
        } else if (componentName === "ShadowCaster") {
          if (!entity.hasComponent(SHADOW_CASTER)) {
            entity.addComponent(SHADOW_CASTER, new ShadowCaster());
            pushLog("log", "Added Shadow Caster to '" + entity.name + "'.");
          }
        } else if (componentName === "LightingSettings") {
          if (!entity.hasComponent(LIGHTING_SETTINGS)) {
            entity.addComponent(LIGHTING_SETTINGS, new LightingSettings());
            pushLog("log", "Added Lighting Settings to '" + entity.name + "'.");
          }
        }
        render();
        break;
      }
      case "remove-component": {
        const entity = editorState.world && editorState.world.getEntity(editorState.selectedId);
        if (!entity) break;
        const componentType = COMPONENT_TYPE_MAP[t.dataset.component];
        if (componentType) entity.removeComponent(componentType);
        render();
        break;
      }
      case "add-scene": {
        if (!editorState.game) break;
        const created = editorState.game.createScene();
        editorState.projectFolder = "scenes";
        switchScene(created.id);
        editorState.renamingSceneId = created.id;
        pushLog("log", "Created scene '" + created.name + "'.");
        render();
        break;
      }
      case "select-project-folder": {
        editorState.projectFolder = t.dataset.folder;
        render();
        break;
      }
      case "select-scene-file": {
        // Click switches straight to the scene (matches how every other
        // asset-browser click works — this used to only "select" the
        // item without opening it, which read as "clicking does
        // nothing"). Double-clicking the label still starts a rename
        // (see the dblclick listener below) and takes priority when it
        // fires, since renaming is the less-common action.
        editorState.selectedSceneFileId = t.dataset.sceneId;
        const sceneId = t.dataset.sceneId;
        if (sceneId && editorState.game && sceneId !== editorState.game.getActiveSceneId()) {
          switchScene(sceneId);
        }
        render();
        break;
      }
    }
  });

  document.addEventListener("dblclick", (e) => {
    const t = e.target.closest("[data-dblclick-action]");
    if (!t) return;
    const action = t.dataset.dblclickAction;
    if (action === "rename-scene-start") {
      editorState.renamingSceneId = t.dataset.sceneId;
      render();
    }
  });

  document.addEventListener("keydown", (e) => {
    if (e.target.dataset && e.target.dataset.action === "rename-scene-input") {
      if (e.key === "Enter") {
        e.target.blur(); // triggers the focusout handler below, which commits + re-renders
      } else if (e.key === "Escape") {
        editorState.renamingSceneId = null;
        render();
      }
    }
  });

  document.addEventListener("focusout", (e) => {
    if (e.target.dataset && e.target.dataset.action === "rename-scene-input") {
      const sceneId = e.target.dataset.sceneId;
      const value = e.target.dataset.pendingValue !== undefined ? e.target.dataset.pendingValue : e.target.value;
      if (editorState.game && sceneId) editorState.game.renameScene(sceneId, value);
      editorState.renamingSceneId = null;
      render();
    }
  });

  document.addEventListener("dragstart", (e) => {
    const t = e.target.closest('[data-action="drag-sprite-asset"]');
    if (!t) return;
    const key = t.dataset.spriteKey;
    if (!key) return;
    e.dataTransfer.setData("application/x-zengine-sprite-key", key);
    e.dataTransfer.effectAllowed = "copy";
  });

  document.addEventListener("input", (e) => {
    if (e.target.id === "hierarchy-search-input") {
      editorState.hierarchyFilter = e.target.value;
      render();
      return;
    }

    if (e.target.dataset.action === "rename-entity") {
      const entity = editorState.world && editorState.world.getEntity(editorState.selectedId);
      if (entity) entity.name = e.target.value;
      return; // don't re-render mid-keystroke; avoids losing caret position
    }

    if (e.target.dataset.action === "rename-scene-input") {
      // live-buffer only; committed on blur/Enter (see below) so a
      // full render() doesn't blow away the input mid-keystroke
      e.target.dataset.pendingValue = e.target.value;
      return;
    }

    const field = e.target.dataset.field;
    if (field) {
      applyFieldChange(field, e.target);
      // Color inputs: update the Scene viewport's rendered background
      // live on every drag tick, WITHOUT a full render() — render()
      // rebuilds the entire DOM tree, which would destroy/reopen the
      // native color picker popover mid-drag. A full render() still
      // happens on "change" (picker closed) to refresh the swatch's own
      // displayed value and any other UI that reflects the color.
      if (e.target.type === "color") syncBackgroundColorLive();
    }
  });

  document.addEventListener("change", (e) => {
    if (e.target.dataset.action === "import-sprite-input") {
      const files = e.target.files;
      if (files && files.length) {
        importSpriteFiles(files)
          .then((imported) => {
            for (const asset of imported) {
              pushLog("log", "Imported sprite '" + asset.name + "' (" + asset.width + "x" + asset.height + ").");
            }
            render();
          })
          .catch((err) => {
            pushLog("error", "Failed to import sprite: " + err.message);
            render();
          });
      }
      e.target.value = ""; // allow re-importing the same filename later
      return;
    }

    const field = e.target.dataset.field;
    if (field) {
      applyFieldChange(field, e.target);
      render();
    }
  });
}

/**
 * Writes a single input's value back onto the selected entity's
 * component. `field` looks like "Transform.position" (with data-axis)
 * or "SpriteRenderer.color".
 */
function applyFieldChange(field, inputEl) {
  const entity = editorState.world && editorState.world.getEntity(editorState.selectedId);
  if (!entity) return;

  const [componentName, propName] = field.split(".");
  const componentType = COMPONENT_TYPE_MAP[componentName];
  const component = componentType && entity.getComponent(componentType);
  if (!component) return;

  const axis = inputEl.dataset.axis;
  let value;
  if (inputEl.type === "checkbox") value = inputEl.checked;
  else if (inputEl.type === "number") {
    // ShadowCaster.width/height are an OPTIONAL override (null means
    // "use this object's real sprite bounds" — see components/
    // ShadowCaster.js) rather than a plain numeric field defaulting to
    // 0, so a blank input there must round-trip back to null, not 0
    // (0 would mean "zero-size occluder", a completely different and
    // surprising thing to type-blank-and-get).
    if (componentName === "ShadowCaster" && (propName === "width" || propName === "height") && inputEl.value.trim() === "") {
      value = null;
    } else {
      value = parseFloat(inputEl.value) || 0;
    }
  } else value = inputEl.value;

  if (axis && propName === "position") {
    component.x = axis === "x" ? value : component.x;
    component.y = axis === "y" ? value : component.y;
    component.z = axis === "z" ? value : component.z;
  } else if (axis && propName === "rotation") {
    if (axis === "x") component.rotation = value;
  } else if (axis && propName === "scale") {
    component.scaleX = axis === "x" ? value : component.scaleX;
    component.scaleY = axis === "y" ? value : component.scaleY;
  } else {
    component[propName] = value;
  }
}
