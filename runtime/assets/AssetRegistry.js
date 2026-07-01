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

export function getSpriteAsset(key) {
  return _assets.get(key) || null;
}

function stripExtension(filename) {
  const i = filename.lastIndexOf(".");
  return i > 0 ? filename.slice(0, i) : filename;
}

function sanitizeName(filename) {
  return stripExtension(filename).replace(/[^a-zA-Z0-9_-]/g, "_").toLowerCase();
}
