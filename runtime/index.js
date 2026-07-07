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
import { ControllerSystem } from "./systems/ControllerSystem.js";
import { PhysicsSystem } from "./systems/PhysicsSystem.js";
import { AnimationSystem } from "./systems/AnimationSystem.js";
import { RenderSystem } from "./systems/RenderSystem.js";
import { LightingSystem } from "./systems/LightingSystem.js";
import { loadSceneFromUrl, loadDefaultScene, validateScene } from "./scene/SceneLoader.js";
import { serializeScene, deserializeScene } from "./scene/SceneSerializer.js";
import {
  initSceneManager,
  getSceneList,
  getActiveSceneId,
  createScene,
  saveActiveScene,
  switchToScene,
  renameScene,
  deleteScene,
} from "./scene/SceneManager.js";
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

  // gameContentContainer holds ONLY actual game content (sprites drawn
  // by RenderSystem) as a child of pixiApp.stage, rather than using
  // pixiApp.stage directly. This matters specifically for
  // LightingSystem: it applies a real PIXI.Filter (a GPU shader) to
  // whatever container it's given (see systems/LightingSystem.js), and
  // a Filter affects EVERY pixel of its target INCLUDING children added
  // by other code. In the standalone player and the play-mode popup,
  // pixiApp.stage holds nothing but game content anyway, so this would
  // make no visible difference there — but the editor's Scene viewport
  // (editor/viewport/SceneViewport.js) adds its OWN sibling containers
  // directly onto pixiApp.stage for the grid, selection gizmo, camera
  // frame, collider outlines, and light gizmos. Those are editor-only
  // chrome that must stay visible/undimmed/unshadowed regardless of
  // scene lighting (e.g. a light's range gizmo must still be clickable
  // from inside its own shadow) — if LightingSystem's filter were
  // applied straight to pixiApp.stage, it would darken/relight/shadow
  // that chrome right along with the sprites, which is wrong. Routing
  // both RenderSystem's sprites AND LightingSystem's filter through
  // this dedicated sub-container keeps the filter's reach exactly
  // scoped to real game content in every host (editor, player, popup)
  // without the editor needing any special-case code of its own.
  const gameContentContainer = new PIXI.Container();
  pixiApp.stage.addChild(gameContentContainer);

  const renderSystem = new RenderSystem(gameContentContainer, { followMainCamera });
  const controllerSystem = new ControllerSystem();
  world.addSystem(controllerSystem);
  world.addSystem(new PhysicsSystem());
  // AnimationSystem runs AFTER physics (so a clip switch driven by a
  // script reacting to this frame's physics state — e.g. "landed" —
  // takes effect the same tick) but BEFORE RenderSystem, so the frame
  // it just picked is what actually gets drawn this tick rather than
  // lagging one frame behind.
  world.addSystem(new AnimationSystem());
  world.addSystem(renderSystem);
  // LightingSystem is added AFTER RenderSystem and shares the exact
  // same container (gameContentContainer) so its GPU lighting filter
  // updates every frame right alongside sprites, staying visually
  // locked to them (same pan/zoom/camera-follow offset) instead of
  // drifting. renderSystem is also passed in directly so LightingSystem
  // can read each ShadowCaster entity's real rendered sprite bounds for
  // dynamic shadow casting (see LightingSystem.`_collectOccluders`) —
  // always available here since renderSystem is constructed just above.
  const lightingSystem = new LightingSystem(gameContentContainer, renderSystem, pixiApp);
  world.addSystem(lightingSystem);

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
    destroyLighting: () => lightingSystem.destroy(),
    destroyControllers: () => controllerSystem.destroy(),

    // Multi-scene project management (see scene/SceneManager.js). Sprite
    // assets are NOT scoped per-scene — AssetRegistry.js is one shared
    // catalogue for the whole project, same as loadFromData/getSceneData
    // above never touch it.
    initScenes: () => initSceneManager(world),
    getSceneList: () => getSceneList(),
    getActiveSceneId: () => getActiveSceneId(),
    createScene: (name) => createScene(name),
    saveActiveScene: () => saveActiveScene(world),
    switchToScene: (sceneId) => switchToScene(world, sceneId),
    renameScene: (sceneId, name) => renameScene(world, sceneId, name),
    deleteScene: (sceneId) => deleteScene(world, sceneId),
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
