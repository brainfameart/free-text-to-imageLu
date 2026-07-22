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
 * and `this.rigidbody.velocity` always reflects the physics body's
 * real velocity.
 *
 * ONE API PER CAPABILITY: this.x/y/position/rotation/scaleX/scaleY/
 * translate/visible/enabled are flat shortcuts (Transform has only one
 * shape, and other.x/other.y is the documented pattern inside
 * onCollision(other)/onTriggerEnter(other)). Everything else —
 * velocity, physics forces, sprite properties, animation, camera,
 * audio, movement-type tunables (jump/car/follow settings) — is
 * reached ONLY through its sub-object (this.rigidbody.*, this.sprite.*,
 * this.animator.*, this.camera.*, this.audio.*, this.controller.*).
 * There is deliberately no this.velocityX / this.addForce() / this.
 * texture / this.isOnGround flat-shortcut duplicate of these:
 * RigidbodyAPI.js exposes a DIFFERENT shape per Rigidbody2D.bodyType
 * (Dynamic/Kinematic/Static), and ControllerAPI.js exposes a DIFFERENT
 * shape per CharacterController.controllerType (Character/Platformer/
 * Top-Down/Car/Follow/Free) — a second flat copy of either would have
 * to duplicate that per-type logic or drift out of sync with it, two
 * ways to do the same thing that could behave differently from each
 * other. See scripting/components/RigidbodyAPI.js and ControllerAPI.js.
 *
 * Each `this.<subobject>` (transform, sprite, rigidbody, animator,
 * camera, audio, controller) is built by its OWN file under
 * scripting/components/, not inlined here — that folder is where new
 * scripting components get added as the API grows (RULES.txt
 * scripting/ folder convention), keeping this file focused on wiring
 * rather than growing without bound.
 *
 * RUNTIME-ONLY FILE.
 */

import { TRANSFORM } from "../components/Transform.js";
import { SCRIPT } from "../components/Script.js";
import { COLLIDER_2D, ColliderShape } from "../components/Collider2D.js";
import { SPRITE_RENDERER } from "../components/SpriteRenderer.js";
import { RIGIDBODY_2D } from "../components/Rigidbody2D.js";
import { SPRITE_ANIMATION } from "../components/SpriteAnimation.js";
import { CAMERA } from "../components/Camera.js";
import { AUDIO_SOURCE } from "../components/AudioSource.js";
import { CHARACTER_CONTROLLER } from "../components/CharacterController.js";
import { createTransformAPI } from "./components/TransformAPI.js";
import { createSpriteAPI } from "./components/SpriteAPI.js";
import { createRigidbodyAPI } from "./components/RigidbodyAPI.js";
import { createAnimatorAPI } from "./components/AnimatorAPI.js";
import { createCameraAPI } from "./components/CameraAPI.js";
import { createAudioAPI } from "./components/AudioAPI.js";
import { createControllerAPI } from "./components/ControllerAPI.js";

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

  // Identity shortcuts — read the underlying Entity's name/tag (set in
  // the Hierarchy/Inspector, or via new Entity(name, tag)). Added so
  // onCollisionEnter(other)/onTriggerEnter(other) handlers can tell
  // WHAT they just touched ("if (other.tag === 'Obstacle') ...") —
  // previously EntityContext exposed no way at all to read an entity's
  // name or tag, even though Entity itself has always carried both.
  // name is read-only (an entity's identity isn't meant to be
  // rewritten at runtime); tag is read/write since re-tagging at
  // runtime is a normal gameplay pattern (e.g. marking a picked-up
  // item's tag as "Collected" so it's skipped by later checks).
  get name() { return this._entity.name; }
  get tag() { return this._entity.tag; }
  set tag(v) { this._entity.tag = v; }

  /**
   * Destroys this entity — removes it from the scene, exactly like
   * Unity's Destroy(gameObject). Safe to call from ANY lifecycle
   * method (onUpdate, onCollision, onTriggerEnter, even onStart) and
   * safe to call more than once (later calls are harmless no-ops).
   *
   * DEFERRED, not immediate — matches Unity's own Destroy() semantics
   * exactly: the entity is only actually removed at the END of this
   * frame (see World.js's queueDestroy()/flushDestroyed() and
   * ScriptSystem.js's update(), which calls flushDestroyed() after
   * every system has finished its pass for the frame). That means:
   *   - this.x, this.rigidbody.velocity, etc. all keep working
   *     normally for the REST of this frame after calling destroy() —
   *     the entity isn't half-torn-down mid-callback.
   *   - Other scripts' onCollision(other) firing later THIS SAME
   *     frame for this entity still receive a valid `other` context.
   *   - Starting next frame, the entity is gone: it won't appear in
   *     find()/scene.query(), its onUpdate/onFixedUpdate won't run,
   *     its Rapier physics body is removed, its Pixi sprite is
   *     removed, and onDestroy() fires on it exactly once right
   *     before it's actually removed.
   * If you need to know synchronously whether an entity is already
   * queued for removal (e.g. to avoid double-scoring a pickup two
   * scripts both collided with this same frame), check this.destroyed.
   */
  destroy() {
    this._world.queueDestroy(this._entity.id);
  }

  /** True once destroy() has been called on this entity (this frame or
   *  a callback later this same frame) but before it's actually been
   *  removed — see destroy()'s doc comment for the full deferred-
   *  removal timeline. Never true again after the entity is gone
   *  (there's no context left to read it from at that point). */
  get destroyed() {
    return this._world.isPendingDestroy(this._entity.id);
  }

  // NOTE: velocity, sprite (texture/color/flip/opacity), and rigidbody
  // physics (isGrounded, addForce, move, etc.) are intentionally NOT
  // duplicated here as this.<x> shortcuts. Each lives in exactly ONE
  // place: this.rigidbody.* (scripting/components/RigidbodyAPI.js) and
  // this.sprite.* (scripting/components/SpriteAPI.js). Rigidbody in
  // particular exposes a DIFFERENT shape per body type (Dynamic/
  // Kinematic/Static) — a flat this.addForce() shortcut here would
  // either have to duplicate that per-body-type logic or risk
  // diverging from it, giving scripts two ways to do the same thing
  // that could behave differently from one another. Use
  // this.rigidbody.addForce(), this.rigidbody.velocity,
  // this.sprite.texture, etc. instead. (this.x/y/position and friends
  // above stay as shortcuts because Transform has only one shape
  // regardless of entity state, and other.x/other.y in
  // onCollision(other) depends on them.)

  // --- Sub-objects (built once, read live data via closures) ---

  _buildSubObjects() {
    var entity = this._entity;

    // Transform is always present on every entity — always attach it.
    this.transform = createTransformAPI(entity);

    // Every other sub-object is attached ONLY when the entity actually has that
    // component. Absent sub-objects are undefined, so scripts can safely branch:
    //   if (this.rigidbody) { this.rigidbody.addForce(0, -500); }
    // This also means autocomplete correctly reflects what the object can do:
    // a Static-body entity won't offer addForce(), a sprite-less entity won't
    // offer this.sprite.texture, and so on — matching the Inspector exactly.
    this.sprite      = entity.hasComponent(SPRITE_RENDERER)     ? createSpriteAPI(entity)      : undefined;
    this.rigidbody   = entity.hasComponent(RIGIDBODY_2D)        ? createRigidbodyAPI(entity)   : undefined;
    this.animator    = entity.hasComponent(SPRITE_ANIMATION)    ? createAnimatorAPI(entity)    : undefined;
    this.camera      = entity.hasComponent(CAMERA)              ? createCameraAPI(entity)      : undefined;
    this.audio       = entity.hasComponent(AUDIO_SOURCE)        ? createAudioAPI(entity)       : undefined;
    // Movement-type-aware — ControllerAPI.js exposes isGrounded/simulateJump
    // ONLY for Character Controller/Platformer, car tunables ONLY for Car, etc.
    this.controller  = entity.hasComponent(CHARACTER_CONTROLLER)? createControllerAPI(entity)  : undefined;
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

    /**
     * Debug overlay state, driven by the `debug` global exposed to
     * scripts (see getGlobals() below). The play popup (play-popup.js)
     * polls `scriptApi.debugState` every frame to render/hide the HUD —
     * this class only tracks the data, it never touches the DOM itself
     * (ScriptAPI is shared by the editor too, which has no game HUD).
     */
    this.debugState = {
      enabled: false,
      showFps: true,
      stats: new Map(), // custom key -> value pairs from debug.log()
    };

    /** Set by createGame to enable scene.restart() */
    this._restartFn = null;
    /** Set by createGame to enable scene.load() */
    this._loadSceneFn = null;
    /** Set by ScriptSystem constructor to enable sendMessage(tag, msg, data) */
    this._sendMessageFn = null;
    /** Set by ScriptSystem constructor to enable broadcastMessage(msg, data) */
    this._broadcastMessageFn = null;

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
   * Drops the cached EntityContext for ONE entity id. Used when a
   * single entity is destroyed via this.destroy() (see EntityContext's
   * destroy() method and ScriptSystem.js's flushDestroyed handling) —
   * the rest of the scene keeps running, so a full clearContexts()
   * would be wrong here (it would drop every OTHER entity's live
   * context too); this only removes the one that no longer exists, for
   * the same reuse-safety reason clearContexts() exists at all.
   * @param {string} id
   */
  clearContext(id) {
    this._contexts.delete(id);
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
      /**
       * Send a message to all script instances on every entity that has
       * the given tag. Scripts that define `onMessage(message, sender, data)`
       * will be called immediately.
       *   sendMessage("Enemy", "takeDamage", { amount: 10 })
       */
      sendMessage: function(tag, message, data) {
        if (self._sendMessageFn) self._sendMessageFn(tag, message, data);
      },
      /**
       * Broadcast a message to ALL entities in the scene. Every script
       * instance that defines `onMessage(message, sender, data)` will be
       * called.
       *   broadcastMessage("gameOver", { winner: "Player" })
       */
      broadcastMessage: function(message, data) {
        if (self._broadcastMessageFn) self._broadcastMessageFn(message, data);
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
      /**
       * On-screen debug HUD, shown in the actual Play popup window (not
       * the editor Console panel). Call debug.show() from any script
       * (onStart is the usual place) to turn it on for the whole game —
       * it's global state, not per-entity, so any script can toggle it.
       *   debug.show()            — turn the HUD on, FPS counter visible
       *   debug.show(false)       — turn it off again
       *   debug.showFps(false)    — keep the HUD on but hide just the FPS line
       *   debug.log("label", val) — add/update a custom line in the HUD,
       *                              e.g. debug.log("Player HP", this.hp)
       *   debug.clear("label")    — remove a single custom line
       *   debug.clearAll()        — remove every custom line (FPS stays)
       */
      debug: {
        show: function (on) {
          self.debugState.enabled = on === undefined ? true : !!on;
        },
        showFps: function (on) {
          self.debugState.showFps = on === undefined ? true : !!on;
        },
        log: function (label, value) {
          self.debugState.stats.set(String(label), value);
        },
        clear: function (label) {
          self.debugState.stats.delete(String(label));
        },
        clearAll: function () {
          self.debugState.stats.clear();
        },
      },
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
