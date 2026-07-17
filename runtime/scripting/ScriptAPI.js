/**
 * runtime/scripting/ScriptAPI.js
 *
 * The safe sandbox API exposed to user game scripts. Scripts NEVER touch
 * World/Entity classes, browser globals (document, window, localStorage),
 * or any unrestricted object — they go through this API only.
 *
 * Two layers:
 *  1. Globals passed as function parameters to each compiled script:
 *     find(), scene, physics, input, time, random, global
 *  2. EntityContext — the `this` binding inside lifecycle functions:
 *     this.x, this.y, this.transform, this.sprite, this.rigidbody, etc.
 *
 * Property access uses getters/setters that read/write LIVE component
 * data, so a script doing `this.x = 100` immediately moves the entity
 * and `this.velocityX` always reflects the physics body's real velocity.
 *
 * Each `this.<subobject>` (transform, sprite, rigidbody, animator,
 * camera, audio) is built by its OWN file under scripting/components/,
 * not inlined here — that folder is where new scripting components get
 * added as the API grows (RULES.txt scripting/ folder convention),
 * keeping this file focused on wiring rather than growing without
 * bound. See scripting/components/RigidbodyAPI.js in particular: it
 * exposes a DIFFERENT API shape depending on the entity's actual
 * Rigidbody2D.bodyType (Dynamic/Kinematic/Static), rather than one
 * generic rigidbody object that silently no-ops for the wrong type.
 *
 * RUNTIME-ONLY FILE.
 */

import { TRANSFORM } from "../components/Transform.js";
import { RIGIDBODY_2D } from "../components/Rigidbody2D.js";
import { SCRIPT } from "../components/Script.js";
import { COLLIDER_2D, ColliderShape } from "../components/Collider2D.js";
import { SPRITE_RENDERER } from "../components/SpriteRenderer.js";
import { SPRITE_ANIMATION } from "../components/SpriteAnimation.js";
import { AUDIO_SOURCE } from "../components/AudioSource.js";
import { CAMERA } from "../components/Camera.js";
import { createTransformAPI } from "./components/TransformAPI.js";
import { createSpriteAPI } from "./components/SpriteAPI.js";
import { createRigidbodyAPI } from "./components/RigidbodyAPI.js";
import { createAnimatorAPI } from "./components/AnimatorAPI.js";
import { createCameraAPI } from "./components/CameraAPI.js";
import { createAudioAPI } from "./components/AudioAPI.js";

/**
 * The `this` context inside a user script. All property access reads
 * from / writes to the entity's live components.
 */
class EntityContext {
  constructor(entity, world) {
    this._entity = entity;
    this._world = world;
    this._buildSubObjects();
  }

  // --- Raycast support (used by physics.raycast) ---

  /** Returns the collider's world-space AABB for raycast testing. */
  _getColliderAABB() {
    var t = this._entity.getComponent(TRANSFORM);
    var c = this._entity.getComponent(COLLIDER_2D);
    if (!t || !c) return null;
    var cx = t.x + (c.offsetX || 0);
    var cy = t.y + (c.offsetY || 0);
    var minX, minY, maxX, maxY;
    if (c.shape === ColliderShape.BOX) {
      minX = cx - c.width / 2; maxX = cx + c.width / 2;
      minY = cy - c.height / 2; maxY = cy + c.height / 2;
    } else if (c.shape === ColliderShape.CIRCLE) {
      minX = cx - c.radius; maxX = cx + c.radius;
      minY = cy - c.radius; maxY = cy + c.radius;
    } else {
      var r = c.radius || (c.width || 1) / 2;
      minX = cx - r; maxX = cx + r;
      minY = cy - r; maxY = cy + r;
    }
    return { minX: minX, minY: minY, maxX: maxX, maxY: maxY };
  }

  // --- Shortcut aliases (read/write live Transform data) ---

  get x() { const t = this._entity.getComponent(TRANSFORM); return t ? t.x : 0; }
  set x(v) { const t = this._entity.getComponent(TRANSFORM); if (t) t.x = v; }

  get y() { const t = this._entity.getComponent(TRANSFORM); return t ? t.y : 0; }
  set y(v) { const t = this._entity.getComponent(TRANSFORM); if (t) t.y = v; }

  // position as an { x, y } object — mirrors this.transform.position
  get position() { const t = this._entity.getComponent(TRANSFORM); return t ? t.position : { x: 0, y: 0 }; }
  set position(v) { const t = this._entity.getComponent(TRANSFORM); if (t) t.position = v; }

  // translate — move by a delta amount this frame
  translate(dx, dy) { const t = this._entity.getComponent(TRANSFORM); if (t) t.translate(dx, dy); }

  get rotation() { const t = this._entity.getComponent(TRANSFORM); return t ? t.rotation : 0; }
  set rotation(v) { const t = this._entity.getComponent(TRANSFORM); if (t) t.rotation = v; }

  get scaleX() { const t = this._entity.getComponent(TRANSFORM); return t ? t.scaleX : 1; }
  set scaleX(v) { const t = this._entity.getComponent(TRANSFORM); if (t) t.scaleX = v; }

  get scaleY() { const t = this._entity.getComponent(TRANSFORM); return t ? t.scaleY : 1; }
  set scaleY(v) { const t = this._entity.getComponent(TRANSFORM); if (t) t.scaleY = v; }

  get visible() { return this._entity.active; }
  set visible(v) { this._entity.active = !!v; }

  get enabled() { const s = this._entity.getComponent(SCRIPT); return s ? s.enabled : true; }
  set enabled(v) { const s = this._entity.getComponent(SCRIPT); if (s) s.enabled = !!v; }

  get velocityX() { const r = this._entity.getComponent(RIGIDBODY_2D); return r ? r.velocityX : 0; }
  set velocityX(v) { const r = this._entity.getComponent(RIGIDBODY_2D); if (r) r.velocityX = v; }

  get velocityY() { const r = this._entity.getComponent(RIGIDBODY_2D); return r ? r.velocityY : 0; }
  set velocityY(v) { const r = this._entity.getComponent(RIGIDBODY_2D); if (r) r.velocityY = v; }

  // velocity as an { x, y } object — mirrors this.rigidbody.velocity
  get velocity() { this._requireRigidbody("velocity"); return this.rigidbody.velocity; }
  set velocity(v) { this._requireRigidbody("velocity"); this.rigidbody.velocity = v; }

  // --- Sprite shortcuts (throw if no Sprite Renderer — same error as this.sprite.X) ---

  get texture() { return this.sprite.texture; }
  set texture(v) { this.sprite.texture = v; }

  get color() { return this.sprite.color; }
  set color(v) { this.sprite.color = v; }

  get flipX() { return this.sprite.flipX; }
  set flipX(v) { this.sprite.flipX = v; }

  get flipY() { return this.sprite.flipY; }
  set flipY(v) { this.sprite.flipY = v; }

  get opacity() { return this.sprite.opacity; }
  set opacity(v) { this.sprite.opacity = v; }

  // --- Rigidbody shortcuts — throw if no Rigidbody 2D so the user
  //     sees a clear message rather than a silent 0/false return. ---

  _requireRigidbody(action) {
    if (!this._entity.hasComponent(RIGIDBODY_2D)) {
      throw new Error(
        "'" + (this._entity.name || "Entity") + "' called this." + action +
        " but has no Rigidbody 2D. Add one in the Inspector (Add Component → Rigidbody 2D)."
      );
    }
  }

  get isGrounded()  { this._requireRigidbody("isGrounded");  return this.rigidbody.isGrounded; }
  get isOnCeiling() { this._requireRigidbody("isOnCeiling"); return this.rigidbody.isOnCeiling; }
  get isOnWall()    { this._requireRigidbody("isOnWall");    return this.rigidbody.isOnWall; }
  get isOnSlope()   { this._requireRigidbody("isOnSlope");   return this.rigidbody.isOnSlope; }
  get groundAngle() { this._requireRigidbody("groundAngle"); return this.rigidbody.groundAngle; }

  addForce(x, y)   { this._requireRigidbody("addForce()");   return this.rigidbody.addForce(x, y); }
  addImpulse(x, y) { this._requireRigidbody("addImpulse()"); return this.rigidbody.addImpulse(x, y); }
  move(dx, dy)     { this._requireRigidbody("move()");       return this.rigidbody.move(dx, dy); }

  // --- Sub-objects (built once, read live data via closures) ---

  _buildSubObjects() {
    var entity = this._entity;

    this.transform = createTransformAPI(entity);
    this.sprite = createSpriteAPI(entity);
    this.rigidbody = createRigidbodyAPI(entity);
    this.animator = createAnimatorAPI(entity);
    this.camera = createCameraAPI(entity);
    this.audio = createAudioAPI(entity);
  }
}

export class ScriptAPI {
  /**
   * @param {import('../core/World.js').World} world
   */
  constructor(world) {
    this.world = world;
    this._globals = new Map();
    /** @type {Map<string, EntityContext>} cached per-entity contexts */
    this._contexts = new Map();

    // Input state
    this._keysDown = new Set();
    this._keysPressed = new Set();

    /** Updated by ScriptSystem each frame */
    this.time = { deltaTime: 0, elapsed: 0 };

    /** Set by createGame to enable scene.restart() */
    this._restartFn = null;
    /** Set by createGame to enable scene.load() */
    this._loadSceneFn = null;

    this._setupInput();
  }

  _setupInput() {
    if (typeof window === "undefined") return;
    var self = this;
    window.addEventListener("keydown", function (e) {
      // Track both e.key (e.g. " ", "a", "ArrowLeft") and e.code (e.g. "Space", "KeyA")
      if (!self._keysDown.has(e.code)) {
        self._keysPressed.add(e.code);
      }
      if (!self._keysDown.has(e.key)) {
        self._keysPressed.add(e.key);
      }
      self._keysDown.add(e.key);
      self._keysDown.add(e.code);
    });
    window.addEventListener("keyup", function (e) {
      self._keysDown.delete(e.key);
      self._keysDown.delete(e.code);
    });
    window.addEventListener("blur", function () {
      self._keysDown.clear();
    });
  }

  /** Called by ScriptSystem at the end of each frame. */
  _clearFrameKeys() {
    this._keysPressed.clear();
  }

  /**
   * Finds an entity by name and returns an EntityContext for it.
   * The returned object has the same .x, .y, .sprite, .rigidbody, etc.
   * properties as `this`, so scripts can interact with other objects.
   */
  find(name) {
    var entity = this.world.findFirstByName(name);
    if (!entity) return null;
    return this.createEntityContext(entity);
  }

  /**
   * Creates (or returns a cached) EntityContext for the given entity.
   */
  createEntityContext(entity) {
    if (this._contexts.has(entity.id)) {
      return this._contexts.get(entity.id);
    }
    var ctx = new EntityContext(entity, this.world);
    this._contexts.set(entity.id, ctx);
    return ctx;
  }

  /**
   * Drops every cached EntityContext. MUST be called whenever the World
   * is cleared/reloaded (scene.restart(), scene.load()) — entity ids get
   * reused after World.clear() resets its id counter (see
   * core/World.js), so without this a stale EntityContext from the
   * PREVIOUS (now-destroyed) Entity instance would keep being handed
   * back to scripts for the new entity that happens to share its id,
   * silently reading/writing dead component data instead of the fresh
   * scene's actual entities.
   */
  clearContexts() {
    this._contexts.clear();
  }

  /**
   * Raycasts a line segment against all collider entities. Returns the
   * closest hit as { entity, point: {x,y}, distance } or null.
   * Uses Liang-Barsky segment-vs-AABB intersection.
   */
  _raycast(x1, y1, x2, y2) {
    var entities = this.world.query(COLLIDER_2D);
    var bestHit = null;
    var bestT = 1;
    for (var i = 0; i < entities.length; i++) {
      var ctx = this.createEntityContext(entities[i]);
      var aabb = ctx._getColliderAABB();
      if (!aabb) continue;
      var t = _segmentAABB(x1, y1, x2, y2, aabb.minX, aabb.minY, aabb.maxX, aabb.maxY);
      if (t !== null && t < bestT) {
        bestT = t;
        bestHit = {
          entity: ctx,
          point: { x: x1 + (x2 - x1) * t, y: y1 + (y2 - y1) * t },
          distance: t,
        };
      }
    }
    return bestHit;
  }

  /**
   * Returns the global API object passed as function parameters to
   * each compiled script. Called once per script at compile time.
   */
  getGlobals() {
    var self = this;
    return {
      find: function (name) { return self.find(name); },
      scene: {
        find: function (name) { return self.find(name); },
        load: function (sceneName) {
          if (self._loadSceneFn) {
            self._loadSceneFn(sceneName);
          } else if (typeof console !== "undefined") {
            console.log("[ScriptAPI] scene.load('" + sceneName + "') — no scene manager available");
          }
        },
        restart: function () {
          if (self._restartFn) {
            self._restartFn();
          } else if (typeof console !== "undefined") {
            console.log("[ScriptAPI] scene.restart() — no scene manager available");
          }
        },
      },
      physics: {
        raycast: function (x1, y1, x2, y2) {
          return self._raycast(x1, y1, x2, y2);
        },
      },
      input: {
        keyDown: function (key) { return self._keysDown.has(key); },
        keyPressed: function (key) { return self._keysPressed.has(key); },
      },
      time: self.time,
      random: {
        /** Random integer in [min, max] inclusive. */
        int: function (min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; },
        /** Random float in [min, max). */
        float: function (min, max) { return Math.random() * (max - min) + min; },
      },
      global: new Proxy({}, {
        get: function (_, key) { return self._globals.get(key); },
        set: function (_, key, value) { self._globals.set(key, value); return true; },
        has: function (_, key) { return self._globals.has(key); },
      }),
    };
  }

  // --- Backwards-compatible methods (existing runtime/index.js uses these) ---

  findByName(name) { return this.find(name); }

  findByTag(tag) { return this.world.findByTag(tag); }

  setGlobal(key, value) { this._globals.set(key, value); }

  getGlobal(key) { return this._globals.has(key) ? this._globals.get(key) : undefined; }
}

/**
 * Liang-Barsky line-clipping algorithm: returns the parametric t (0–1)
 * at which the segment (x1,y1)→(x2,y2) enters the AABB, or null if
 * there's no intersection.
 */
function _segmentAABB(x1, y1, x2, y2, minX, minY, maxX, maxY) {
  var dx = x2 - x1;
  var dy = y2 - y1;
  var t0 = 0, t1 = 1;
  for (var edge = 0; edge < 4; edge++) {
    var p, q;
    if (edge === 0) { p = -dx; q = x1 - minX; }
    else if (edge === 1) { p = dx; q = maxX - x1; }
    else if (edge === 2) { p = -dy; q = y1 - minY; }
    else { p = dy; q = maxY - y1; }
    if (p === 0) {
      if (q < 0) return null;
    } else {
      var r = q / p;
      if (p < 0) {
        if (r > t1) return null;
        if (r > t0) t0 = r;
      } else {
        if (r < t0) return null;
        if (r < t1) t1 = r;
      }
    }
  }
  return t0;
}
