/**
 * player/main.js
 *
 * Standalone game bootstrap. Imports ONLY from /runtime — never from
 * /editor. This file + play.html is the entire "shipped game"; deleting
 * the /editor folder entirely must not break this file.
 */

import { createGame } from "../runtime/index.js";
import { RenderSystem } from "../runtime/systems/RenderSystem.js";
import { CAMERA } from "../runtime/components/Camera.js";
import { TRANSFORM } from "../runtime/components/Transform.js";

/**
 * Same debug HUD as the editor's play popup (see
 * editor/viewport/play-popup.js for the full explanation) — kept as a
 * separate, small copy here rather than a shared import because this
 * file must import ONLY from /runtime (see file header); the HUD
 * itself only reads runtime state (scriptApi.debugState), so
 * duplicating these ~30 lines keeps that boundary intact.
 */
function createDebugOverlay() {
  const el = document.createElement("div");
  el.id = "zengine-debug-hud";
  el.style.cssText =
    "position:absolute; top:8px; left:8px; z-index:9999; " +
    "font:12px/1.5 'Consolas','Menlo',monospace; color:#0f0; " +
    "background:rgba(0,0,0,0.6); padding:6px 10px; border-radius:4px; " +
    "white-space:pre; pointer-events:none; display:none;";
  document.body.appendChild(el);
  return el;
}

function createFpsTracker() {
  let acc = 0;
  let frames = 0;
  let lastFps = 0;
  return function tick(dt) {
    acc += dt;
    frames++;
    if (acc >= 0.5) {
      lastFps = Math.round(frames / acc);
      acc = 0;
      frames = 0;
    }
    return lastFps;
  };
}

function updateDebugOverlay(el, scriptApi, fps) {
  const state = scriptApi.debugState;
  if (!state || !state.enabled) {
    if (el.style.display !== "none") el.style.display = "none";
    return;
  }
  el.style.display = "block";
  const lines = [];
  if (state.showFps) lines.push("FPS: " + fps);
  for (const [label, value] of state.stats) {
    lines.push(label + ": " + value);
  }
  el.textContent = lines.join("\n") || "(debug on — no stats yet)";
}

/**
 * Draws every debug ray a script cast this frame via
 * physics.raycast(x1,y1,x2,y2,{debug:true}) — see ScriptAPI._raycast().
 * `graphics` is a PIXI.Graphics parented under the SAME world-space
 * container sprites render into (gameContentContainer, via
 * game.getDebugLayer() below), so a debug line drawn in world
 * coordinates automatically pans/zooms with the camera exactly like
 * everything else in the scene — no manual camera-transform math here.
 *
 * Runs unconditionally (not gated by debugState.enabled — matches
 * Unity's Debug.DrawLine, which draws regardless of a separate on/off
 * toggle; debug.show() only controls the text HUD). Drawing is cheap
 * when debugLines is empty (a single .clear() call), so this costs
 * nothing for games that never call raycast with debug:true.
 *
 * IMPORTANT: clears debugState.debugLines itself, once, right after
 * drawing — this is intentionally NOT done by ScriptSystem's per-frame
 * cleanup (_clearFrameKeys). Scripts run inside world.update(), which
 * happens BEFORE this function's caller (game.loop.onTick) on the very
 * same frame — clearing any earlier would wipe a line before it ever
 * got drawn once.
 */
function renderDebugLines(graphics, scriptApi) {
  const state = scriptApi.debugState;
  graphics.clear();
  if (!state || !state.debugLines || state.debugLines.length === 0) return;

  for (const line of state.debugLines) {
    // Laser-beam style: line runs from origin to hit point (endX/endY),
    // so it visually cuts off at the surface instead of passing through it.
    // No separate dot — the tip of the beam is the hit indicator.
    graphics.lineStyle(2, line.color, 1);
    graphics.moveTo(line.x1, line.y1);
    graphics.lineTo(line.endX, line.endY);
  }
  state.debugLines.length = 0;
}

async function boot() {
  const mount = document.getElementById("game-canvas");

  const pixiApp = new PIXI.Application({
    width: mount.clientWidth || 800,
    height: mount.clientHeight || 600,
    backgroundColor: 0x282828,
    antialias: true,
    autoDensity: true,
    resolution: window.devicePixelRatio || 1,
  });
  mount.appendChild(pixiApp.view);

  const game = createGame({ pixiApp, followMainCamera: true });

  // Load a scene shipped alongside the game, falling back to the default
  // starter scene if none is found (e.g. running this template directly).
  try {
    await game.loadScene("./scene.json");
  } catch (err) {
    console.warn("[player] No scene.json found, loading default scene.", err);
    game.loadDefault();
  }

  const validation = game.validate();
  if (!validation.ok) {
    console.error("[player] Scene validation failed:", validation.errors);
  }

  const mainCameraEntity = game.world.query(TRANSFORM, CAMERA).find((e) => e.getComponent(CAMERA).isMain);
  if (mainCameraEntity) {
    RenderSystem.applyBackgroundColor(pixiApp, mainCameraEntity.getComponent(CAMERA).backgroundColor);
  }

  window.addEventListener("resize", () => {
    pixiApp.renderer.resize(mount.clientWidth, mount.clientHeight);
  });

  game.loop.start();

  // Debug HUD — see createDebugOverlay() above / play-popup.js for the
  // full explanation. Hidden until a script calls debug.show().
  const debugOverlayEl = createDebugOverlay();
  const fpsTick = createFpsTracker();
  const debugLayer = game.getDebugLayer();
  game.loop.onTick = function (dt) {
    const fps = fpsTick(dt);
    updateDebugOverlay(debugOverlayEl, game.scriptApi, fps);
    renderDebugLines(debugLayer, game.scriptApi);
  };

  // Exposed for debugging from the browser console only; not used by any
  // editor code.
  window.__zengineGame = game;
}

boot();
