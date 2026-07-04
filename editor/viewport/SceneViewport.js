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
import { drawLightGizmo, hitTestLightGizmo } from "./LightGizmo.js";
import { TransformGizmo } from "./TransformGizmo.js";
import { editorState, pushLog } from "../state/EditorState.js";
import { attachPixiDiagnostics } from "../state/ConsoleCapture.js";
import { TRANSFORM, Transform } from "../../runtime/components/Transform.js";
import { SPRITE_RENDERER, SpriteRenderer } from "../../runtime/components/SpriteRenderer.js";
import { CAMERA } from "../../runtime/components/Camera.js";
import { RenderSystem } from "../../runtime/systems/RenderSystem.js";
import { getSpriteAsset } from "../../runtime/assets/AssetRegistry.js";

let pixiApp = null;
let viewportCamera = null;
let gridContainer = null;
let gizmoContainer = null;
let cameraGizmoContainer = null;
let colliderGizmoContainer = null;
let lightGizmoContainer = null;
let transformGizmo = null;
let game = null;
let renderFn = null;
let renderSystem = null;
let lightingSystem = null;

export function getGame() {
  return game;
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
  const mainCamera = game.world.findFirstByName("Main Camera");
  editorState.selectedId = mainCamera ? mainCamera.id : null;

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
  syncSpriteRender();
  if (!editorState.selectedId) {
    const mainCamera = game.world.findFirstByName("Main Camera");
    editorState.selectedId = mainCamera ? mainCamera.id : null;
  }

  // editor-only chrome containers, drawn around the runtime's own stage content
  gridContainer = new PIXI.Container();
  cameraGizmoContainer = new PIXI.Container();
  colliderGizmoContainer = new PIXI.Container();
  lightGizmoContainer = new PIXI.Container();
  gizmoContainer = new PIXI.Container();
  // LightingSystem's darkness/light overlay (see runtime/systems/
  // LightingSystem.js) lives in this SAME container (pixiApp.stage,
  // passed to createGame as the world container) at a fixed high
  // zIndex so it draws above sprites. Since RenderSystem/LightingSystem
  // already turn sortableChildren on for this container, these
  // editor-only chrome layers need explicit zIndex values above that,
  // or the sort would otherwise bury them under the light/dark overlay
  // (chrome must always stay visible on top, even in the dark).
  // lightGizmoContainer specifically needs to be ABOVE LightingSystem's
  // own darkness overlay so a light's bulb icon and range circle stay
  // visible/clickable even in a fully darkened area of the scene —
  // otherwise you couldn't click a light to select it from inside its
  // own shadow.
  gridContainer.zIndex = -1; // grid stays behind everything, including darkness
  cameraGizmoContainer.zIndex = 200000;
  colliderGizmoContainer.zIndex = 200001;
  lightGizmoContainer.zIndex = 200002;
  gizmoContainer.zIndex = 200003;
  pixiApp.stage.addChildAt(gridContainer, 0); // grid behind everything
  pixiApp.stage.addChild(cameraGizmoContainer); // camera frame above scene content
  pixiApp.stage.addChild(colliderGizmoContainer); // collider outlines above camera frame dimming
  pixiApp.stage.addChild(lightGizmoContainer); // light icons/range above the darkness overlay
  pixiApp.stage.addChild(gizmoContainer); // selection/transform gizmo above everything
  pixiApp.stage.sortableChildren = true;
  drawSceneGrid(gridContainer);

  transformGizmo = new TransformGizmo(gizmoContainer);

  viewportCamera = new ViewportCamera(pixiApp, pixiApp.stage);
  viewportCamera.onZoomChange((percent) => {
    const el = document.getElementById("zoom-label");
    if (el) el.textContent = percent + "%";
  });
  viewportCamera.attach(mount);

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

function attachGizmoPointerEvents(mount) {
  const el = pixiApp.view;

  el.addEventListener("pointerdown", (e) => {
    const tool = editorState.activeTool;
    if (e.button !== 0) return; // selection/gizmo only responds to left click

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
    if (lightHit) {
      editorState.selectedId = lightHit.id;
      if (renderFn) renderFn();
      return;
    }
    const hit = hitTestEntities(world.x, world.y);
    if (hit) {
      editorState.selectedId = hit.id;
      if (renderFn) renderFn();
    }
  });

  el.addEventListener("pointermove", (e) => {
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
    entity.addComponent(SPRITE_RENDERER, new SpriteRenderer({ spriteKey: asset.key }));
    editorState.selectedId = entity.id;
    pushLog("log", "Placed sprite '" + asset.name + "' in scene.");
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
    renderSystem.update(editorState.world, 0);
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
function refreshGizmos() {
  const selected = editorState.world ? editorState.world.getEntity(editorState.selectedId) : null;
  transformGizmo.draw(selected);
  drawCameraGizmo(cameraGizmoContainer, editorState.world);
  drawColliderGizmo(colliderGizmoContainer, editorState.world, editorState.selectedId);
  drawLightGizmo(lightGizmoContainer, editorState.world, editorState.selectedId, _worldPerPixel());
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
