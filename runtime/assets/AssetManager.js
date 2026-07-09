/**
 * runtime/assets/AssetManager.js
 *
 * Maps a logical spriteKey (string) to a PIXI.Texture. Built-in
 * placeholder shapes ("square", "capsule") are generated procedurally so
 * the engine runs with zero external image files. Loaded image assets
 * register themselves here too via registerTexture().
 *
 * RUNTIME-ONLY FILE.
 */

const _textureCache = new Map();

/**
 * Loads an image File (e.g. from an <input type="file"> or a drag-drop
 * event) into a PIXI.Texture and registers it under `key`. Returns a
 * data: URL alongside the texture so callers (the editor's asset
 * browser) can render a thumbnail without touching PIXI at all.
 *
 * @param {string} key logical spriteKey to register the texture under
 * @param {File} file
 * @returns {Promise<{ key: string, dataUrl: string, width: number, height: number }>}
 */
export function loadImageAssetFromFile(key, file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error || new Error("Failed to read file"));
    reader.onload = () => {
      const dataUrl = reader.result;
      const img = new Image();
      img.onerror = () => reject(new Error("Failed to decode image: " + file.name));
      img.onload = () => {
        try {
          const baseTexture = PIXI.BaseTexture.from(img);
          const texture = new PIXI.Texture(baseTexture);
          registerTexture(key, texture);
          resolve({ key, dataUrl, width: img.naturalWidth, height: img.naturalHeight });
        } catch (err) {
          reject(err);
        }
      };
      img.src = dataUrl;
    };
    reader.readAsDataURL(file);
  });
}

/**
 * Builds the "missing texture" placeholder: a magenta/black checker
 * square, the standard game-engine convention for "no texture assigned"
 * (same idea as Unity/Unreal's pink checker). Using this instead of a
 * plain white texture means a missing/null spriteKey is immediately
 * obvious in the viewport rather than silently rendering as a blank
 * white square that's easy to mistake for "the engine is broken".
 */
function buildMissingTexture() {
  const g = new PIXI.Graphics();
  const half = 16;
  g.beginFill(0x000000);
  g.drawRect(-half, -half, half, half);
  g.drawRect(0, 0, half, half);
  g.endFill();
  g.beginFill(0xff00ff);
  g.drawRect(0, -half, half, half);
  g.drawRect(-half, 0, half, half);
  g.endFill();
  return g;
}

function generateTextureFromGraphics(graphics, fallback) {
  try {
    if (!window.__zenginePixiApp) return fallback;
    const generated = window.__zenginePixiApp.renderer.generateTexture(graphics);
    return generated || fallback;
  } catch (err) {
    return fallback;
  }
}

function buildPlaceholderTexture(key) {
  const g = new PIXI.Graphics();
  g.beginFill(0xffffff);
  if (key === "capsule") {
    g.drawRoundedRect(-16, -32, 32, 64, 16);
  } else {
    // default: square
    g.drawRect(-16, -16, 32, 32);
  }
  g.endFill();
  return g;
}

/**
 * Register a real loaded texture under a logical key.
 * @param {string} key
 * @param {PIXI.Texture} texture
 */
export function registerTexture(key, texture) {
  _textureCache.set(key, texture);
}

/**
 * Resolve a spriteKey to a PIXI.Texture, generating a placeholder shape
 * texture the first time an unknown built-in key is requested. A null
 * key or any key that isn't a known built-in / imported asset resolves
 * to a visible magenta "missing texture" marker rather than a blank
 * white square, so gaps are obvious instead of silently invisible.
 * @param {string|null} key
 * @returns {PIXI.Texture}
 */
export function resolveTexture(key) {
  if (!key) return resolveMissingTexture();

  if (_textureCache.has(key)) return _textureCache.get(key);

  if (key === "square" || key === "capsule") {
    const graphics = buildPlaceholderTexture(key);
    const generated = generateTextureFromGraphics(graphics, PIXI.Texture.WHITE);
    _textureCache.set(key, generated);
    return generated;
  }

  // Unknown key: not a built-in placeholder and not a registered
  // imported asset (e.g. scene references a sprite that hasn't loaded
  // yet, or was deleted). Show the missing-texture marker rather than
  // failing silently.
  return resolveMissingTexture();
}

let _missingTextureCache = null;
function resolveMissingTexture() {
  if (_missingTextureCache) return _missingTextureCache;
  const graphics = buildMissingTexture();
  _missingTextureCache = generateTextureFromGraphics(graphics, PIXI.Texture.WHITE);
  return _missingTextureCache;
}

export function clearTextureCache() {
  _textureCache.clear();
  _missingTextureCache = null;
}

/**
 * Loads an audio File into the audio cache and registers it under
 * `key`, mirroring loadImageAssetFromFile()'s shape. Audio has no PIXI
 * texture equivalent, so what's cached is just the dataUrl itself —
 * resolveAudioSrc() below hands that same string straight to an
 * <audio> element (see runtime/systems/AudioSystem.js). `duration` is
 * read once via a throwaway <audio> so the asset browser can show clip
 * length without every caller needing to load its own element.
 *
 * @param {string} key logical audioKey to register the clip under
 * @param {File} file
 * @returns {Promise<{ key: string, dataUrl: string, duration: number }>}
 */
export function loadAudioAssetFromFile(key, file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error || new Error("Failed to read file"));
    reader.onload = () => {
      const dataUrl = reader.result;
      const probe = new Audio();
      const finish = (duration) => {
        registerAudio(key, dataUrl);
        resolve({ key, dataUrl, duration: duration || 0 });
      };
      probe.onerror = () => finish(0); // still usable even if duration can't be probed
      probe.onloadedmetadata = () => finish(probe.duration);
      probe.src = dataUrl;
    };
    reader.readAsDataURL(file);
  });
}

const _audioCache = new Map();

/**
 * Register a raw audio dataUrl under a logical key.
 * @param {string} key
 * @param {string} dataUrl
 */
export function registerAudio(key, dataUrl) {
  _audioCache.set(key, dataUrl);
}

/**
 * Resolve an audioKey to a playable src string (a data: URL), or null
 * if the key is unknown/missing — callers (AudioSystem.js) treat null
 * as "nothing to play" rather than failing.
 * @param {string|null} key
 * @returns {string|null}
 */
export function resolveAudioSrc(key) {
  if (!key) return null;
  return _audioCache.get(key) || null;
}

export function clearAudioCache() {
  _audioCache.clear();
}
