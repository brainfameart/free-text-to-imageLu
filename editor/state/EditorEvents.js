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
import { COLLIDER_2D, Collider2D, ColliderShape } from "../../runtime/components/Collider2D.js";
import { CHARACTER_CONTROLLER, CharacterController } from "../../runtime/components/CharacterController.js";
import { LIGHT, Light, LightType } from "../../runtime/components/Light.js";
import { SHADOW_CASTER, ShadowCaster } from "../../runtime/components/ShadowCaster.js";
import { LIGHTING_SETTINGS, LightingSettings } from "../../runtime/components/LightingSettings.js";
import { SPRITE_ANIMATION, SpriteAnimation } from "../../runtime/components/SpriteAnimation.js";
import { AUDIO_SOURCE, AudioSource } from "../../runtime/components/AudioSource.js";
import { createEmptyClip } from "../panels/AnimationWindow.js";
import {
  importStandaloneImageFrames,
  importZipImageFrames,
  importSpriteSheetFrames,
} from "../animation/AnimationImport.js";
import { importSpriteFiles, getSpriteAsset, importAudioFiles } from "../../runtime/assets/AssetRegistry.js";
import { syncBackgroundColorLive, switchScene } from "../viewport/SceneViewport.js";
import { serializeEntity, instantiateEntity } from "../../runtime/scene/SceneSerializer.js";

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
  SpriteAnimation: SPRITE_ANIMATION,
  AudioSource: AUDIO_SOURCE,
};

const LIGHT_ENTITY_NAMES = {
  [LightType.DIRECTIONAL]: "Directional Light",
  [LightType.POINT]: "Point Light",
  [LightType.SPOT]: "Spot Light",
  [LightType.AREA]: "Area Light",
  [LightType.GOD_RAYS]: "God Rays",
  [LightType.FREEFORM]: "Freeform Light",
};

// Freeform's `radius` field doubles as its edge FEATHER width (see
// LightTextureShaderSource.js's freeformFalloff), not a reach distance
// like every other light type — Light's own constructor default (200)
// is tuned for Point/Spot/GodRays reach and is far larger than
// DEFAULT_FREEFORM_POINTS' ~80px shape, which would feather the entire
// interior down to near-zero brightness instead of a crisp shape with
// a soft edge. Used only when creating/switching TO Freeform.
const FREEFORM_DEFAULT_FEATHER = 16;

/**
 * Builds sensible starting field overrides for a BRAND NEW Collider2D so
 * it roughly matches the entity's own sprite size instead of always
 * being Collider2D's raw default (width=1, height=1, radius=0.5,
 * trianglePoints ±0.5 — all sized for Rapier's ~1-unit "human scale"
 * assumption, see PhysicsWorld.js's LENGTH_UNIT_PX_PER_METER comment).
 * Since this engine treats collider width/height/radius as PIXELS
 * directly (that constant is just Rapier's internal solver rescaling,
 * it isn't a units-per-pixel conversion the user ever sees), a fresh
 * 1px collider next to a 64-256px sprite is invisible in both the
 * Scene view gizmo and the Animation panel's preview overlay — this is
 * what produces a collider outline too small to see ("can't even see
 * the dots" when set to Triangle, since ±0.5 points are ~1px wide).
 *
 * Reads the entity's SpriteRenderer.spriteKey (if any) to find its
 * actual pixel size via the asset registry, and returns override fields
 * sized to roughly fill that sprite — same "fit the frame" spirit as
 * the Animation panel's preview-stage scaling, just applied once at
 * creation time instead of every render. Returns {} (no overrides,
 * falls back to Collider2D's own defaults) if the entity has no sprite
 * yet, since there's nothing to size against.
 */
function _sizedColliderDefaults(entity) {
  const renderer = entity.getComponent(SPRITE_RENDERER);
  if (!renderer || !renderer.spriteKey) return {};
  const asset = getSpriteAsset(renderer.spriteKey);
  if (!asset || !asset.width || !asset.height) return {};

  const w = asset.width;
  const h = asset.height;
  const shortSide = Math.min(w, h);

  return {
    width: w,
    height: h,
    radius: shortSide / 2,
    capsuleRadius: shortSide / 4,
    capsuleHalfHeight: Math.max(1, h / 2 - shortSide / 4),
    trianglePoints: [
      { x: -w / 2, y: h / 2 },
      { x: w / 2, y: h / 2 },
      { x: 0, y: -h / 2 },
    ],
  };
}

/**
 * @param {() => void} render call this to re-render the editor after a
 *   state change
 * @param {() => void} onTogglePlay called when play/pause toggles, so
 *   main.js can start/stop the GameLoop
 */
export function attachEditorEvents(render, onTogglePlay) {
let _lastSceneClick = { id: null, time: 0 };
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
      case "select-entity": {
        const id = t.dataset.id;
        if (e.shiftKey) {
          // Shift+click toggles membership for multi-select.
          const idx = editorState.selectedIds.indexOf(id);
          if (idx >= 0) editorState.selectedIds.splice(idx, 1);
          else editorState.selectedIds.push(id);
          editorState.selectedId = editorState.selectedIds.length
            ? editorState.selectedIds[editorState.selectedIds.length - 1]
            : null;
        } else {
          editorState.selectedId = id;
          editorState.selectedIds = [id];
        }
        render();
        break;
      }
      case "toggle-section": {
        const k = t.dataset.key;
        editorState.sectionsOpen[k] = !(editorState.sectionsOpen[k] !== false);
        render();
        break;
      }
      case "open-anim":
        editorState.animOpen = true;
        // Reset panel-local UI state (not the actual clip DATA, which
        // lives on the component) so re-opening the panel — possibly
        // for a DIFFERENT entity than last time — doesn't show a stale
        // "editing clip" id or preview frame from a previous session.
        editorState.anim.editingClipId = null;
        editorState.anim.previewFrameIndex = 0;
        editorState.anim.previewPlaying = false;
        editorState.anim.renamingClipId = null;
        render();
        break;
      case "close-anim":
        editorState.animOpen = false;
        editorState.anim.previewPlaying = false;
        render();
        break;
      case "anim-new-clip": {
        const entity = editorState.world && editorState.world.getEntity(editorState.selectedId);
        if (!entity) break;
        let anim = entity.getComponent(SPRITE_ANIMATION);
        if (!anim) {
          anim = new SpriteAnimation();
          entity.addComponent(SPRITE_ANIMATION, anim);
        }
        const clip = createEmptyClip(anim.clips.map((c) => c.name));
        anim.clips.push(clip);
        if (!anim.currentClipId) anim.currentClipId = clip.id;
        editorState.anim.editingClipId = clip.id;
        editorState.anim.previewFrameIndex = 0;
        editorState.anim.previewPlaying = false;
        pushLog("log", "Created animation clip '" + clip.name + "' on '" + entity.name + "'.");
        render();
        break;
      }
      case "anim-rename-clip": {
        editorState.anim.renamingClipId = t.dataset.clipId;
        render();
        break;
      }
      case "anim-toggle-show-collider": {
        editorState.anim.showColliderInPreview = !editorState.anim.showColliderInPreview;
        render();
        break;
      }
      case "anim-delete-clip": {
        const entity = editorState.world && editorState.world.getEntity(editorState.selectedId);
        const anim = entity && entity.getComponent(SPRITE_ANIMATION);
        if (!anim) break;
        const clipId = t.dataset.clipId;
        const clip = anim.clips.find((c) => c.id === clipId);
        anim.clips = anim.clips.filter((c) => c.id !== clipId);
        if (anim.currentClipId === clipId) {
          anim.currentClipId = anim.clips.length ? anim.clips[0].id : null;
          anim.currentFrameIndex = 0;
          anim.frameElapsed = 0;
        }
        if (editorState.anim.editingClipId === clipId) {
          editorState.anim.editingClipId = null; // re-picked to the new first clip on next render
          editorState.anim.previewFrameIndex = 0;
        }
        if (clip) pushLog("log", "Deleted animation clip '" + clip.name + "'.");
        render();
        break;
      }
      case "anim-preview-step": {
        const entity = editorState.world && editorState.world.getEntity(editorState.selectedId);
        const anim = entity && entity.getComponent(SPRITE_ANIMATION);
        const clip = anim && anim.clips.find((c) => c.id === editorState.anim.editingClipId);
        if (!clip || clip.frames.length === 0) break;
        const dir = parseInt(t.dataset.dir, 10) || 1;
        editorState.anim.previewFrameIndex =
          (editorState.anim.previewFrameIndex + dir + clip.frames.length) % clip.frames.length;
        render();
        break;
      }
      case "anim-preview-toggle-play": {
        editorState.anim.previewPlaying = !editorState.anim.previewPlaying;
        render();
        break;
      }
      case "anim-toggle-loop": {
        const entity = editorState.world && editorState.world.getEntity(editorState.selectedId);
        const anim = entity && entity.getComponent(SPRITE_ANIMATION);
        const clip = anim && anim.clips.find((c) => c.id === editorState.anim.editingClipId);
        if (clip) clip.loop = t.checked;
        render();
        break;
      }
      case "anim-toggle-collider-override": {
        const entity = editorState.world && editorState.world.getEntity(editorState.selectedId);
        const anim = entity && entity.getComponent(SPRITE_ANIMATION);
        const clip = anim && anim.clips.find((c) => c.id === editorState.anim.editingClipId);
        if (!clip) break;
        if (t.checked) {
          // Seed from the entity's OWN current Collider2D (if any) so
          // the toggle starts from something visible/sensible, same
          // reasoning as the Inspector's identical toggle in the
          // "toggle-clip-collider-override" case above — kept as two
          // separate cases (rather than merged) because this one reads
          // editorState.anim.editingClipId (the panel's own concept of
          // "which clip is open") while the Inspector's reads a
          // data-clip-id straight off the clicked element; unifying
          // them would require threading one convention into the
          // other's caller for no real benefit.
          const collider = entity.getComponent(COLLIDER_2D);
          const seed = collider ? new Collider2D({ ...collider }) : new Collider2D(_sizedColliderDefaults(entity));
          clip.colliderOverride = { ...seed };
        } else {
          clip.colliderOverride = null;
        }
        render();
        break;
      }
      case "anim-delete-frame": {
        const entity = editorState.world && editorState.world.getEntity(editorState.selectedId);
        const anim = entity && entity.getComponent(SPRITE_ANIMATION);
        const clip = anim && anim.clips.find((c) => c.id === editorState.anim.editingClipId);
        if (!clip) break;
        const idx = parseInt(t.dataset.frameIndex, 10);
        clip.frames.splice(idx, 1);
        if (editorState.anim.previewFrameIndex >= clip.frames.length) {
          editorState.anim.previewFrameIndex = Math.max(0, clip.frames.length - 1);
        }
        render();
        break;
      }
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
        editorState.selectedIds = [entity.id];
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
        entity.addComponent(
          LIGHT,
          new Light(
            lightType === LightType.FREEFORM ? { type: lightType, radius: FREEFORM_DEFAULT_FEATHER } : { type: lightType }
          )
        );
        editorState.selectedId = entity.id;
        editorState.selectedIds = [entity.id];
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
            entity.addComponent(COLLIDER_2D, new Collider2D(_sizedColliderDefaults(entity)));
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
        } else if (componentName === "SpriteAnimation") {
          if (!entity.hasComponent(SPRITE_ANIMATION)) {
            entity.addComponent(SPRITE_ANIMATION, new SpriteAnimation());
            pushLog("log", "Added Sprite Animation to '" + entity.name + "'.");
          }
        } else if (componentName === "AudioSource") {
          if (!entity.hasComponent(AUDIO_SOURCE)) {
            entity.addComponent(AUDIO_SOURCE, new AudioSource());
            pushLog("log", "Added Audio Source to '" + entity.name + "'.");
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
      case "toggle-clip-collider-override": {
        const entity = editorState.world && editorState.world.getEntity(editorState.selectedId);
        if (!entity) break;
        const anim = entity.getComponent(SPRITE_ANIMATION);
        const clip = anim && anim.clips.find((c) => c.id === t.dataset.clipId);
        if (!clip) break;
        if (t.checked) {
          // Seed the override from the entity's OWN current Collider2D
          // (if any) so turning the toggle on starts from something
          // sensible/visible rather than a jarring default — falls back
          // to a plain Box if the entity has no Collider2D at all yet.
          const collider = entity.getComponent(COLLIDER_2D);
          const seed = collider ? new Collider2D({ ...collider }) : new Collider2D(_sizedColliderDefaults(entity));
          clip.colliderOverride = { ...seed };
        } else {
          clip.colliderOverride = null;
        }
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
        // Manual double-click detection: the native dblclick event
        // doesn't survive the full DOM rebuild (app.innerHTML = html)
        // that happens on the first click's render() — the recreated
        // element is a different DOM node, so the browser never fires
        // dblclick. Tracking timestamp + sceneId ourselves works
        // regardless of DOM replacement, and is more reliable on
        // laptop touchpads where the OS double-click threshold may
        // differ from the browser's.
        const sceneId = t.dataset.sceneId;
        const now = Date.now();
        if (_lastSceneClick.id === sceneId && now - _lastSceneClick.time < 500) {
          // Double-click: start rename (takes priority over switching)
          editorState.renamingSceneId = sceneId;
          _lastSceneClick = { id: null, time: 0 };
          render();
          break;
        }
        _lastSceneClick = { id: sceneId, time: now };
        editorState.selectedSceneFileId = sceneId;
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

  // --- Multi-select + clipboard for Delete / Copy / Paste / Duplicate ---
  // _clipboard holds serialized entity data (SceneSerializer.serializeEntity)
  // between a Copy and a Paste. Kept in this closure (not editorState)
  // because it is not UI state that needs to trigger a re-render.
  let _clipboard = [];

  function _liveSelectionIds() {
    if (!editorState.world) return [];
    const ids = editorState.selectedIds.filter((id) => editorState.world.getEntity(id));
    return ids.length ? ids : (editorState.selectedId ? [editorState.selectedId] : []);
  }

  function _setSelection(ids) {
    editorState.selectedIds = ids.slice();
    editorState.selectedId = ids.length ? ids[ids.length - 1] : null;
  }

  function _deleteSelection() {
    const ids = _liveSelectionIds();
    if (!ids.length) return;
    for (const id of ids) editorState.world.destroyEntity(id);
    pushLog("log", "Deleted " + ids.length + " object" + (ids.length > 1 ? "s" : "") + ".");
    _setSelection([]);
  }

  function _copySelection() {
    const ids = _liveSelectionIds();
    _clipboard = ids
      .map((id) => {
        const ent = editorState.world.getEntity(id);
        return ent ? serializeEntity(ent) : null;
      })
      .filter(Boolean);
    if (_clipboard.length) pushLog("log", "Copied " + _clipboard.length + " object" + (_clipboard.length > 1 ? "s" : "") + ".");
  }

  function _pasteSelection() {
    if (!_clipboard.length || !editorState.world) return;
    const OFFSET = 24;
    const newIds = [];
    for (const data of _clipboard) {
      const ent = instantiateEntity(editorState.world, data, data.name + " (Copy)");
      const t = ent.getComponent(TRANSFORM);
      if (t) { t.x += OFFSET; t.y += OFFSET; }
      newIds.push(ent.id);
    }
    pushLog("log", "Pasted " + newIds.length + " object" + (newIds.length > 1 ? "s" : "") + ".");
    _setSelection(newIds);
  }

  document.addEventListener("keydown", (e) => {
    if (e.target.dataset && e.target.dataset.action === "rename-scene-input") {
      if (e.key === "Enter") {
        e.target.blur(); // triggers the focusout handler below, which commits + re-renders
      } else if (e.key === "Escape") {
        editorState.renamingSceneId = null;
        render();
      }
    }
    if (e.target.dataset && e.target.dataset.action === "anim-rename-clip-input") {
      if (e.key === "Enter") {
        e.target.blur(); // triggers the focusout handler below, which commits + re-renders
      } else if (e.key === "Escape") {
        editorState.anim.renamingClipId = null;
        render();
      }
    }

    // Selection keyboard shortcuts — Delete/Backspace, Copy (Ctrl/Cmd+C),
    // Paste (Ctrl/Cmd+V), Duplicate (Ctrl/Cmd+D). Skipped while typing in a
    // field so Backspace and Ctrl+C keep their normal text-editing meaning.
    const _typing = /^(input|textarea)$/i.test(e.target.tagName) || e.target.isContentEditable;
    if (_typing || !editorState.world) return;
    if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault(); // stop Backspace navigating back / Delete scrolling
      if (_liveSelectionIds().length === 0) return;
      _deleteSelection();
      render();
      return;
    }
    if (e.ctrlKey || e.metaKey) {
      const k = e.key.toLowerCase();
      if (k === "c") { e.preventDefault(); _copySelection(); return; }
      if (k === "v") { e.preventDefault(); _pasteSelection(); render(); return; }
      if (k === "d") { e.preventDefault(); _copySelection(); _pasteSelection(); render(); return; }
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
    if (e.target.dataset && e.target.dataset.action === "anim-rename-clip-input") {
      const clipId = e.target.dataset.clipId;
      const value = e.target.dataset.pendingValue !== undefined ? e.target.dataset.pendingValue : e.target.value;
      const entity = editorState.world && editorState.world.getEntity(editorState.selectedId);
      const anim = entity && entity.getComponent(SPRITE_ANIMATION);
      const clip = anim && anim.clips.find((c) => c.id === clipId);
      if (clip && value.trim()) clip.name = value.trim();
      editorState.anim.renamingClipId = null;
      render();
    }
  });

  document.addEventListener("dragstart", (e) => {
    const spriteAssetTarget = e.target.closest('[data-action="drag-sprite-asset"]');
    if (spriteAssetTarget) {
      const key = spriteAssetTarget.dataset.spriteKey;
      if (!key) return;
      e.dataTransfer.setData("application/x-zengine-sprite-key", key);
      e.dataTransfer.effectAllowed = "copy";
      return;
    }

    const audioAssetTarget = e.target.closest('[data-action="drag-audio-asset"]');
    if (audioAssetTarget) {
      const key = audioAssetTarget.dataset.audioKey;
      if (!key) return;
      e.dataTransfer.setData("application/x-zengine-audio-key", key);
      e.dataTransfer.effectAllowed = "copy";
      return;
    }

    const frameTarget = e.target.closest('[data-action="anim-frame-thumb"]');
    if (frameTarget) {
      const index = parseInt(frameTarget.dataset.frameIndex, 10);
      editorState.anim.draggingFrameIndex = index;
      e.dataTransfer.effectAllowed = "move";
      // Firefox requires setData to be called for drag to actually
      // start at all — the value itself isn't read on drop (the
      // reorder reads editorState.anim.draggingFrameIndex instead,
      // since that survives across the render() a full HTML rebuild
      // would otherwise lose track of).
      e.dataTransfer.setData("text/plain", String(index));
    }
  });

  document.addEventListener("dragover", (e) => {
    if (e.target.closest('[data-action="anim-frame-thumb"]')) {
      e.preventDefault(); // required for drop to fire on this target at all
      e.dataTransfer.dropEffect = "move";
    }
  });

  document.addEventListener("drop", (e) => {
    const target = e.target.closest('[data-action="anim-frame-thumb"]');
    if (!target) return;
    e.preventDefault();
    const from = editorState.anim.draggingFrameIndex;
    const to = parseInt(target.dataset.frameIndex, 10);
    editorState.anim.draggingFrameIndex = null;
    if (from === null || from === undefined || from === to) {
      render();
      return;
    }
    const entity = editorState.world && editorState.world.getEntity(editorState.selectedId);
    const anim = entity && entity.getComponent(SPRITE_ANIMATION);
    const clip = anim && anim.clips.find((c) => c.id === editorState.anim.editingClipId);
    if (clip) {
      const [moved] = clip.frames.splice(from, 1);
      clip.frames.splice(to, 0, moved);
    }
    render();
  });

  document.addEventListener("dragend", (e) => {
    if (e.target.closest('[data-action="anim-frame-thumb"]') && editorState.anim.draggingFrameIndex !== null) {
      // Drop landed somewhere that wasn't a valid frame-thumb target
      // (e.g. released outside the grid entirely) — clear the
      // in-progress drag state so the panel doesn't get stuck showing
      // a stale "dragging" highlight on the next render.
      editorState.anim.draggingFrameIndex = null;
      render();
    }
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

    if (e.target.dataset.action === "anim-rename-clip-input") {
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

    if (e.target.dataset.action === "import-audio-input") {
      const files = e.target.files;
      if (files && files.length) {
        importAudioFiles(files)
          .then((imported) => {
            for (const asset of imported) {
              pushLog("log", "Imported audio '" + asset.name + "'.");
            }
            render();
          })
          .catch((err) => {
            pushLog("error", "Failed to import audio: " + err.message);
            render();
          });
      }
      e.target.value = "";
      return;
    }

    if (e.target.dataset.action === "anim-import-images" || e.target.dataset.action === "anim-import-zip") {
      const files = e.target.files;
      const isZip = e.target.dataset.action === "anim-import-zip";
      const entity = editorState.world && editorState.world.getEntity(editorState.selectedId);
      const anim = entity && entity.getComponent(SPRITE_ANIMATION);
      const clip = anim && anim.clips.find((c) => c.id === editorState.anim.editingClipId);
      if (files && files.length && clip) {
        const importPromise = isZip ? importZipImageFrames(files[0]) : importStandaloneImageFrames(files);
        importPromise
          .then((frames) => {
            clip.frames.push(...frames);
            pushLog("log", "Added " + frames.length + " frame(s) to '" + clip.name + "'.");
            render();
          })
          .catch((err) => {
            pushLog("error", "Failed to import animation frames: " + err.message);
            render();
          });
      }
      e.target.value = "";
      return;
    }

    if (e.target.dataset.action === "anim-import-sheet") {
      const file = e.target.files && e.target.files[0];
      const entity = editorState.world && editorState.world.getEntity(editorState.selectedId);
      const anim = entity && entity.getComponent(SPRITE_ANIMATION);
      const clip = anim && anim.clips.find((c) => c.id === editorState.anim.editingClipId);
      if (file && clip) {
        // Auto-detect first (see AnimationImport.js's _autoDetectSpriteRects
        // doc) — the manual-grid override path is offered separately via
        // the "Slice with custom grid…" prompt below rather than asked
        // for up front every time, since auto-detect correctly handles
        // the common padded-sheet case with zero extra input from the
        // user, matching the "auto-detect as default, manual grid as
        // override" behavior this feature was specifically built for.
        importSpriteSheetFrames(file)
          .then((frames) => {
            if (frames.length <= 1) {
              // Auto-detect found only a single region — almost
              // certainly means the sheet has no transparent gutters
              // for it to detect against, so offer the manual grid
              // override immediately rather than silently importing
              // what's very likely a wrong single-frame result.
              const cols = parseInt(window.prompt("Auto-detect found only 1 frame. Enter number of COLUMNS for a manual grid slice (Cancel to keep 1 frame):", "4") || "", 10);
              if (cols) {
                const rowsInput = window.prompt("Number of ROWS:", "1");
                const rows = parseInt(rowsInput || "1", 10) || 1;
                importSpriteSheetFrames(file, { cols, rows })
                  .then((gridFrames) => {
                    clip.frames.push(...gridFrames);
                    pushLog("log", "Sliced sheet into " + gridFrames.length + " frame(s) (" + cols + "x" + rows + " grid) for '" + clip.name + "'.");
                    render();
                  })
                  .catch((err) => {
                    pushLog("error", "Failed to slice sprite sheet: " + err.message);
                    render();
                  });
                return;
              }
            }
            clip.frames.push(...frames);
            pushLog("log", "Sliced sheet into " + frames.length + " frame(s) (auto-detected) for '" + clip.name + "'.");
            render();
          })
          .catch((err) => {
            pushLog("error", "Failed to slice sprite sheet: " + err.message);
            render();
          });
      }
      e.target.value = "";
      return;
    }

    const field = e.target.dataset.field;
    if (field) {
      applyFieldChange(field, e.target);
      render();
    }
  });

  // Animation panel preview playback: a small independent ticker (NOT
  // tied to the game's own GameLoop/AnimationSystem — the panel needs
  // to preview a clip's frames even while the game itself isn't
  // running) that advances editorState.anim.previewFrameIndex at the
  // EDITING clip's own fps whenever the panel is open and its preview
  // "play" toggle is on. Mirrors the existing isPlaying/isPaused
  // polling interval in main.js's boot(), same reasoning: something
  // needs to keep calling render() on a timer for state that changes
  // without any user input in between frames.
  let _lastPreviewTick = performance.now();
  setInterval(() => {
    if (!editorState.animOpen || !editorState.anim.previewPlaying) {
      _lastPreviewTick = performance.now();
      return;
    }
    const entity = editorState.world && editorState.world.getEntity(editorState.selectedId);
    const anim = entity && entity.getComponent(SPRITE_ANIMATION);
    const clip = anim && anim.clips.find((c) => c.id === editorState.anim.editingClipId);
    if (!clip || clip.frames.length === 0) return;

    const now = performance.now();
    const elapsedSec = (now - _lastPreviewTick) / 1000;
    const secondsPerFrame = 1 / Math.max(0.1, clip.fps);
    if (elapsedSec < secondsPerFrame) return;
    _lastPreviewTick = now;

    editorState.anim.previewFrameIndex = (editorState.anim.previewFrameIndex + 1) % clip.frames.length;
    if (editorState.anim.previewFrameIndex === 0 && !clip.loop) {
      // Reached the end of a non-looping clip — hold on the last
      // frame and stop, matching AnimationSystem's own real-playback
      // behavior for a non-looping clip (see AnimationSystem._advance).
      editorState.anim.previewFrameIndex = clip.frames.length - 1;
      editorState.anim.previewPlaying = false;
    }
    render();
  }, 33); // ~30Hz poll is plenty for a UI preview; the fps gate above is what actually paces frame advances
}

/**
 * Writes a single input's value back onto the selected entity's
 * component. `field` looks like "Transform.position" (with data-axis)
 * or "SpriteRenderer.color".
 */
function applyFieldChange(field, inputEl) {
  const entity = editorState.world && editorState.world.getEntity(editorState.selectedId);
  if (!entity) return;

  // SpriteAnimation has two field shapes the generic componentName.propName
  // split below can't handle: "SpriteAnimation.currentClipName" (needs to
  // resolve a clip NAME back to its stable id) and
  // "SpriteAnimation.clipOverride.<clipId>.<prop>" (three dots, needs to
  // reach into a specific clip's colliderOverride object). Handle both
  // explicitly before falling through to the generic path everything else
  // uses.
  if (field.startsWith("SpriteAnimation.")) {
    const anim = entity.getComponent(SPRITE_ANIMATION);
    if (!anim) return;
    const rest = field.slice("SpriteAnimation.".length);

    if (rest === "currentClipName") {
      const clip = anim.clips.find((c) => c.name === inputEl.value);
      if (clip) anim.currentClipId = clip.id;
      anim.currentFrameIndex = 0;
      anim.frameElapsed = 0;
      return;
    }

    // Distinct from currentClipName above: this is the Animation
    // panel's OWN clip picker (editorState.anim.editingClipId) —
    // switching which clip you're EDITING/previewing in the panel must
    // NOT also change which clip is actually PLAYING in gameplay/the
    // Inspector; those are intentionally independent (see the doc
    // comment on editorState.anim.editingClipId in EditorState.js).
    if (rest === "editingClipName") {
      const clip = anim.clips.find((c) => c.name === inputEl.value);
      if (clip) {
        editorState.anim.editingClipId = clip.id;
        editorState.anim.previewFrameIndex = 0;
        editorState.anim.previewPlaying = false;
      }
      return;
    }

    if (rest === "speed") {
      anim.speed = parseFloat(inputEl.value) || 0;
      return;
    }

    const fpsMatch = rest.match(/^clipFps\.(.+)$/);
    if (fpsMatch) {
      const clip = anim.clips.find((c) => c.id === fpsMatch[1]);
      if (clip) clip.fps = Math.max(0.1, parseFloat(inputEl.value) || 12);
      return;
    }

    const overrideMatch = rest.match(/^clipOverride\.([^.]+)\.(.+)$/);
    if (overrideMatch) {
      const [, clipId, prop] = overrideMatch;
      const clip = anim.clips.find((c) => c.id === clipId);
      if (!clip || !clip.colliderOverride) return;
      const value =
        inputEl.type === "checkbox" ? inputEl.checked : inputEl.type === "number" ? parseFloat(inputEl.value) || 0 : inputEl.value;
      clip.colliderOverride[prop] = value;

      // Switching SHAPE via the dropdown only ever set this one prop —
      // it never touched the shape-specific size fields (radius,
      // capsuleRadius/HalfHeight, trianglePoints). Since colliderOverride
      // is a plain object spread from whatever the base Collider2D had
      // (not always a full `new Collider2D()`), those fields may be
      // stale from a PREVIOUS shape, or entirely missing if the base was
      // never that shape — e.g. a Box-only override switched to Triangle
      // has no trianglePoints at all, which _colliderLocalBounds() (the
      // Animation panel's preview overlay) reads as a zero-size box:
      // invisible outline, exactly the "can't see the dots" bug. Re-seed
      // the NEW shape's size fields from the entity's actual sprite
      // dimensions whenever shape itself changes, same sizing logic used
      // when a collider is first created (see _sizedColliderDefaults).
      if (prop === "shape") {
        const sized = _sizedColliderDefaults(entity);
        if (Object.keys(sized).length) {
          if (value === ColliderShape.CIRCLE) clip.colliderOverride.radius = sized.radius;
          else if (value === ColliderShape.CAPSULE) {
            clip.colliderOverride.capsuleRadius = sized.capsuleRadius;
            clip.colliderOverride.capsuleHalfHeight = sized.capsuleHalfHeight;
          } else if (value === ColliderShape.TRIANGLE) {
            clip.colliderOverride.trianglePoints = sized.trianglePoints;
          } else {
            clip.colliderOverride.width = sized.width;
            clip.colliderOverride.height = sized.height;
          }
        }
      }
      return;
    }
    return;
  }

  if (field === "Light.type") {
    const light = entity.getComponent(LIGHT);
    if (light) {
      const wasFreeform = light.type === LightType.FREEFORM;
      light.type = inputEl.value;
      // Switching INTO Freeform: re-seed radius to a sane feather width
      // (see FREEFORM_DEFAULT_FEATHER's doc comment) unless it's
      // already small enough to be a plausible feather rather than a
      // leftover Point/Spot/Area reach distance.
      if (light.type === LightType.FREEFORM && !wasFreeform && light.radius > 60) {
        light.radius = FREEFORM_DEFAULT_FEATHER;
      }
    }
    return;
  }

  if (field === "AudioSource.is3DLabel") {
    const audioSource = entity.getComponent(AUDIO_SOURCE);
    if (audioSource) audioSource.is3D = inputEl.value === "3D";
    return;
  }

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

    // Same reasoning as the clipOverride shape-switch handling above:
    // changing Collider2D.shape alone leaves whichever size field the
    // NEW shape needs at its old value, which — if this collider has
    // never been that shape before, or was itself created before sized
    // defaults existed — can be the tiny raw constructor default (a 1px
    // box, 0.5px radius, or ±0.5px triangle points; see
    // _sizedColliderDefaults' doc comment) rather than anything sized to
    // the entity's actual sprite. Re-seed the new shape's size fields
    // from the sprite whenever shape changes on the base Collider2D too.
    if (componentName === "Collider2D" && propName === "shape") {
      const sized = _sizedColliderDefaults(entity);
      if (Object.keys(sized).length) {
        if (value === ColliderShape.CIRCLE) component.radius = sized.radius;
        else if (value === ColliderShape.CAPSULE) {
          component.capsuleRadius = sized.capsuleRadius;
          component.capsuleHalfHeight = sized.capsuleHalfHeight;
        } else if (value === ColliderShape.TRIANGLE) {
          component.trianglePoints = sized.trianglePoints;
        } else {
          component.width = sized.width;
          component.height = sized.height;
        }
      }
    }
  }
}
