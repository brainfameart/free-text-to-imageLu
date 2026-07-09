/**
 * runtime/systems/AudioSystem.js
 *
 * Actually plays AudioSource components every frame — resolves each
 * entity's audioKey to a real dataUrl (via AssetManager.resolveAudioSrc)
 * and drives a plain HTMLAudioElement per entity, exactly like
 * RenderSystem drives a PIXI.Sprite per SpriteRenderer entity.
 *
 * Two behaviors (see components/AudioSource.js for the full rationale):
 *  - 2D: plays at a constant volume regardless of world position — the
 *    "Listener" (the active Main Camera) never affects it.
 *  - 3D: volume is scaled by distance from the Listener to the
 *    AudioSource entity's Transform — full volume inside minDistance,
 *    linearly silent by maxDistance.
 *
 * Only ever ticks while a game loop is actually running (Play mode /
 * the standalone player) — the editor's Scene viewport never calls
 * update() on this system while just editing, so placing/adjusting an
 * AudioSource never causes unwanted playback (matches Unity: audio
 * only plays in Play mode, never in the plain Scene-editing view).
 *
 * RUNTIME-ONLY FILE.
 */

import { TRANSFORM } from "../components/Transform.js";
import { AUDIO_SOURCE } from "../components/AudioSource.js";
import { CAMERA } from "../components/Camera.js";
import { resolveAudioSrc } from "../assets/AssetManager.js";

export class AudioSystem {
  constructor() {
    /** @type {Map<string, HTMLAudioElement>} entity id -> live element */
    this._elements = new Map();
    /** @type {Map<string, string>} entity id -> audioKey the element was built for */
    this._elementKeys = new Map();
  }

  /**
   * @param {import('../core/World.js').World} world
   */
  update(world) {
    const entities = world.query(TRANSFORM, AUDIO_SOURCE);
    const liveIds = new Set();

    const listener = this._findListener(world);

    for (const entity of entities) {
      liveIds.add(entity.id);
      const transform = entity.getComponent(TRANSFORM);
      const source = entity.getComponent(AUDIO_SOURCE);
      const el = this._ensureElement(entity.id, source);
      if (!el) {
        // audioKey is null/unknown (asset missing, key edited, or not
        // loaded yet in this module realm) — tear down any element a
        // PREVIOUS valid key already created for this entity, so a
        // clip doesn't keep looping/playing forever just because its
        // key later became invalid. Without this, only entities that
        // are fully removed from the world get cleaned up below;
        // an entity that stays alive but loses its audio would not.
        this._releaseElement(entity.id);
        continue;
      }

      const distanceVolume = source.is3D ? _distanceVolume(listener, transform, source) : 1;
      el.volume = Math.max(0, Math.min(1, source.volume * distanceVolume));

      if (source.autoplay && el.paused && el.readyState >= 2) {
        el.play().catch(() => {
          // Autoplay can be blocked until a user gesture happens
          // somewhere on the page (browser policy) — this is expected
          // right after Play mode starts from a toolbar click, so
          // silently retry next frame rather than logging noise.
        });
      }
      if (!source.autoplay && !el.paused) {
        el.pause();
      }
    }

    // Stop + release elements for entities that no longer have an
    // AudioSource (removed component / deleted entity), same cleanup
    // shape RenderSystem uses for stale sprites.
    for (const id of this._elements.keys()) {
      if (!liveIds.has(id)) this._releaseElement(id);
    }
  }

  _releaseElement(entityId) {
    const el = this._elements.get(entityId);
    if (!el) return;
    el.pause();
    el.src = "";
    this._elements.delete(entityId);
    this._elementKeys.delete(entityId);
  }

  _ensureElement(entityId, source) {
    const src = resolveAudioSrc(source.audioKey);
    if (!src) return null;

    const existingKey = this._elementKeys.get(entityId);
    let el = this._elements.get(entityId);

    if (!el || existingKey !== source.audioKey) {
      if (el) {
        el.pause();
        el.src = "";
      }
      el = new Audio(src);
      this._elements.set(entityId, el);
      this._elementKeys.set(entityId, source.audioKey);
    }

    el.loop = !!source.loop;
    return el;
  }

  /**
   * The Listener is always the scene's Main Camera Transform, same
   * "where the player currently is" reference RenderSystem uses for
   * camera-follow. Explicitly matches Camera.isMain (not just "the
   * first camera entity found") so multi-camera scenes attenuate 3D
   * audio against the actual active camera, not an arbitrary one.
   * Falls back to the first camera, then world origin, if no Main
   * Camera is flagged, so 3D falloff still computes something sane
   * instead of throwing.
   */
  _findListener(world) {
    const cameraEntities = world.query(TRANSFORM, CAMERA);
    if (!cameraEntities.length) return { x: 0, y: 0 };
    const main = cameraEntities.find((e) => e.getComponent(CAMERA).isMain);
    return (main || cameraEntities[0]).getComponent(TRANSFORM);
  }

  /**
   * Stops and releases every live element — called when the game/loop
   * is torn down (e.g. leaving Play mode) so background music doesn't
   * keep playing invisibly after the scene it belongs to is gone.
   */
  destroy() {
    for (const el of this._elements.values()) {
      el.pause();
      el.src = "";
    }
    this._elements.clear();
    this._elementKeys.clear();
  }
}

/**
 * Linear falloff: 1 (full volume) inside minDistance, 0 (silent) at or
 * beyond maxDistance, interpolated linearly in between. Simple and
 * predictable — matches the min/max-distance circles the editor draws
 * in AudioGizmo.js exactly, with no hidden curve to reconcile visually.
 */
function _distanceVolume(listener, transform, source) {
  const dx = transform.x - listener.x;
  const dy = transform.y - listener.y;
  const dist = Math.sqrt(dx * dx + dy * dy);
  const min = Math.max(0, source.minDistance);
  const max = Math.max(min + 0.001, source.maxDistance);
  if (dist <= min) return 1;
  if (dist >= max) return 0;
  return 1 - (dist - min) / (max - min);
}
