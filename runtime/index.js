/**
 * runtime/index.js
 *
 * PUBLIC ENTRY POINT of the runtime. This is the only module that
 * /editor code or the standalone player (player/main.js) should import
 * from. It wires together World + systems + render + scene loading into
 * one `createGame()` call.
 *
 * The runtime never imports anything from /editor. That's what makes the
 * game standalone — see /RULES.txt.
 */

import { World } from "./core/World.js";
import { GameLoop } from "./core/GameLoop.js";
import { PhysicsSystem } from "./systems/PhysicsSystem.js";
import { RenderSystem } from "./systems/RenderSystem.js";
import { loadSceneFromUrl, loadDefaultScene, validateScene } from "./scene/SceneLoader.js";
import { serializeScene, deserializeScene } from "./scene/SceneSerializer.js";
import { ScriptAPI } from "./scripting/ScriptAPI.js";
import { importSpriteFiles, getAllSpriteAssets, getSpriteAsset } from "./assets/AssetRegistry.js";
import { getCameraResolution, getCameraWorldRect } from "./core/CameraUtils.js";

/**
 * Creates a fully wired game instance against a PIXI Application that the
 * caller owns (editor viewport, or the standalone player's own canvas).
 *
 * @param {object} opts
 * @param {PIXI.Application} opts.pixiApp an already-created PIXI Application
 * @param {boolean} [opts.followMainCamera=false] pass true when pixiApp's
 *   stage IS the actual game screen (play-mode popup, standalone player)
 *   so RenderSystem offsets the world by the Main Camera's position.
 *   Leave false/omitted for the editor's Scene viewport, which drives its
 *   own free-roam pan/zoom over the same stage instead.
 * @returns {{
 *   world: World,
 *   loop: GameLoop,
 *   scriptApi: ScriptAPI,
 *   loadScene: (url: string) => Promise<void>,
 *   loadDefault: () => void,
 *   loadFromData: (sceneData: object) => void,
 *   getSceneData: () => object,
 *   validate: () => { ok: boolean, errors: string[] },
 * }}
 */
export function createGame({ pixiApp, followMainCamera = false }) {
  window.__zenginePixiApp = pixiApp; // used by AssetManager for placeholder texture generation

  const world = new World();
  const renderSystem = new RenderSystem(pixiApp.stage, { followMainCamera });
  world.addSystem(new PhysicsSystem());
  world.addSystem(renderSystem);

  const scriptApi = new ScriptAPI(world);
  const loop = new GameLoop(world);

  return {
    world,
    loop,
    scriptApi,
    loadScene: (url) => loadSceneFromUrl(world, url),
    loadDefault: () => loadDefaultScene(world),
    loadFromData: (sceneData) => deserializeScene(world, sceneData),
    getSceneData: () => serializeScene(world),
    validate: () => validateScene(world),
    destroyRenderer: () => renderSystem.destroy(),
  };
}

export {
  World,
  GameLoop,
  ScriptAPI,
  importSpriteFiles,
  getAllSpriteAssets,
  getSpriteAsset,
  getCameraResolution,
  getCameraWorldRect,
};
