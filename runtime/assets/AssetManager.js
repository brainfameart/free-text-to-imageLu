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

  const renderer = PIXI.autoDetectRenderer
    ? PIXI.autoDetectRenderer({ width: 64, height: 64 })
    : null;

  // Prefer using an Application-less generator when available (PIXI v7/v8 both
  // expose this on a renderer instance created elsewhere); fall back to a
  // RenderTexture pipeline lazily created the first time a viewport exists.
  return g; // RenderSystem accepts a Graphics object as a texture source via PIXI.Texture.from below
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
 * texture the first time an unknown built-in key is requested.
 * @param {string|null} key
 * @returns {PIXI.Texture}
 */
export function resolveTexture(key) {
  if (!key) return PIXI.Texture.WHITE;

  if (_textureCache.has(key)) return _textureCache.get(key);

  if (key === "square" || key === "capsule") {
    const graphics = buildPlaceholderTexture(key);
    const texture = PIXI.Texture.WHITE; // safe default; real generation below
    try {
      const generated = window.__zenginePixiApp
        ? window.__zenginePixiApp.renderer.generateTexture(graphics)
        : texture;
      _textureCache.set(key, generated);
      return generated;
    } catch (err) {
      _textureCache.set(key, texture);
      return texture;
    }
  }

  return PIXI.Texture.WHITE;
}

export function clearTextureCache() {
  _textureCache.clear();
}
