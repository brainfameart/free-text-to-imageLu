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
import { CameraRenderSystem } from "./systems/CameraRenderSystem.js";
import { LightingSystem } from "./systems/LightingSystem.js";
import { AudioSystem } from "./systems/AudioSystem.js";
import { TilemapSystem } from "./systems/TilemapSystem.js";
import { ScriptSystem } from "./systems/ScriptSystem.js";
import { loadSceneFromUrl, loadDefaultScene, validateScene } from "./scene/SceneLoader.js";
import { serializeScene, deserializeScene } from "./scene/SceneSerializer.js";
import {
  initSceneManager,
  getSceneList,
  getAllScenesData,
  getActiveSceneId,
  createScene,
  saveActiveScene,
  switchToScene,
  renameScene,
  deleteScene,
  loadAllScenesData,
} from "./scene/SceneManager.js";
import { ScriptAPI } from "./scripting/ScriptAPI.js";
import { importSpriteFiles, getAllSpriteAssets, getSpriteAsset, importAudioFiles, getAllAudioAssets, getAudioAsset } from "./assets/AssetRegistry.js";
import { getCameraResolution, getCameraWorldRect } from "./core/CameraUtils.js";
import { CAMERA } from "./components/Camera.js";
import { TRANSFORM } from "./components/Transform.js";

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
  const physicsSystem = new PhysicsSystem();
  world.addSystem(physicsSystem);
  // AnimationSystem runs AFTER physics (so a clip switch driven by a
  // script reacting to this frame's physics state — e.g. "landed" —
  // takes effect the same tick) but BEFORE RenderSystem, so the frame
  // it just picked is what actually gets drawn this tick rather than
  // lagging one frame behind.
  world.addSystem(new AnimationSystem());
  world.addSystem(renderSystem);
  // TilemapSystem shares gameContentContainer with renderSystem so
  // painted tiles live in the same world space and are affected by
  // LightingSystem's filter identically to regular sprites (see
  // gameContentContainer's own comment above for why that container
  // exists at all). Order relative to renderSystem doesn't matter since
  // they track entirely separate entity sets (SPRITE_RENDERER vs
  // TILEMAP), but placing it right after keeps rendering-ish systems
  // grouped together for readability.
  const tilemapSystem = new TilemapSystem(gameContentContainer);
  world.addSystem(tilemapSystem);
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
  // CameraRenderSystem runs AFTER RenderSystem + LightingSystem so the
  // worldContainer is fully synced and lit before capture. It renders
  // any camera with renderToSpriteEntityId set (set via
  // this.camera.renderToSprite(spriteEntity) in a script) into a
  // RenderTexture and assigns it to the target sprite — minimaps.
  const cameraRenderSystem = new CameraRenderSystem(gameContentContainer, renderSystem, pixiApp);
  world.addSystem(cameraRenderSystem);

  // AudioSystem doesn't touch gameContentContainer at all (it drives
  // plain HTMLAudioElements, not PIXI display objects) so its place in
  // the system order relative to rendering/lighting doesn't matter —
  // added last for clarity only.
  const audioSystem = new AudioSystem();
  world.addSystem(audioSystem);

  const scriptApi = new ScriptAPI(world);
  // ScriptSystem runs user-attached scripts ONLY during the game loop
  // (play-mode popup / standalone player) — never in the editor, which
  // only calls syncSpriteRender() selectively, never game.loop.start().
  const scriptSystem = new ScriptSystem(scriptApi);
  world.addSystem(scriptSystem);

  // Wire ScriptSystem into PhysicsSystem so collision and trigger events
  // dispatched by Rapier's EventQueue are forwarded to user script handlers
  // (onCollision, onTriggerEnter, onTriggerExit) every physics step.
  physicsSystem.setScriptSystem(scriptSystem);
  const loop = new GameLoop(world);

  // Remember the initial scene data so scene.restart() can reload it.
  // Stored as a deep-clone so in-flight mutations to the original object
  // (component properties updated during play, etc.) never corrupt the
  // restart snapshot — deserializeScene reads the clone unchanged each time.
  let _initialSceneData = null;
  // Scene APIs can be called from collision callbacks while Rapier is
  // draining its event queue. Never mutate World or Rapier from that call
  // stack: retain the first requested transition and apply it after the
  // current GameLoop update has completely finished.
  let _pendingSceneChange = null;
  let _applyingSceneChange = false;

  /**
   * Full teardown before swapping in new scene data — matches Unity's
   * own scene-reload behavior: every currently-running script instance
   * is properly destroyed (onDestroy fires, exactly like a real Unity
   * object being torn down when a scene unloads) BEFORE the new scene's
   * entities/scripts exist, so nothing from the old scene keeps running
   * or leaks into the new one. Previously this only cleared
   * scriptSystem.instances directly (skipping onDestroy entirely) and
   * never touched Rapier's physics bodies or ScriptAPI's cached
   * EntityContexts, which is what caused "restart doesn't really stop
   * old scripts" — the old script objects/handlers were dropped, but
   * their physics bodies and any EntityContext a still-live closure
   * held onto were not, so the scene didn't actually reset the way
   * Unity's Restart Scene does.
   */
  function _teardownForSceneChange() {
    // 1. Destroy every running script instance NOW (calls onDestroy),
    //    while the old scene's entities still exist — same order Unity
    //    fires OnDestroy in when a scene unloads.
    scriptSystem.destroy();
    // 2. Remove every Rapier body/collider the old scene created — a
    //    fresh scene must start with a physically empty Rapier world,
    //    not one still full of the previous scene's now-orphaned bodies.
    physicsSystem.clear();
    controllerSystem.resetScene();
    renderSystem.destroy();
    tilemapSystem.destroy();
    lightingSystem.resetScene();
    audioSystem.destroy();
    // 3. Drop every cached EntityContext — entity ids are about to be
    //    reused by World.clear() (see core/World.js), and without this
    //    a stale context from a destroyed entity would get handed back
    //    to the new scene's scripts (see ScriptAPI.clearContexts()'s
    //    own doc comment for the full reasoning).
    scriptApi.clearContexts();
  }

  function _queueSceneChange(change) {
    if (_applyingSceneChange || _pendingSceneChange) return;
    _pendingSceneChange = change;
  }

  function _applyPendingSceneChange() {
    const change = _pendingSceneChange;
    if (!change) return;
    _pendingSceneChange = null;
    _applyingSceneChange = true;
    try {
      if (change.kind === "restart") {
        if (_initialSceneData) {
          _teardownForSceneChange();
          cameraRenderSystem.clear();
          deserializeScene(world, JSON.parse(JSON.stringify(_initialSceneData)));
          scriptSystem._started = false;
          _applySceneCamera();
        }
      } else {
        let found = getAllScenesData().find(function (s) {
          return s.name === change.sceneName;
        });
        if (found) {
          // SceneManager represents the active scene with data=null. Capture
          // that scene before teardown, because teardown clears the World and
          // saving afterward would overwrite the active scene with an empty
          // payload. Loading the active scene is also a valid request: like
          // Unity, it should reload the scene rather than become a no-op.
          if (!found.data) {
            saveActiveScene(world);
            // getAllScenesData() returns fresh list entries, so re-read the
            // saved active entry instead of mutating the temporary `found`
            // object whose data was null.
            found = getAllScenesData().find(function (s) {
              return s.name === change.sceneName;
            });
          }
          if (!found || !found.data) return;
          const targetSceneData = JSON.parse(JSON.stringify(found.data));
          // Restart always means "restart the scene that is currently
          // loaded", not "return to the scene Play mode originally opened".
          // Advance the immutable restart snapshot with every successful
          // scene.load() transition.
          _initialSceneData = JSON.parse(JSON.stringify(targetSceneData));
          _teardownForSceneChange();
          cameraRenderSystem.clear();
          deserializeScene(world, targetSceneData);
          scriptSystem._started = false;
          _applySceneCamera();
        } else if (typeof console !== "undefined") {
          console.log("[ScriptAPI] scene.load('" + change.sceneName + "') — no scene found with that name. Available scenes: " +
            (getAllScenesData().map(function(s){ return s.name; }).join(", ") || "(none)"));
        }
      }
    } finally {
      _applyingSceneChange = false;
    }
  }

  // Host hook (play popup) notified when a scene load/restart changes the
  // Main Camera — used to resize the canvas when the new scene's camera
  // has a different orientation/dimension than the one the window booted
  // with. null in the editor (no resize needed there).
  let _onSceneCameraChanged = null;

  // Re-applies the newly-loaded scene's Main Camera background color to
  // the renderer. RenderSystem already re-applies camera position/zoom
  // every frame (followMainCamera), but the clear color is only set once
  // at boot by the player/editor — so after a scene.load()/restart it
  // would otherwise keep showing the previous scene's background. This
  // is a no-op when there's no Main Camera yet (just-loaded empty scene).
  // Also notifies the host hook of the new resolution so the play popup
  // can resize its canvas/mount when the camera orientation/dimensions
  // changed (e.g. scene.load() into a Portrait scene from a Landscape one).
  function _applySceneCamera() {
    const camEntity = world.query(TRANSFORM, CAMERA).find(function (e) {
      const c = e.getComponent(CAMERA);
      return c && c.isMain;
    });
    if (camEntity) {
      const cam = camEntity.getComponent(CAMERA);
      RenderSystem.applyBackgroundColor(pixiApp, cam.backgroundColor);
      if (_onSceneCameraChanged) {
        const res = getCameraResolution(cam);
        _onSceneCameraChanged(res.width, res.height, cam.backgroundColor);
      }
    }
  }

  // Wire up scene management callbacks on the ScriptAPI.
  scriptApi._restartFn = function () {
    _queueSceneChange({ kind: "restart" });
  };
  scriptApi._loadSceneFn = function (sceneName) {
    _queueSceneChange({ kind: "load", sceneName: sceneName });
  };

  loop.onAfterUpdate = _applyPendingSceneChange;

  return {
    world,
    loop,
    scriptApi,
    loadScene: (url) => loadSceneFromUrl(world, url),
    loadDefault: () => loadDefaultScene(world),
    loadFromData: (sceneData) => {
      // Deep-clone immediately so mutations during play never corrupt the
      // restart snapshot — same reason _restartFn clones before passing
      // to deserializeScene (see comment there).
      _initialSceneData = JSON.parse(JSON.stringify(sceneData));
      deserializeScene(world, sceneData);
    },
    getSceneData: () => serializeScene(world),
    validate: () => validateScene(world),
    destroyRenderer: () => renderSystem.destroy(),
    destroyLighting: () => lightingSystem.destroy(),
    destroyCameraRenders: () => cameraRenderSystem.destroy(),
    destroyControllers: () => controllerSystem.destroy(),
    /** Register a callback fired when a scene load/restart changes the
     *  Main Camera (resolution + background). The play popup uses this
     *  to resize its canvas + aspect-fit when scene.load() switches to
     *  a scene whose camera has a different orientation/dimension. */
    onSceneCameraChanged: (fn) => { _onSceneCameraChanged = fn; },
    destroyAudio: () => audioSystem.destroy(),
    destroyTilemaps: () => tilemapSystem.destroy(),

    /** ScriptSystem instance — the play popup uses this to wire the
     *  onError callback so script errors are sent back to the editor. */
    scriptSystem,

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

    /**
     * Populates SceneManager with a full set of scene payloads passed
     * from the editor (via PlayWindow.js → window.__ZENGINE_PLAY_PAYLOAD__).
     * This is what makes scene.load('Name') work in the play popup —
     * without it SceneManager's _scenes list is empty and every load()
     * call fails with "no scene found", even when the name is exact.
     * @param {Array<{id:string,name:string,data:object}>} allScenes
     */
    loadAllScenes: (allScenes) => loadAllScenesData(allScenes),
  };
}

export {
  World,
  GameLoop,
  ScriptAPI,
  importSpriteFiles,
  getAllSpriteAssets,
  getSpriteAsset,
  importAudioFiles,
  getAllAudioAssets,
  getAudioAsset,
  getCameraResolution,
  getCameraWorldRect,
};
