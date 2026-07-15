/**
 * editor/viewport/SceneViewport.js
 *
 * Composes the editor's Scene/Game viewport: creates a PIXI Application,
 * boots a real runtime game instance into it (via runtime/index.js), and
 * layers editor-only grid + gizmo + camera-frame on top. This is the
 * bridge between editor UI and the actual engine — it's the only
 * viewport file allowed to import from /runtime.
 *
 * Also owns:
 *  - drag-and-drop of a sprite asset from the Project panel into the
 *    scene (creates a new Entity with Transform + SpriteRenderer at the
 *    drop position)
 *  - pointer-driven translate/scale gizmo interaction (see
 *    TransformGizmo.js) and click-to-select on rendered sprites
 */

import { createGame } from "../../runtime/index.js";
import { ViewportCamera } from "./ViewportCamera.js";
import { drawSceneGrid } from "./SceneGrid.js";
import { drawCameraGizmo } from "./CameraGizmo.js";
import { drawColliderGizmo } from "./ColliderGizmo.js";
import { TriangleColliderGizmo } from "./TriangleColliderGizmo.js";
import { drawLightGizmo, hitTestLightGizmo } from "./LightGizmo.js";
import { drawAudioGizmo, hitTestAudioGizmo } from "./AudioGizmo.js";
import { FreeformLightGizmo } from "./FreeformLightGizmo.js";
import { TransformGizmo } from "./TransformGizmo.js";
import { editorState, pushLog } from "../state/EditorState.js";
import { attachPixiDiagnostics } from "../state/ConsoleCapture.js";
import { TRANSFORM, Transform } from "../../runtime/components/Transform.js";
import { COLLIDER_2D } from "../../runtime/components/Collider2D.js";
import { LIGHT, LightType } from "../../runtime/components/Light.js";
import { SPRITE_RENDERER, SpriteRenderer } from "../../runtime/components/SpriteRenderer.js";
import { SPRITE_ANIMATION, SpriteAnimation, generateClipId } from "../../runtime/components/SpriteAnimation.js";
import { CAMERA } from "../../runtime/components/Camera.js";
import { RenderSystem } from "../../runtime/systems/RenderSystem.js";
import { AnimationSystem } from "../../runtime/systems/AnimationSystem.js";
import { getSpriteAsset, getAudioAsset } from "../../runtime/assets/AssetRegistry.js";
import { AUDIO_SOURCE, AudioSource } from "../../runtime/components/AudioSource.js";
import { TILEMAP } from "../../runtime/components/Tilemap.js";
import { TILESET } from "../../runtime/components/Tileset.js";

let pixiApp = null;
let viewportCamera = null;
let gridContainer = null;
let gizmoContainer = null;
let selectionOutlineGfx = null;
let cameraGizmoContainer = null;
let colliderGizmoContainer = null;
let lightGizmoContainer = null;
let audioGizmoContainer = null;
let transformGizmo = null;
let triangleColliderGizmo = null;
let freeformLightGizmo = null;
let game = null;
let pixiCanvasHold = null;
let renderFn = null;
let renderSystem = null;
let lightingSystem = null;
let animationSystem = null;
let tilemapSystem = null;
let _markViewportDirty = null;

export function getGame() {
  return game;
}

/**
 * Detaches the live PixiJS canvas from its current DOM parent WITHOUT
 * destroying the PIXI app/view. The editor's render() (main.js)
 * rebuilds the entire app shell via `app.innerHTML = html`, which would
 * otherwise try to remove the canvas from a mount it's about to
 * overwrite — and PIXI's canvas sometimes gets reparented/synced by
 * the renderer mid-frame, producing a "node to be removed is no
 * longer a child" DOM error (especially while dragging a numeric
 * Inspector field that fires render() on every `input` event). Calling
 * this immediately before `innerHTML` safely unhooks the canvas so the
 * old mount can be replaced cleanly; mountOrUpdateSceneViewport() then
 * re-attaches it to the fresh mount right after.
 */
export function detachViewportCanvas() {
  if (!pixiApp || !pixiApp.view) return;
  // Park the live canvas in a hidden holder instead of just removing it.
  // If the canvas has no parent, PIXI's internal ResizeObserver / RAF
  // callbacks can re-parent it between this call and the `innerHTML`
  // replacement in render(), producing a "node to be removed is no
  // longer a child" DOM error. Keeping it parked in a stable (hidden)
  // parent means innerHTML never tries to remove it and PIXI's observers
  // always see a valid parentNode.
  if (!pixiCanvasHold) {
    pixiCanvasHold = document.createElement("div");
    pixiCanvasHold.id = "_pixi-canvas-hold";
    pixiCanvasHold.style.cssText =
      "position:absolute;left:-99999px;top:0;width:0;height:0;overflow:hidden;pointer-events:none;";
    document.body.appendChild(pixiCanvasHold);
  }
  if (pixiApp.view.parentNode !== pixiCanvasHold) {
    pixiCanvasHold.appendChild(pixiApp.view);
  }
}

/**
 * Switches the live World over to a different scene (see
 * runtime/scene/SceneManager.js): saves the current scene's edits into
 * its slot, loads the target scene's data in, then resets editor
 * selection/gizmos so nothing stale from the old scene lingers (e.g. a
 * selected entity id that no longer exists once ids are reset).
 * @param {string} sceneId
 */
export function switchScene(sceneId) {
  if (!game) return false;
  const switched = game.switchToScene(sceneId);
  if (!switched) return false;

  editorState.selectedId = null;
  editorState.selectedIds = [];
  const mainCamera = game.world.findFirstByName("Main Camera");
  editorState.selectedId = mainCamera ? mainCamera.id : null;
  if (editorState.selectedId) editorState.selectedIds = [editorState.selectedId];

  syncSpriteRender();
  refreshGizmos();
  return true;
}

/**
 * Lightweight, DOM-safe live update: re-applies the Main Camera's
 * current backgroundColor to the Scene viewport's canvas. Exported
 * specifically so EditorEvents.js can call it on every "input" tick of
 * the background color picker WITHOUT going through the full editor
 * render() — render() replaces the entire app innerHTML, which would
 * destroy/reopen a live native <input type="color"> popover mid-drag.
 * This function touches only pixiApp.renderer, never the DOM tree.
 */
export function syncBackgroundColorLive() {
  syncBackgroundColor();
}

function createViewport(mount, render) {
  renderFn = render;
  const w = Math.max(1, mount.clientWidth);
  const h = Math.max(1, mount.clientHeight);

  pixiApp = new PIXI.Application({
    width: w,
    height: h,
    backgroundColor: 0x282828,
    antialias: true,
    autoDensity: true,
    resolution: window.devicePixelRatio || 1,
  });
  mount.appendChild(pixiApp.view);
  attachPixiDiagnostics(pixiApp);

  game = createGame({ pixiApp });
  game.initScenes();
  editorState.world = game.world;
  editorState.game = game;
  // NOTE: game.loop is intentionally never started here — that would run
  // PhysicsSystem every frame and things would fall/drift while just
  // editing. Instead we sync ONLY the RenderSystem below (via
  // syncSpriteRender(), called from mountOrUpdateSceneViewport on every
  // editor render), so sprites show up immediately without simulating.
  renderSystem = game.world.systems.find((s) => s.constructor.name === "RenderSystem") || null;
  lightingSystem = game.world.systems.find((s) => s.constructor.name === "LightingSystem") || null;
  animationSystem = game.world.systems.find((s) => s.constructor.name === "AnimationSystem") || null;
  tilemapSystem = game.world.systems.find((s) => s.constructor.name === "TilemapSystem") || null;
  syncSpriteRender();
  if (!editorState.selectedId) {
    const mainCamera = game.world.findFirstByName("Main Camera");
    editorState.selectedId = mainCamera ? mainCamera.id : null;
    if (editorState.selectedId) editorState.selectedIds = [editorState.selectedId];
  }

  // editor-only chrome containers, drawn around the runtime's own stage content
  gridContainer = new PIXI.Container();
  cameraGizmoContainer = new PIXI.Container();
  colliderGizmoContainer = new PIXI.Container();
  lightGizmoContainer = new PIXI.Container();
  audioGizmoContainer = new PIXI.Container();
  gizmoContainer = new PIXI.Container();
  selectionOutlineGfx = new PIXI.Graphics();
  gizmoContainer.addChild(selectionOutlineGfx);
  // LightingSystem's GPU lighting filter (see runtime/systems/
  // LightingSystem.js) is applied to createGame's internal
  // gameContentContainer — a child of pixiApp.stage that holds ONLY
  // RenderSystem's sprites — NOT to pixiApp.stage itself, specifically
  // so it can never darken/shadow this editor-only chrome (grid,
  // gizmos, camera frame) which lives as separate sibling containers
  // directly on pixiApp.stage (see runtime/index.js for the full
  // rationale). These chrome layers still get their own explicit
  // zIndex values so they stay drawn above gameContentContainer
  // (sortableChildren is on for pixiApp.stage too) regardless of add
  // order. lightGizmoContainer specifically needs to be ABOVE the lit
  // scene so a light's bulb icon and range circle stay
  // visible/clickable even in a fully darkened area of the scene —
  // otherwise you couldn't click a light to select it from inside its
  // own shadow.
  gridContainer.zIndex = -1; // grid stays behind everything, including darkness
  cameraGizmoContainer.zIndex = 200000;
  colliderGizmoContainer.zIndex = 200001;
  lightGizmoContainer.zIndex = 200002;
  audioGizmoContainer.zIndex = 200002;
  gizmoContainer.zIndex = 200003;
  pixiApp.stage.addChildAt(gridContainer, 0); // grid behind everything
  pixiApp.stage.addChild(cameraGizmoContainer); // camera frame above scene content
  pixiApp.stage.addChild(colliderGizmoContainer); // collider outlines above camera frame dimming
  pixiApp.stage.addChild(lightGizmoContainer); // light icons/range above the darkness overlay
  pixiApp.stage.addChild(audioGizmoContainer); // audio icons/range, same layer as light gizmos
  pixiApp.stage.addChild(gizmoContainer); // selection/transform gizmo above everything
  pixiApp.stage.sortableChildren = true;
  drawSceneGrid(gridContainer);

  transformGizmo = new TransformGizmo(gizmoContainer);
  triangleColliderGizmo = new TriangleColliderGizmo(gizmoContainer);
  freeformLightGizmo = new FreeformLightGizmo(gizmoContainer);

  viewportCamera = new ViewportCamera(pixiApp, pixiApp.stage);
  viewportCamera.onZoomChange((percent) => {
    const el = document.getElementById("zoom-label");
    if (el) el.textContent = percent + "%";
  });
  viewportCamera.attach(mount);

  // Keep lighting (and the light gizmo's screen-constant bulb icon)
  // synced on EVERY rendered frame, not just whenever the DOM-driven
  // render() cycle happens to run. Sprites/gizmos are real children of
  // pixiApp.stage, so PIXI's own ticker already re-transforms them
  // instantly on every frame during a live pan/zoom gesture (wheel
  // events never call render()). LightingSystem.update() previously
  // only ran from inside render()'s syncSpriteRender() call, so its
  // uStageOffset/uStageScale uniforms stayed frozen on whatever value
  // was current the last time some UNRELATED editor event fired a
  // render() — during an active zoom-out/in gesture this showed up as
  // the rendered light glow visibly lagging behind/detaching from its
  // own gizmo until the gesture ended and some other event finally
  // re-synced it. Ticking it here guarantees the light texture is
  // recomputed with THIS frame's real stage transform every single
  // frame, so it can never drift out of alignment with its gizmo.
  // Dirty/transform-change tracking so the per-frame ticker work
  // only runs when something actually needs redrawing (see comment below).
  let _vpDirty = true; // start dirty so the first frame renders
  let _lastStageX = NaN;
  let _lastStageY = NaN;
  let _lastStageScale = NaN;
  let _lastSelectedId = null;

  // Exposed so syncSpriteRender() (called on every editor render cycle)
  // can flag the viewport as dirty — any state change that triggers a
  // render() also needs the lighting/gizmos refreshed once.
  _markViewportDirty = function () { _vpDirty = true; };

  pixiApp.ticker.add(() => {
    // Determine whether anything actually changed since the last frame:
    //   1. Stage pan/zoom moved (lighting uniforms depend on it)
    //   2. A render()/syncSpriteRender cycle flagged us dirty
    //   3. The selection changed (gizmos follow the selection)
    //   4. Play mode is active (physics/animation may be moving things)
    const stage = pixiApp.stage;
    const stageChanged =
      stage.x !== _lastStageX || stage.y !== _lastStageY || stage.scale.x !== _lastStageScale;
    const selChanged = editorState.selectedId !== _lastSelectedId;

    if (!stageChanged && !_vpDirty && !selChanged && !editorState.isPlaying) {
      // Idle: skip all per-frame gizmo/lighting work. PIXI still
      // re-transforms existing display objects internally, but we
      // avoid the expensive lighting-system uniform pass and the
      // full gizmo Graphics redraws that were burning cycles for
      // identical output frame after frame.
      return;
    }

    _lastStageX = stage.x;
    _lastStageY = stage.y;
    _lastStageScale = stage.scale.x;
    _lastSelectedId = editorState.selectedId;
    _vpDirty = false;

    if (lightingSystem && editorState.world) {
      try {
        lightingSystem.update(editorState.world, 0);
      } catch (err) {
        pushLog("error", "Lighting sync failed: " + (err && err.message ? err.message : err));
      }
    }
    if (lightGizmoContainer) {
      drawLightGizmo(lightGizmoContainer, editorState.world, editorState.selectedId, _worldPerPixel());
    }
    if (audioGizmoContainer) {
      drawAudioGizmo(audioGizmoContainer, editorState.world, editorState.selectedId, _worldPerPixel());
    }
    if (freeformLightGizmo) {
      const selected = editorState.world ? editorState.world.getEntity(editorState.selectedId) : null;
      const light = selected ? selected.getComponent(LIGHT) : null;
      freeformLightGizmo.draw(selected, light, _worldPerPixel());
    }
  });

  // center the world container like the original mockup did
  pixiApp.stage.x = w / 2;
  pixiApp.stage.y = h / 2;

  attachGizmoPointerEvents(mount);
  attachDropTarget(mount);
}

/**
 * Converts a browser client (screen) coordinate to world-space
 * coordinates inside the viewport's stage, accounting for pan/zoom.
 */
function clientToWorld(clientX, clientY) {
  const rect = pixiApp.view.getBoundingClientRect();
  const localX = clientX - rect.left;
  const localY = clientY - rect.top;
  const stage = pixiApp.stage;
  return {
    x: (localX - stage.x) / stage.scale.x,
    y: (localY - stage.y) / stage.scale.y,
  };
}

// Tile tool drag-paint state (see attachGizmoPointerEvents' pointerdown/
// pointermove/endDrag branches for "tool === 'tile'"). Module-level like
// _markViewportDirty above rather than local to attachGizmoPointerEvents,
// since it must survive across the separate pointerdown/pointermove/
// pointerup event listener callbacks registered in that function.
let _isPaintingTile = false;

/**
 * Paints (or, with altKey, erases) the Tilemap cell under a client
 * (screen) position on the given entity's Tilemap component. Cell
 * coordinates are computed relative to the ENTITY's own Transform
 * position (matching TilemapSystem.js, which positions its per-tilemap
 * layer container at transform.x/y and places tiles at
 * (col+0.5)*tileWidth/(row+0.5)*tileHeight WITHIN that layer) rather
 * than raw world space, so a Tilemap entity can be moved around the
 * scene without every previously-painted cell shifting to a different
 * col/row. Falls back to a default 32x32 cell size if no Tileset is
 * assigned yet (so painting still works before the user picks one; the
 * cells just won't render any art until TilemapSystem.js has a Tileset
 * to resolve spriteKeys from).
 * @param {import('../../runtime/core/World.js').Entity} entity
 * @param {import('../../runtime/components/Tilemap.js').Tilemap} tilemap
 * @param {number} clientX
 * @param {number} clientY
 * @param {boolean} erase
 */
function _paintTileAtClientPos(entity, tilemap, clientX, clientY, erase) {
  const transform = entity.getComponent(TRANSFORM);
  if (!transform) return;

  const tilesetEntity = tilemap.tilesetEntityId ? editorState.world.getEntity(tilemap.tilesetEntityId) : null;
  const tileset = tilesetEntity ? tilesetEntity.getComponent(TILESET) : null;
  const tileWidth = tileset ? tileset.tileWidth : 32;
  const tileHeight = tileset ? tileset.tileHeight : 32;

  const world = clientToWorld(clientX, clientY);
  const localX = world.x - transform.x;
  const localY = world.y - transform.y;
  const col = Math.floor(localX / tileWidth);
  const row = Math.floor(localY / tileHeight);
  const key = col + "," + row;

  if (erase) {
    if (tilemap.cells[key]) {
      delete tilemap.cells[key];
      syncSpriteRender();
    }
  } else if (!tilemap.cells[key]) {
    tilemap.cells[key] = true;
    syncSpriteRender();
  }
}

function attachGizmoPointerEvents(mount) {
  const el = pixiApp.view;

  // Manual double-click tracker for freeform light edge insertion.
  // The native dblclick event is unreliable on laptop touchpads (the
  // OS double-click threshold can differ from the browser's, so the
  // browser never fires dblclick). Tracking timestamp + screen position
  // ourselves on pointerdown works on every device — same approach
  // already used for scene-rename in EditorEvents.js.
  let _lastFreeformClick = { time: 0, x: 0, y: 0 };

  el.addEventListener("contextmenu", (e) => {
    // Right-click delete for a Freeform Light vertex — handled via the
    // browser's own contextmenu event rather than pointerdown, since
    // pointerdown's e.button!==0 guard below intentionally ignores
    // non-left clicks for every other gizmo interaction. preventDefault
    // suppresses the native right-click menu ONLY when we actually hit
    // a vertex, so right-clicking empty canvas still gets the browser
    // menu as normal.
    const world = clientToWorld(e.clientX, e.clientY);
    const selected = editorState.world ? editorState.world.getEntity(editorState.selectedId) : null;
    const light = selected ? selected.getComponent(LIGHT) : null;
    if (!light || light.type !== LightType.FREEFORM) return;
    const vertexIndex = freeformLightGizmo.hitTest(world.x, world.y, _worldPerPixel());
    if (vertexIndex !== null) {
      e.preventDefault();
      freeformLightGizmo.removePoint(light, vertexIndex);
      if (renderFn) renderFn();
    }
  });

  el.addEventListener("pointerdown", (e) => {
    const tool = editorState.activeTool;
    if (e.button !== 0) return; // selection/gizmo only responds to left click

    // Tile tool owns the pointer entirely while active — paints the
    // cell under the cursor on the CURRENTLY SELECTED entity's Tilemap
    // (if it has one), rather than falling through to gizmo/selection
    // logic below. Dragging continues painting cell-by-cell (see
    // pointermove's mirrored "tool === 'tile'" branch further down);
    // painting itself just writes true into Tilemap.cells — the actual
    // tile ART shown at each cell is computed fresh every frame by
    // runtime/systems/TilemapSystem.js from the live neighbor pattern
    // (see that file + AutoTileRules.js), never decided here.
    // The erase tool owns the pointer exactly like the tile paint
    // tool, except every painted (or dragged-over) cell is removed
    // instead of added — see _paintTileAtClientPos's erase branch.
    // Alt+click still inverts either tool (paint-while-erase-tool, or
    // erase-while-tile-tool), matching the existing Alt-erase behavior.
    if (tool === "tile" || tool === "erase") {
      const selected = editorState.world ? editorState.world.getEntity(editorState.selectedId) : null;
      const tilemap = selected ? selected.getComponent(TILEMAP) : null;
      if (tilemap) {
        _isPaintingTile = true;
        _paintTileAtClientPos(selected, tilemap, e.clientX, e.clientY, tool === "erase" || e.altKey);
        try { el.setPointerCapture(e.pointerId); } catch (err) {}
      }
      e.preventDefault();
      e.stopPropagation();
      return;
    }

    // Triangle collider vertex handles take priority over the
    // translate/scale/rotate gizmo when both are visually present —
    // they're small, precise targets that would otherwise often lose
    // to the bigger transform gizmo's hit region at the same spot.
    // Checked regardless of activeTool (same as the transform gizmo's
    // own translate/scale/rotate gating below still applies to IT, but
    // reshaping a collider is its own direct-manipulation mode, not
    // tied to a toolbar tool).
    {
      const world = clientToWorld(e.clientX, e.clientY);
      const selected = editorState.world ? editorState.world.getEntity(editorState.selectedId) : null;
      const transform = selected ? selected.getComponent(TRANSFORM) : null;
      const collider = selected ? selected.getComponent(COLLIDER_2D) : null;
      if (transform && collider) {
        const vertexIndex = triangleColliderGizmo.hitTest(world.x, world.y);
        if (vertexIndex !== null) {
          triangleColliderGizmo.beginDrag(vertexIndex, transform);
          try { el.setPointerCapture(e.pointerId); } catch (err) {}
          e.preventDefault();
          e.stopPropagation();
          return;
        }
      }
    }

    // Freeform Light polygon vertex handles — same priority tier as
    // the triangle collider handles above (checked before the generic
    // translate/scale/rotate gizmo and before click-to-select), only
    // when the currently selected entity actually is a Freeform light.
    // Right-click/alt-click a vertex to delete it; double-click an edge
    // midpoint to insert a new vertex there — both handled here rather
    // than the translate/scale/rotate drag path since they're one-shot
    // edits, not a drag gesture.
    {
      const world = clientToWorld(e.clientX, e.clientY);
      const selected = editorState.world ? editorState.world.getEntity(editorState.selectedId) : null;
      const transform = selected ? selected.getComponent(TRANSFORM) : null;
      const light = selected ? selected.getComponent(LIGHT) : null;
      if (transform && light && light.type === LightType.FREEFORM) {
        const vertexIndex = freeformLightGizmo.hitTest(world.x, world.y, _worldPerPixel());
        if (vertexIndex !== null) {
          if (e.altKey) {
            // Alt-click as a left-button-only alternative to the
            // right-click contextmenu handler above (some trackpads/
            // browsers make right-click awkward).
            freeformLightGizmo.removePoint(light, vertexIndex);
            e.preventDefault();
            e.stopPropagation();
            if (renderFn) renderFn();
            return;
          }
          freeformLightGizmo.beginDrag(vertexIndex, transform);
          try { el.setPointerCapture(e.pointerId); } catch (err) {}
          e.preventDefault();
          e.stopPropagation();
          return;
        }
        // Manual double-click detection for edge midpoint insertion
        // (see _lastFreeformClick above). Fires on pointerdown, which
        // is reliable on laptop touchpads — unlike the native dblclick
        // event, whose OS-level threshold can differ from the browser's.
        const edgeAfterIndex = freeformLightGizmo.hitTestEdge(world.x, world.y, _worldPerPixel());
        if (edgeAfterIndex !== null) {
          const now = Date.now();
          if (now - _lastFreeformClick.time < 400 &&
              Math.hypot(e.clientX - _lastFreeformClick.x, e.clientY - _lastFreeformClick.y) < 15) {
            freeformLightGizmo.insertPoint(light, edgeAfterIndex, world.x, world.y, transform);
            _lastFreeformClick = { time: 0, x: 0, y: 0 };
            e.preventDefault();
            e.stopPropagation();
            if (renderFn) renderFn();
            return;
          }
          _lastFreeformClick = { time: now, x: e.clientX, y: e.clientY };
        }
      }
    }

    // Gizmo dragging is exclusive to translate/scale/rotate — but
    // click-to-select on a sprite should work no matter which tool is
    // active (including "pan"), same as every other editor. This used
    // to bail out entirely for any other tool, which made clicking a
    // sprite do nothing while the pan tool was selected.
    if (tool === "translate" || tool === "scale" || tool === "rotate") {
      const world = clientToWorld(e.clientX, e.clientY);
      const selected = editorState.world ? editorState.world.getEntity(editorState.selectedId) : null;
      const transform = selected ? selected.getComponent(TRANSFORM) : null;

      if (transform) {
        const handle = transformGizmo.hitTest(world.x, world.y);
        if (handle) {
          transformGizmo.beginDrag(handle, world.x, world.y, transform);
          try { el.setPointerCapture(e.pointerId); } catch (err) {}
          e.preventDefault();
          e.stopPropagation();
          return;
        }
      }
    }

    // Not on a gizmo handle (or gizmo tool isn't active): try selecting
    // a different entity. Runs for every tool (including "pan") so
    // clicking always selects it. Light gizmo icons are checked FIRST
    // and take priority over sprite hit-testing — a light's clickable
    // icon is deliberately small and would otherwise often be "covered"
    // by whatever bigger sprite sits at/near the same position (a lamp
    // sprite with a Point light entity centered on it, for example).
    const world = clientToWorld(e.clientX, e.clientY);
    const lightHit = hitTestLightGizmo(editorState.world, world.x, world.y, _worldPerPixel());
    const audioHit = hitTestAudioGizmo(editorState.world, world.x, world.y, _worldPerPixel());
    const spriteHit = hitTestEntities(world.x, world.y);
    const hitId = lightHit ? lightHit.id : audioHit ? audioHit.id : (spriteHit ? spriteHit.id : null);
    if (hitId) {
      if (e.shiftKey) {
        const i = editorState.selectedIds.indexOf(hitId);
        if (i >= 0) editorState.selectedIds.splice(i, 1);
        else editorState.selectedIds.push(hitId);
        editorState.selectedId = editorState.selectedIds.length
          ? editorState.selectedIds[editorState.selectedIds.length - 1]
          : null;
      } else {
        editorState.selectedId = hitId;
        editorState.selectedIds = [hitId];
      }
    } else if (!e.shiftKey) {
      // Clicked empty space: clear the selection (Shift+click on empty
      // keeps the current selection, matching standard editor behavior).
      editorState.selectedId = null;
      editorState.selectedIds = [];
    }
    if (renderFn) renderFn();
  });

  el.addEventListener("pointermove", (e) => {
    if (_isPaintingTile) {
      const selected = editorState.world ? editorState.world.getEntity(editorState.selectedId) : null;
      const tilemap = selected ? selected.getComponent(TILEMAP) : null;
      if (tilemap) _paintTileAtClientPos(selected, tilemap, e.clientX, e.clientY, editorState.activeTool === "erase" || e.altKey);
      return;
    }
    if (freeformLightGizmo.isDragging()) {
      const selected = editorState.world ? editorState.world.getEntity(editorState.selectedId) : null;
      const light = selected ? selected.getComponent(LIGHT) : null;
      if (!light) return;
      const world = clientToWorld(e.clientX, e.clientY);
      freeformLightGizmo.updateDrag(world.x, world.y, light);
      syncSpriteRender();
      refreshGizmos();
      return;
    }

    if (triangleColliderGizmo.isDragging()) {
      const selected = editorState.world ? editorState.world.getEntity(editorState.selectedId) : null;
      const collider = selected ? selected.getComponent(COLLIDER_2D) : null;
      if (!collider) return;
      const world = clientToWorld(e.clientX, e.clientY);
      triangleColliderGizmo.updateDrag(world.x, world.y, collider);
      syncSpriteRender();
      refreshGizmos();
      return;
    }

    if (!transformGizmo.isDragging()) return;
    const selected = editorState.world ? editorState.world.getEntity(editorState.selectedId) : null;
    const transform = selected ? selected.getComponent(TRANSFORM) : null;
    if (!transform) return;

    const world = clientToWorld(e.clientX, e.clientY);
    transformGizmo.updateDrag(world.x, world.y, transform);
    syncSpriteRender();
    refreshGizmos();
  });

  const endDrag = (e) => {
    if (_isPaintingTile) {
      _isPaintingTile = false;
      try { el.releasePointerCapture(e.pointerId); } catch (err) {}
      return;
    }
    if (freeformLightGizmo.isDragging()) {
      freeformLightGizmo.endDrag();
      try { el.releasePointerCapture(e.pointerId); } catch (err) {}
      if (renderFn) renderFn();
      return;
    }
    if (triangleColliderGizmo.isDragging()) {
      triangleColliderGizmo.endDrag();
      try { el.releasePointerCapture(e.pointerId); } catch (err) {}
      if (renderFn) renderFn();
      return;
    }
    if (!transformGizmo.isDragging()) return;
    transformGizmo.endDrag();
    try { el.releasePointerCapture(e.pointerId); } catch (err) {}
    if (renderFn) renderFn(); // sync Inspector fields with the final value
  };
  el.addEventListener("pointerup", endDrag);
  el.addEventListener("pointercancel", endDrag);
}

/**
 * Bounding-box hit test against every entity that has a Transform +
 * SpriteRenderer, used for click-to-select in the viewport. Uses each
 * sprite's REAL rendered world-space size (via RenderSystem's live PIXI
 * sprite — see getSpriteWorldHalfExtents above) so clicks land correctly
 * regardless of how big or small a given sprite actually is; falls back
 * to a reasonable 40px half-extent only for the rare case a sprite
 * hasn't been rendered yet (e.g. its texture is still loading), so a
 * click still hits something close instead of never registering.
 */
function hitTestEntities(worldX, worldY) {
  if (!editorState.world) return null;
  const entities = editorState.world.query(TRANSFORM, SPRITE_RENDERER);
  // iterate back-to-front (topmost first) by reversing
  for (let i = entities.length - 1; i >= 0; i--) {
    const t = entities[i].getComponent(TRANSFORM);
    const real = renderSystem ? renderSystem.getSpriteWorldHalfExtents(entities[i].id) : null;
    const halfWidth = real ? real.halfWidth : 40 * Math.max(Math.abs(t.scaleX), Math.abs(t.scaleY), 0.2);
    const halfHeight = real ? real.halfHeight : halfWidth;
    if (worldX >= t.x - halfWidth && worldX <= t.x + halfWidth && worldY >= t.y - halfHeight && worldY <= t.y + halfHeight) {
      return entities[i];
    }
  }
  return null;
}

/**
 * Uploaded sprite images can be any native pixel size (a phone photo
 * might be 3000x4000). Placing them at scale 1:1 would make them cover
 * the entire scene and read as a giant black/blown-out rectangle rather
 * than a sprite. This computes a proportional scale so the sprite's
 * longest side lands at SPRITE_FIT_SIZE px in world space by default —
 * small enough to see the whole scene around it, still clearly visible.
 * Small source images (icons, pixel art) are left at 1:1 or upscaled
 * only up to a modest ceiling, so tiny art doesn't get shrunk further.
 */
const SPRITE_FIT_SIZE = 96;
const SPRITE_MAX_UPSCALE = 2;

function fitSpriteScale(width, height) {
  if (!width || !height) return { scaleX: 1, scaleY: 1 };
  const longest = Math.max(width, height);
  let scale = SPRITE_FIT_SIZE / longest;
  scale = Math.min(scale, SPRITE_MAX_UPSCALE);
  scale = Math.round(scale * 1000) / 1000; // avoid ugly float noise in Inspector fields
  return { scaleX: scale, scaleY: scale };
}

function attachDropTarget(mount) {
  const el = pixiApp.view;
  el.addEventListener("dragover", (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  });
  el.addEventListener("drop", (e) => {
    e.preventDefault();
    const spriteKey = e.dataTransfer.getData("application/x-zengine-sprite-key");
    const audioKey = e.dataTransfer.getData("application/x-zengine-audio-key");

    if (audioKey && editorState.world) {
      const asset = getAudioAsset(audioKey);
      if (!asset) return;
      const world = clientToWorld(e.clientX, e.clientY);
      const entity = editorState.world.createEntity(asset.name || "Audio");
      entity.addComponent(TRANSFORM, new Transform({ x: Math.round(world.x), y: Math.round(world.y) }));
      entity.addComponent(AUDIO_SOURCE, new AudioSource({ audioKey: asset.key }));
      editorState.selectedId = entity.id;
      editorState.selectedIds = [entity.id];
      pushLog("log", "Placed audio '" + asset.name + "' in scene.");
      syncSpriteRender();
      if (renderFn) renderFn();
      return;
    }

    if (!spriteKey || !editorState.world) return;

    const asset = getSpriteAsset(spriteKey);
    if (!asset) return;

    const world = clientToWorld(e.clientX, e.clientY);
    const { scaleX, scaleY } = fitSpriteScale(asset.width, asset.height);
    const entity = editorState.world.createEntity(asset.name || "Sprite");
    entity.addComponent(
      TRANSFORM,
      new Transform({ x: Math.round(world.x), y: Math.round(world.y), scaleX, scaleY })
    );
    entity.addComponent(
      SPRITE_RENDERER,
      new SpriteRenderer({ spriteKey: asset.key, referenceWidth: asset.width, referenceHeight: asset.height })
    );

    if (asset.gifFrames && asset.gifFrames.length > 1) {
      var clip = {
        id: generateClipId(),
        name: asset.name || "Animation",
        frames: asset.gifFrames.map(function (k) { return { spriteKey: k, sourceAssetKey: null }; }),
        fps: asset.gifFps || 10,
        loop: true,
        colliderOverride: null,
      };
      entity.addComponent(SPRITE_ANIMATION, new SpriteAnimation({ clips: [clip], currentClipId: clip.id, playing: true }));
      pushLog("log", "Placed animated GIF '" + asset.name + "' (" + asset.gifFrames.length + " frames) in scene.");
    } else {
      pushLog("log", "Placed sprite '" + asset.name + "' in scene.");
    }

    editorState.selectedId = entity.id;
    editorState.selectedIds = [entity.id];
    syncSpriteRender();
    if (renderFn) renderFn();
  });
}

/**
 * Runs ONLY RenderSystem.update() against the current world so any
 * Transform/SpriteRenderer changes (placing a sprite, dragging it,
 * editing Inspector fields) show up in the Scene view immediately —
 * without calling game.loop.start(), which would also run PhysicsSystem
 * and cause objects to fall/drift while just editing.
 */
function syncSpriteRender() {
  if (!renderSystem || !editorState.world) return;
  try {
    if (animationSystem) animationSystem.update(editorState.world, 0);
    renderSystem.update(editorState.world, 0);
    // TilemapSystem builds/refreshes tile sprites from Tilemap.cells,
    // so it must tick here too — otherwise painted cells never render
    // (the game loop is intentionally never started in the editor).
    if (tilemapSystem) tilemapSystem.update(editorState.world, 0);
    if (_markViewportDirty) _markViewportDirty();
    // Runs right after RenderSystem so any Light component edits (color,
    // intensity, radius, type, or moving a light's Transform) preview
    // live in the Scene view exactly like sprite edits do — matching
    // how Play mode will actually look, same reasoning as calling
    // renderSystem.update() here instead of only during a real game
    // loop tick.
    if (lightingSystem) lightingSystem.update(editorState.world, 0);
  } catch (err) {
    pushLog("error", "Render sync failed: " + (err && err.message ? err.message : err));
  }
  syncBackgroundColor();
}

/**
 * Applies the scene's Main Camera backgroundColor to the Scene
 * viewport's own canvas, live — every editor render, so dragging the
 * color picker in the Inspector previews instantly here, exactly like
 * it will look in Play mode. This is the "live in the editor" half of
 * the background-color feature; the play popup applies the same color
 * only once, at the moment Play is pressed (see PlayWindow.js), never
 * tracking further edits while a game is actually running.
 */
function syncBackgroundColor() {
  if (!pixiApp || !editorState.world) return;
  const cameraEntity = editorState.world.query(TRANSFORM, CAMERA).find((e) => e.getComponent(CAMERA).isMain);
  const color = cameraEntity ? cameraEntity.getComponent(CAMERA).backgroundColor : "#282828";
  RenderSystem.applyBackgroundColor(pixiApp, color);
}

/**
 * Redraws just the gizmo layers (called during drag, every pointermove,
 * without going through the full editor render() for performance).
 */
function drawSelectionOutlines() {
  if (!selectionOutlineGfx || !editorState.world) return;
  selectionOutlineGfx.clear();
  for (const id of editorState.selectedIds) {
    if (id === editorState.selectedId) continue; // primary already framed by the transform gizmo
    const ent = editorState.world.getEntity(id);
    if (!ent) continue;
    const t = ent.getComponent(TRANSFORM);
    if (!t) continue;
    const real = renderSystem ? renderSystem.getSpriteWorldHalfExtents(ent.id) : null;
    const hw = real ? real.halfWidth : 40 * Math.max(Math.abs(t.scaleX), Math.abs(t.scaleY), 0.2);
    const hh = real ? real.halfHeight : hw;
    selectionOutlineGfx.lineStyle(1.5, 0x8fc153, 1);
    selectionOutlineGfx.drawRect(t.x - hw, t.y - hh, hw * 2, hh * 2);
  }
}

function refreshGizmos() {
  const selected = editorState.world ? editorState.world.getEntity(editorState.selectedId) : null;
  drawSelectionOutlines();
  transformGizmo.draw(selected);
  const selectedCollider = selected ? selected.getComponent(COLLIDER_2D) : null;
  triangleColliderGizmo.draw(selected, selectedCollider);
  drawCameraGizmo(cameraGizmoContainer, editorState.world);
  drawColliderGizmo(colliderGizmoContainer, editorState.world, editorState.selectedId);
  drawLightGizmo(lightGizmoContainer, editorState.world, editorState.selectedId, _worldPerPixel());
  drawAudioGizmo(audioGizmoContainer, editorState.world, editorState.selectedId, _worldPerPixel());
}

/**
 * World units per screen pixel at the viewport's current zoom — the
 * inverse of pixiApp.stage.scale.x (same scale clientToWorld already
 * divides by). Used only to keep LightGizmo's bulb icon a constant
 * apparent screen size regardless of zoom (see LightGizmo.js).
 */
function _worldPerPixel() {
  if (!pixiApp || !pixiApp.stage.scale.x) return 1;
  return 1 / pixiApp.stage.scale.x;
}

/**
 * Called every editor render() to mount/resize the viewport and refresh
 * the selection gizmo to track the selected entity's live Transform.
 */
export function mountOrUpdateSceneViewport(render) {
  const mount = document.getElementById("pixi-viewport-canvas");
  if (!mount) return;

  if (!pixiApp) {
    createViewport(mount, render);
  } else {
    renderFn = render || renderFn;
    mount.appendChild(pixiApp.view);
    const w = mount.clientWidth,
      h = mount.clientHeight;
    if (w > 0 && h > 0) pixiApp.renderer.resize(w, h);
    viewportCamera.updateZoomLabel();
    viewportCamera.updateCursor();
  }

  syncSpriteRender();
  refreshGizmos();
}

export function getZoomPercent() {
  return viewportCamera ? viewportCamera.zoomPercent : 100;
}
