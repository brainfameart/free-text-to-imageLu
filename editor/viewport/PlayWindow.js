/**
 * editor/viewport/PlayWindow.js
 *
 * "Play" opens a real, independent runtime instance in a separate
 * browser popup window (editor/viewport/play-popup.html +
 * play-popup.js), sized to the Main Camera's exact export resolution
 * via runtime/core/CameraUtils.js — the SAME function the editor's
 * CameraGizmo.js uses to draw the camera frame, so the gizmo's edges in
 * the Scene view are exactly what play mode (and a real export) shows.
 *
 * The popup boots its own PIXI Application + World + createGame() from
 * runtime/index.js and loads the CURRENT in-editor scene (read straight
 * off the live game instance via getSceneData(), which is backed by
 * runtime/scene/SceneSerializer.js — no duplicate serialization logic
 * here, per RULES.txt section 6). No editor grid, no gizmos — exactly
 * the game, as it will play/export.
 */

import { CAMERA } from "../../runtime/components/Camera.js";
import { TRANSFORM } from "../../runtime/components/Transform.js";
import { getCameraResolution } from "../../runtime/core/CameraUtils.js";
import { getAllSpriteAssets, getAllFrameAssets, getAllAudioAssets } from "../../runtime/assets/AssetRegistry.js";
import { editorState, pushLog } from "../state/EditorState.js";

let playWin = null;

export function isPlayWindowOpen() {
  return !!(playWin && !playWin.closed);
}

export function closePlayWindow() {
  if (playWin && !playWin.closed) playWin.close();
  playWin = null;
}

/**
 * Opens (or refocuses) the play popup, sized exactly to the scene's
 * Main Camera resolution, and boots an independent runtime game inside
 * it running the current scene data.
 *
 * @param {ReturnType<import('../../runtime/index.js').createGame>} game
 *   the editor's live game instance (used only to read scene data via
 *   its public getSceneData() — never mutated).
 */
export function openPlayWindow(game) {
  const world = editorState.world;
  if (!world || !game) return;

  const mainCameraEntity = world.query(TRANSFORM, CAMERA).find((e) => e.getComponent(CAMERA).isMain);
  if (!mainCameraEntity) {
    pushLog("error", "Cannot enter Play mode: scene has no Main Camera.");
    return;
  }
  const camera = mainCameraEntity.getComponent(CAMERA);
  const { width, height } = getCameraResolution(camera);
  const sceneData = game.getSceneData();

  // The popup boots a completely separate JS module realm (its own
  // <script type="module"> import graph), so AssetManager.js's texture
  // cache there starts EMPTY — it never sees the textures the editor
  // registered. sceneData only carries spriteKey strings, not pixels,
  // so without this the popup falls back to the pink "missing texture"
  // marker for every imported sprite. Bundling the imported assets'
  // dataUrls here lets the popup rebuild real textures from the same
  // source bytes before it loads the scene.
  const spriteAssets = [...getAllSpriteAssets(), ...getAllFrameAssets()];

  // Same reasoning as spriteAssets above: the popup's AssetManager.js
  // module realm starts with an empty audio cache, so any imported
  // audio clip must be handed over as raw dataUrls here too, or every
  // AudioSource in the popup would silently resolve to nothing and
  // never play.
  const audioAssets = getAllAudioAssets();

  // Hand the payload off through window.__ZENGINE_PLAY_PAYLOAD__ so the
  // popup (a separate document/context) can read it on load, regardless
  // of open/reuse timing.
  window.__ZENGINE_PLAY_PAYLOAD__ = { sceneData, width, height, spriteAssets, audioAssets };

  if (isPlayWindowOpen()) {
    playWin.location.reload();
    playWin.focus();
    return;
  }

  const availW = Math.max(320, (window.screen.availWidth || 1280) - 80);
  const availH = Math.max(320, (window.screen.availHeight || 800) - 120);
  const fitScale = Math.min(1, availW / width, availH / height);
  const winW = Math.round(width * fitScale);
  const winH = Math.round(height * fitScale);

  const features =
    "width=" + winW + ",height=" + winH + ",resizable=yes,scrollbars=no,status=no,toolbar=no,menubar=no,location=no";

  playWin = window.open("./viewport/play-popup.html", "zengine_play", features);
  if (!playWin) {
    pushLog("error", "Play window was blocked by the browser's popup blocker. Allow popups for this site and press Play again.");
    return;
  }

  pushLog("log", "Entered Play mode (" + camera.aspectMode + ", " + width + "x" + height + ").");
}
