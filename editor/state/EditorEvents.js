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
import { importSpriteFiles } from "../../runtime/assets/AssetRegistry.js";
import { syncBackgroundColorLive } from "../viewport/SceneViewport.js";

const COMPONENT_TYPE_MAP = {
  Transform: TRANSFORM,
  Camera: CAMERA,
  SpriteRenderer: SPRITE_RENDERER,
  Rigidbody2D: RIGIDBODY_2D,
  Collider2D: COLLIDER_2D,
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
    if (!t) return;
    const action = t.dataset.action;

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
      case "add-entity": {
        if (!editorState.world) break;
        const entity = editorState.world.createEntity("GameObject");
        entity.addComponent(TRANSFORM, new Transform());
        editorState.selectedId = entity.id;
        pushLog("log", "Created GameObject '" + entity.name + "'.");
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
  else if (inputEl.type === "number") value = parseFloat(inputEl.value) || 0;
  else value = inputEl.value;

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
