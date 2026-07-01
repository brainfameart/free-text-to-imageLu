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
import { TransformGizmo } from "./TransformGizmo.js";
import { editorState, pushLog } from "../state/EditorState.js";
import { attachPixiDiagnostics } from "../state/ConsoleCapture.js";
import { TRANSFORM, Transform } from "../../runtime/components/Transform.js";
import { SPRITE_RENDERER, SpriteRenderer } from "../../runtime/components/SpriteRenderer.js";
import { getSpriteAsset } from "../../runtime/assets/AssetRegistry.js";

let pixiApp = null;
let viewportCamera = null;
let gridContainer = null;
let gizmoContainer = null;
let cameraGizmoContainer = null;
let transformGizmo = null;
let game = null;
let renderFn = null;
let renderSystem = null;

export function getGame() {
  return game;
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
  game.loadDefault();
  editorState.world = game.world;
  // NOTE: game.loop is intentionally never started here — that would run
  // PhysicsSystem every frame and things would fall/drift while just
  // editing. Instead we sync ONLY the RenderSystem below (via
  // syncSpriteRender(), called from mountOrUpdateSceneViewport on every
  // editor render), so sprites show up immediately without simulating.
  renderSystem = game.world.systems.find((s) => s.constructor.name === "RenderSystem") || null;
  syncSpriteRender();
  if (!editorState.selectedId) {
    const mainCamera = game.world.findFirstByName("Main Camera");
    editorState.selectedId = mainCamera ? mainCamera.id : null;
  }

  // editor-only chrome containers, drawn around the runtime's own stage content
  gridContainer = new PIXI.Container();
  cameraGizmoContainer = new PIXI.Container();
  gizmoContainer = new PIXI.Container();
  pixiApp.stage.addChildAt(gridContainer, 0); // grid behind everything
  pixiApp.stage.addChild(cameraGizmoContainer); // camera frame above scene content
  pixiApp.stage.addChild(gizmoContainer); // selection/transform gizmo above everything
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
    if (tool !== "translate" && tool !== "scale") return;
    if (e.button !== 0) return; // gizmo only responds to left click

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

    // not on a handle: try selecting a different entity by clicking its sprite
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
 * Simple bounding-box hit test against every entity that has a Transform
 * + SpriteRenderer, used for click-to-select in the viewport. Uses an
 * 80x80 box centered on the entity to match the selection gizmo size,
 * which is good enough for editor selection (not pixel-perfect sprite
 * bounds, since sprites can be arbitrary sizes).
 */
function hitTestEntities(worldX, worldY) {
  if (!editorState.world) return null;
  const entities = editorState.world.query(TRANSFORM, SPRITE_RENDERER);
  // iterate back-to-front (topmost first) by reversing
  for (let i = entities.length - 1; i >= 0; i--) {
    const t = entities[i].getComponent(TRANSFORM);
    const half = 40 * Math.max(Math.abs(t.scaleX), Math.abs(t.scaleY), 0.2);
    if (worldX >= t.x - half && worldX <= t.x + half && worldY >= t.y - half && worldY <= t.y + half) {
      return entities[i];
    }
  }
  return null;
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
    const entity = editorState.world.createEntity(asset.name || "Sprite");
    entity.addComponent(TRANSFORM, new Transform({ x: Math.round(world.x), y: Math.round(world.y) }));
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
  } catch (err) {
    pushLog("error", "Render sync failed: " + (err && err.message ? err.message : err));
  }
}

/**
 * Redraws just the gizmo layers (called during drag, every pointermove,
 * without going through the full editor render() for performance).
 */
function refreshGizmos() {
  const selected = editorState.world ? editorState.world.getEntity(editorState.selectedId) : null;
  transformGizmo.draw(selected);
  drawCameraGizmo(cameraGizmoContainer, editorState.world);
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
