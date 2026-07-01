/**
 * editor/viewport/play-popup.js
 *
 * Boots inside the play-mode popup window (play-popup.html). This is
 * editor tooling, NOT part of /player — but it imports ONLY from
 * /runtime for the actual game (same rule as /player: what you see here
 * must be identical to a real exported build, no editor-only rendering
 * path). Reads the scene JSON + target resolution handed to it by
 * PlayWindow.js through window.opener.__ZENGINE_PLAY_PAYLOAD__, then:
 *   1. Creates a PIXI Application at the EXACT camera resolution
 *      (runtime/core/CameraUtils.js is the single source of truth for
 *      that resolution — same function the editor's CameraGizmo uses).
 *   2. Loads the current in-editor scene data into a brand new World.
 *   3. Starts the GameLoop. No grid, no gizmos — game time.
 * AspectFit: if the popup's actual window is bigger/smaller than the
 * target resolution (user resized it, or it got clamped to fit the
 * screen), the canvas is scaled via CSS transform to fit centered with
 * letterbox bars, without changing the game's internal resolution.
 */

import { createGame } from "../../runtime/index.js";

function boot() {
  const payload = window.opener && window.opener.__ZENGINE_PLAY_PAYLOAD__;
  if (!payload) {
    document.body.innerHTML =
      '<div style="color:#eee;font:12px monospace;padding:16px;">No scene data received from the editor. Close this window and press Play again.</div>';
    return;
  }

  const { sceneData, width, height } = payload;

  const mount = document.getElementById("game-canvas");
  mount.style.width = width + "px";
  mount.style.height = height + "px";

  const pixiApp = new PIXI.Application({
    width,
    height,
    backgroundColor: 0x000000,
    antialias: true,
    autoDensity: true,
    resolution: window.devicePixelRatio || 1,
  });
  mount.appendChild(pixiApp.view);

  const game = createGame({ pixiApp, followMainCamera: true });
  game.loadFromData(sceneData);

  const validation = game.validate();
  if (!validation.ok) {
    console.error("[play] Scene validation failed:", validation.errors);
  }

  game.loop.start();
  window.__zengineGame = game;

  applyAspectFit(width, height);
  window.addEventListener("resize", () => applyAspectFit(width, height));
}

/**
 * Scales (via CSS transform) the fixed-resolution game canvas to fit
 * inside the actual current window size, centered, preserving exact
 * aspect ratio — the game itself always renders at its true resolution,
 * only the on-screen presentation is scaled.
 */
function applyAspectFit(targetW, targetH) {
  const scale = Math.min(window.innerWidth / targetW, window.innerHeight / targetH);
  const mount = document.getElementById("game-canvas");
  mount.style.transform = "scale(" + scale + ")";
  mount.style.transformOrigin = "center center";
}

boot();
