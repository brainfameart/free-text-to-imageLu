/**
 * runtime/assets/AssetRegistry.js
 *
 * Plain-data catalogue of imported sprite assets: { key, name, dataUrl,
 * width, height }. This is what backs the editor's "Sprites" folder in
 * the Project panel and the drag source for placing sprites in a scene.
 *
 * Separate from AssetManager.js on purpose: AssetManager resolves a
 * spriteKey -> PIXI.Texture (rendering concern), while AssetRegistry is
 * just the catalogue of what's been imported (asset-browser concern).
 * Keeping the record plain data (no PIXI objects) means it can be
 * listed/rendered by editor UI without ever importing PIXI logic.
 *
 * RUNTIME-ONLY FILE.
 */

import { loadImageAssetFromFile } from "./AssetManager.js";

/** @type {Map<string, { key: string, name: string, dataUrl: string, width: number, height: number }>} */
const _assets = new Map();

/**
 * Separate catalogue for animation-frame textures (see
 * registerFrameAsset() below). Kept apart from _assets so the Project
 * panel's Sprites folder — which lists getAllSpriteAssets() — only ever
 * shows sprites the user explicitly imported as standalone assets, not
 * the (often dozens of) per-frame images that come out of slicing a
 * sheet or unzipping a walk-cycle. getSpriteAsset() below still checks
 * BOTH maps, so thumbnail lookups (used by the Animation panel and by
 * anything resolving a spriteKey generically) keep working exactly as
 * before regardless of which catalogue a given key lives in.
 * @type {Map<string, { key: string, name: string, dataUrl: string, width: number, height: number }>}
 */
const _frameAssets = new Map();

let _nextAssetId = 1;

/**
 * Imports one or more image Files as sprite assets: loads each into the
 * texture cache (via AssetManager) and records a plain-data entry here.
 * @param {File[]|FileList} files
 * @returns {Promise<Array<{key:string,name:string,dataUrl:string,width:number,height:number}>>}
 */
export async function importSpriteFiles(files) {
  const imported = [];
  for (const file of Array.from(files)) {
    if (!file.type || !file.type.startsWith("image/")) continue;
    const key = "sprite_" + _nextAssetId++ + "_" + sanitizeName(file.name);
    const { dataUrl, width, height } = await loadImageAssetFromFile(key, file);
    const record = { key, name: stripExtension(file.name), dataUrl, width, height };
    _assets.set(key, record);
    imported.push(record);
  }
  return imported;
}

export function getAllSpriteAssets() {
  return Array.from(_assets.values());
}

export function getAllFrameAssets() {
  return Array.from(_frameAssets.values());
}

export function getSpriteAsset(key) {
  return _assets.get(key) || _frameAssets.get(key) || null;
}

/**
 * Records a sprite asset catalogue entry for a texture that was
 * registered some OTHER way than importSpriteFiles — specifically, used
 * by editor/animation/AnimationImport.js for frames produced by
 * slicing a sprite sheet or reading images out of a zip, where the
 * texture is registered directly via AssetManager.registerTexture()
 * (not loadImageAssetFromFile) because the pixel data comes from an
 * in-memory canvas, not a raw File.
 * @param {{key:string,name:string,dataUrl:string,width:number,height:number}} record
 */
export function registerSpriteAsset(record) {
  _assets.set(record.key, record);
}

/**
 * Same as registerSpriteAsset(), but for animation-frame textures —
 * files/slices imported through the Animation panel (standalone-images,
 * zip, or sprite-sheet import). Stored in _frameAssets instead of
 * _assets so these DON'T show up in the Project panel's Sprites folder
 * (getAllSpriteAssets() only reads _assets) while still being
 * resolvable by key via getSpriteAsset(), which checks both maps. This
 * is what keeps an imported walk-cycle's 8 frame images out of the
 * general sprite browser while the Animation panel's own frame grid
 * (which calls getSpriteAsset() directly by spriteKey) still finds
 * them fine.
 * @param {{key:string,name:string,dataUrl:string,width:number,height:number}} record
 */
export function registerFrameAsset(record) {
  _frameAssets.set(record.key, record);
}

function stripExtension(filename) {
  const i = filename.lastIndexOf(".");
  return i > 0 ? filename.slice(0, i) : filename;
}

function sanitizeName(filename) {
  return stripExtension(filename).replace(/[^a-zA-Z0-9_-]/g, "_").toLowerCase();
}
