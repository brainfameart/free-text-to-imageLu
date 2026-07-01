/**
 * runtime/physics/RapierLoader.js
 *
 * Loads + initializes the Rapier2D WASM module exactly once (Rapier's
 * compat build ships its WASM inlined as base64, so this is a plain
 * dynamic import() + RAPIER.init() — no bundler/WASM-loader config
 * needed, matching this project's no-build-step setup). Cached as a
 * shared promise so every caller (editor Scene/Game viewport, the play
 * popup, the standalone player) gets back the SAME loaded module
 * without re-fetching or re-instantiating the WASM.
 *
 * RUNTIME-ONLY FILE.
 */

const RAPIER_CDN_URL = "https://cdn.jsdelivr.net/npm/@dimforge/rapier2d-compat@0.14.0/rapier.es.js";

let _loadPromise = null;

/**
 * @returns {Promise<typeof import('@dimforge/rapier2d-compat')>}
 */
export function loadRapier() {
  if (!_loadPromise) {
    _loadPromise = import(/* @vite-ignore */ RAPIER_CDN_URL).then(async (RAPIER) => {
      await RAPIER.init();
      return RAPIER;
    });
  }
  return _loadPromise;
}
