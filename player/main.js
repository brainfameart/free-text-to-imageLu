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

  // Exposed for debugging from the browser console only; not used by any
  // editor code.
  window.__zengineGame = game;
}

boot();
