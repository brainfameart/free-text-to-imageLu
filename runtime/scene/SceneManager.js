/**
 * runtime/scene/SceneManager.js
 *
 * Holds the project's list of scenes (each a plain serialized-scene
 * object, see SceneSerializer.js) and which one is currently active/
 * loaded into the live World. Sprite assets are NOT part of a scene's
 * data (see AssetRegistry.js) — they live in one project-wide registry
 * that every scene shares, exactly like Unity's shared asset database.
 * Only entities + hierarchy + each scene's own camera are per-scene.
 *
 * RUNTIME-ONLY FILE.
 */

import { serializeScene, deserializeScene } from "./SceneSerializer.js";
import { loadDefaultScene } from "./SceneLoader.js";

let _scenes = []; // [{ id, name, data }] — data is a serialized-scene object (null while it's the live/active one)
let _activeIndex = -1;
let _nextSceneId = 1;

/**
 * Sets up the scene list with a single default starter scene and loads
 * it into the given World. Call once at boot.
 * @param {import('../core/World.js').World} world
 */
export function initSceneManager(world) {
  _scenes = [{ id: "scene" + _nextSceneId++, name: "Main Scene", data: null }];
  _activeIndex = 0;
  loadDefaultScene(world);
  world.sceneName = _scenes[0].name;
}

/** @returns {Array<{id:string,name:string}>} lightweight list for UI (no full data payload) */
export function getSceneList() {
  return _scenes.map((s) => ({ id: s.id, name: s.name }));
}

/**
 * Returns the full scene list including serialized data payloads.
 * Used by the editor to pass all scenes to the play popup so
 * scene.load() can work there.
 * @returns {Array<{id:string,name:string,data:object|null}>}
 */
export function getAllScenesData() {
  return _scenes.map((s) => ({ id: s.id, name: s.name, data: s.data }));
}

/**
 * Populates the scene list from an external array (e.g. passed from
 * the editor to the play popup). Does NOT load any scene into the World
 * — call switchToScene() or deserializeScene() after this.
 * @param {Array<{id:string,name:string,data:object}>} scenesData
 */
export function loadAllScenesData(scenesData) {
  if (!scenesData || !scenesData.length) return;
  _scenes = scenesData.map((s) => ({ id: s.id, name: s.name, data: s.data }));
  // activeIndex stays -1 until switchToScene/initSceneManager is called.
  // Compute the max existing id number so createScene() doesn't collide.
  let maxId = 0;
  for (const s of _scenes) {
    const n = parseInt((s.id || "").replace("scene", ""), 10);
    if (!isNaN(n) && n > maxId) maxId = n;
  }
  _nextSceneId = maxId + 1;
}

export function getActiveSceneId() {
  return _activeIndex >= 0 ? _scenes[_activeIndex].id : null;
}

/**
 * Creates a new empty scene (just a Main Camera, like the default
 * starter scene) and appends it to the list. Does NOT switch to it —
 * call switchToScene() separately if the caller wants to jump into it.
 * @returns {{id:string,name:string}}
 */
export function createScene(name) {
  const id = "scene" + _nextSceneId++;
  const sceneName = name || "New Scene";
  const data = defaultSceneData(sceneName);
  _scenes.push({ id, name: sceneName, data });
  return { id, name: sceneName };
}

/**
 * @param {string} name
 * @returns {object} a fresh default-scene serialized payload (one Main Camera)
 */
function defaultSceneData(name) {
  return {
    sceneName: name,
    entities: [
      {
        name: "Main Camera",
        tag: "MainCamera",
        active: true,
        components: {
          Transform: { x: 0, y: 0 },
          Camera: { isMain: true },
        },
      },
    ],
  };
}

/**
 * Saves the World's current live contents back into the active scene's
 * slot in the list, so switching away doesn't lose edits.
 * @param {import('../core/World.js').World} world
 */
export function saveActiveScene(world) {
  if (_activeIndex < 0) return;
  _scenes[_activeIndex].data = serializeScene(world);
  _scenes[_activeIndex].name = world.sceneName;
}

/**
 * Persists the live World into its current slot, then loads a different
 * scene (by id) into the World.
 * @param {import('../core/World.js').World} world
 * @param {string} sceneId
 */
export function switchToScene(world, sceneId) {
  const targetIndex = _scenes.findIndex((s) => s.id === sceneId);
  if (targetIndex < 0 || targetIndex === _activeIndex) return false;

  saveActiveScene(world);

  const target = _scenes[targetIndex];
  deserializeScene(world, target.data);
  _activeIndex = targetIndex;
  return true;
}

/**
 * Renames a scene. If it's the active scene, also updates the live
 * World's sceneName so the Hierarchy header reflects it immediately.
 * @param {import('../core/World.js').World} world
 * @param {string} sceneId
 * @param {string} newName
 */
export function renameScene(world, sceneId, newName) {
  const trimmed = (newName || "").trim();
  if (!trimmed) return false;
  const entry = _scenes.find((s) => s.id === sceneId);
  if (!entry) return false;
  entry.name = trimmed;
  if (entry.id === getActiveSceneId()) world.sceneName = trimmed;
  return true;
}

/**
 * Deletes a scene. Refuses to delete the last remaining scene (a
 * project must always have at least one). If the active scene is
 * deleted, switches to the first remaining scene.
 * @param {import('../core/World.js').World} world
 * @param {string} sceneId
 */
export function deleteScene(world, sceneId) {
  if (_scenes.length <= 1) return false;
  const index = _scenes.findIndex((s) => s.id === sceneId);
  if (index < 0) return false;

  const deletingActive = index === _activeIndex;
  _scenes.splice(index, 1);

  if (deletingActive) {
    _activeIndex = -1; // nothing saved-over target now live
    const next = _scenes[0];
    deserializeScene(world, next.data);
    _activeIndex = 0;
  } else if (index < _activeIndex) {
    _activeIndex -= 1;
  }
  return true;
}
