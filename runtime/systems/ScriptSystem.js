/**
 * runtime/systems/ScriptSystem.js
 *
 * Compiles and runs user scripts attached via the Script component.
 * Scripts are compiled with `new Function()` — they NEVER touch eval()
 * or the editor's scope. Each script's `this` is an EntityContext built
 * by ScriptAPI (see scripting/ScriptAPI.js), giving it safe access to
 * this.x, this.transform, this.sprite, find(), scene, physics, input,
 * mouse, touch, time, random, and global.
 *
 * Lifecycle events called automatically:
 *   onStart()          — once, before the first onUpdate
 *   onClone()          — once, ONLY on entities created by spawn()
 *                         (see ScriptAPI.spawn()), called right
 *                         BEFORE onStart() on that same instance. Never
 *                         fires for entities loaded from the scene file.
 *   onUpdate(dt)       — every render frame
 *   onClick()          — the frame the mouse/a finger is pressed while
 *                         over this entity's collider (needs Collider2D)
 *   onFixedUpdate(dt)  — at a fixed 60 Hz timestep (accumulator)
 *   onCollision(other)      — when this entity's collider touches another (enter)
 *   onCollisionEnter(other) — alias for onCollision; prefer this for clarity
 *   onCollisionExit(other)  — when this entity's collider stops touching another
 *   onTriggerEnter(other)   — when entering a trigger collider
 *   onTriggerExit(other)    — when leaving a trigger collider
 *   onDestroy()       — once, when the entity is destroyed / scene ends
 *
 * FAULT ISOLATION: a thrown error inside one lifecycle CALL is caught
 * right there and reported — it does NOT disable the whole script
 * instance anymore (except onStart, see below). A bug in onUpdate this
 * frame just means this entity's onUpdate is skipped THIS frame; next
 * frame it's called again like normal. One bad line doesn't stop the
 * rest of the game, and doesn't even stop the rest of THIS script.
 * The only lifecycle that still disables the instance after a failure
 * is onStart: it only ever runs once, so there's nothing to "retry
 * next frame", and letting onUpdate run against state onStart never
 * finished setting up would likely just throw again immediately anyway.
 *
 * ERROR CLASSIFICATION: scripting/components/*API.js tag thrown Errors
 * with a machine-readable `err.kind` —
 *   "missing-component"     this.rigidbody/.sprite/etc but the entity
 *                            doesn't have that component at all
 *   "unsupported-body-type" e.g. this.rigidbody.addForce() on a
 *                            Kinematic/Static body
 *   "unknown-api"            this.rigidbody.addFrce() — property/method
 *                            that doesn't exist at all (a typo)
 * Anything without a `kind` (a plain script bug — null deref, bad
 * logic, etc.) is reported as "script-error". _formatError() below
 * turns each kind into a specific, actionable one-line message rather
 * than a generic "X is not a function".
 *
 * REPEAT THROTTLING: the same error firing every frame (e.g. an
 * onUpdate bug) would otherwise spam the console 60x/second. Identical
 * (script, method, message) errors are reported immediately once, then
 * suppressed and finally summarized with a repeat count — see
 * _shouldReport().
 *
 * RUNTIME-ONLY FILE.
 */

import { SCRIPT } from "../components/Script.js";

const FIXED_TIMESTEP = 1 / 60;

// After the first report, wait this many ms before reporting the same
// (script, method, message) combination again — as a "(x N times)"
// summary rather than a fresh spammy line every single frame.
const REPEAT_THROTTLE_MS = 3000;

export class ScriptSystem {
  /**
   * @param {import('../scripting/ScriptAPI.js').ScriptAPI} scriptApi
   */
  constructor(scriptApi) {
    this.scriptApi = scriptApi;
    /** @type {Map<string, Array<{handlers:object, context:object, scriptName:string, enabled:boolean, started:boolean}>>} */
    this.instances = new Map();
    this._started = false;
    this._fixedAccumulator = 0;
    /** @type {function|null} set by the play popup to receive error reports */
    this._errorCallback = null;
    /** @type {Map<string, {count:number, lastReportedAt:number}>} throttle state, keyed by "scriptName|method|message" */
    this._errorThrottle = new Map();
    /** @type {import('../core/World.js').World|null} current world, stashed at the top of update() */
    this._world = null;
    /** EntityContext of the lifecycle callback currently executing. */
    this._activeContext = null;
    /**
     * Pending wait() timers, keyed by the id of the entity that
     * SCHEDULED them (not necessarily the entity the callback touches —
     * scripts can close over `this` from another entity, same as any
     * other JS closure). One entity can have many timers in flight at
     * once (e.g. several wait() calls from different onUpdate frames),
     * so each entry is an array.
     * @type {Map<string, Array<{remaining:number, callback:function, context:object, id:number, cancelled:boolean}>>}
     */
    this._timers = new Map();
    /** Monotonically increasing id handed out by wait(), so scripts can
     *  cancelWait(id) a specific pending timer if they need to. Never
     *  reused within a single play session, even across restarts —
     *  simpler and safer than trying to recycle ids, and the numbers
     *  themselves carry no meaning scripts should rely on beyond
     *  uniqueness. */
    this._nextTimerId = 1;

    // Wire sendMessage / broadcastMessage into ScriptAPI's globals so
    // user scripts can call sendMessage(tag, msg, data) and
    // broadcastMessage(msg, data) without needing a direct reference to
    // ScriptSystem. The callbacks are set here (constructor) so they're
    // available the first time getGlobals() is called from _initScripts.
    const self = this;
    scriptApi._sendMessageFn = function(tag, message, data) {
      if (!self._world) return;
      const entities = self._world.findByTag ? self._world.findByTag(tag) : [];
      if (!entities) return;
      for (const e of entities) self.fireMessage(e.id, message, self._activeContext, data);
    };
    scriptApi._broadcastMessageFn = function(message, data) {
      if (!self._world) return;
      const entities = self._world.getAllEntities ? self._world.getAllEntities() :
        (self._world.entities ? [...self._world.entities.values()] : []);
      for (const e of entities) self.fireMessage(e.id, message, self._activeContext, data);
    };

    // Wire wait() / cancelWait() the same way — see _scheduleWait() and
    // _cancelWait() below for the full behavior (per-entity ownership,
    // auto-cancel on destroy/restart/scene-switch).
    scriptApi._waitFn = function(seconds, callback) {
      return self._scheduleWait(seconds, callback);
    };
    scriptApi._cancelWaitFn = function(timerId) {
      self._cancelWait(timerId);
    };
    // repeat() / cancelRepeat() — same timer mechanism as wait(), just
    // re-armed instead of removed each time it fires. See
    // _scheduleRepeat()'s doc comment below.
    scriptApi._repeatFn = function(seconds, callback) {
      return self._scheduleRepeat(seconds, callback);
    };
    scriptApi._cancelRepeatFn = function(timerId) {
      self._cancelRepeat(timerId);
    };
  }

  /**
   * Sets a callback that receives { scriptName, message, line, method, kind }.
   * The play popup wires this to postMessage back to the editor.
   */
  onError(cb) {
    this._errorCallback = cb;
  }

  /**
   * Turns a raw Error (possibly tagged with `.kind` by one of the
   * scripting/components/*API.js files) into a specific, actionable
   * message. Falls back to the error's own message for plain script
   * bugs (null deref, bad logic, etc.) that have no special kind.
   */
  _formatError(err, methodName) {
    const raw = err && err.message ? err.message : String(err);
    const kind = (err && err.kind) || "script-error";
    // The *API.js files already write a complete, specific sentence for
    // missing-component / unsupported-body-type / unknown-api — they
    // know exactly which object, which member, and why. Nothing to add.
    if (kind === "script-error" && methodName === "init") {
      const hint = this._topLevelThisHint(raw);
      if (hint) return { kind, message: raw + " " + hint };
    }
    return { kind, message: raw };
  }

  /**
   * Detects the most common beginner mistake that surfaces as an
   * "init" error: reading `this.<prop>` (this.x, this.sprite, etc.)
   * in top-level script code instead of inside a lifecycle function
   * like onStart/onUpdate.
   *
   * Top-level code runs once, immediately, when the script factory is
   * compiled and invoked to collect the lifecycle handlers — BEFORE
   * any handler is ever called with `.call(entityContext, ...)`. At
   * that point there is no entity `this` yet, so `this` is undefined
   * (scripts run in strict mode), and `this.x` throws exactly the
   * "Cannot read properties of undefined (reading 'x')" message this
   * matches on. Reported with method "init" by _initScripts() below,
   * since it happens outside any lifecycle call.
   *
   * Returns a one-line actionable hint, or null if the message doesn't
   * match this pattern (callers fall back to the raw message alone).
   */
  _topLevelThisHint(message) {
    const m = message.match(/Cannot read propert(?:y|ies) of undefined \(reading '([^']+)'\)/);
    if (!m) return null;
    const prop = m[1];
    const capProp = prop.charAt(0).toUpperCase() + prop.slice(1);
    return (
      "Hint: it looks like you're using \"this." + prop + "\" outside a " +
      "lifecycle function. \"this\" only refers to the entity INSIDE " +
      "functions like onStart() or onUpdate(dt) — not in code that runs " +
      "at the top of the script. Move \"this." + prop + "\" into onStart() " +
      "(runs once, before the first onUpdate) or onUpdate(), e.g.: " +
      "var start" + capProp + "; function onStart() { start" + capProp +
      " = this." + prop + "; }"
    );
  }

  _reportError(scriptName, err, methodName) {
    const { kind, message } = this._formatError(err, methodName);

    // Try to extract a line number from the error stack (only
    // meaningful for plain script-error bugs thrown from the user's
    // own compiled source — API errors point at engine code instead,
    // so their line is intentionally left as "?").
    let line = "?";
    if (kind === "script-error" && err && err.stack) {
      const m = err.stack.match(/<anonymous>:(\d+):(\d+)/);
      if (m) line = String(parseInt(m[1], 10) - 2); // offset for the wrapper preamble
    }

    const throttleKey = scriptName + "|" + (methodName || "?") + "|" + message;
    if (!this._shouldReport(throttleKey)) return;

    if (this._errorCallback) {
      this._errorCallback({ scriptName, message, line, method: methodName || "?", kind });
    }
    if (typeof console !== "undefined") {
      const where = "'" + scriptName + "'" + (line !== "?" ? " line " + line : "") + " (" + (methodName || "?") + "())";
      console.error("[Script] " + where + ": " + message);
    }
  }

  /**
   * Returns true if this exact (script, method, message) should be
   * reported now — true the first time, then throttled to at most once
   * per REPEAT_THROTTLE_MS while it keeps recurring (e.g. an onUpdate
   * bug firing every frame), with a "(repeated Nx)" note so repeats
   * aren't silently lost, just decluttered.
   */
  _shouldReport(key) {
    const now = Date.now();
    const entry = this._errorThrottle.get(key);
    if (!entry) {
      this._errorThrottle.set(key, { count: 1, lastReportedAt: now });
      return true;
    }
    entry.count++;
    if (now - entry.lastReportedAt >= REPEAT_THROTTLE_MS) {
      const repeats = entry.count - 1;
      entry.lastReportedAt = now;
      entry.count = 0;
      if (repeats > 0 && typeof console !== "undefined") {
        console.warn("[Script] (previous error above repeated " + repeats + " more time" + (repeats === 1 ? "" : "s") + " in the last " + Math.round(REPEAT_THROTTLE_MS / 1000) + "s)");
      }
      return true;
    }
    return false;
  }

  /**
   * Compiles user source into a factory function. The factory is called
   * with ZenEngine globals as parameters, and returns an object with
   * whichever lifecycle handlers the user declared.
   */
  _compile(scriptName, source) {
    try {
      const factory = new Function(
     "find", "scene", "physics", "input", "mouse", "touch", "time", "random", "global", "debug",
        "sendMessage", "broadcastMessage", "spawn", "wait", "cancelWait", "repeat", "cancelRepeat",
        "console", "Math",
        '"use strict";\n' + source + '\n' +
        "return {\n" +
        "  onStart: typeof onStart !== 'undefined' ? onStart : null,\n" +
        "  onUpdate: typeof onUpdate !== 'undefined' ? onUpdate : null,\n" +
        "  onClick: typeof onClick !== 'undefined' ? onClick : null,\n" +
        "  onFixedUpdate: typeof onFixedUpdate !== 'undefined' ? onFixedUpdate : null,\n" +
        "  onCollision: typeof onCollision !== 'undefined' ? onCollision : null,\n" +
        "  onCollisionEnter: typeof onCollisionEnter !== 'undefined' ? onCollisionEnter : null,\n" +
        "  onCollisionExit: typeof onCollisionExit !== 'undefined' ? onCollisionExit : null,\n" +
        "  onTriggerEnter: typeof onTriggerEnter !== 'undefined' ? onTriggerEnter : null,\n" +
        "  onTriggerExit: typeof onTriggerExit !== 'undefined' ? onTriggerExit : null,\n" +
        "  onMessage: typeof onMessage !== 'undefined' ? onMessage : null,\n" +
        "  onClone: typeof onClone !== 'undefined' ? onClone : null,\n" +
        "  onDestroy: typeof onDestroy !== 'undefined' ? onDestroy : null,\n" +
        "};\n"
      );
      return factory;
    } catch (err) {
      this._reportError(scriptName, err, "compile");
      return null;
    }
  }

  /**
   * Compiles + starts every Script instance on ONE entity. Shared by:
   *  - _initScripts() — the once-per-scene full pass over every SCRIPT
   *    entity present when the scene first starts.
   *  - _initNewInstances() — the lightweight per-frame pass that picks
   *    up any entity that DIDN'T exist yet at that first pass, i.e. one
   *    spawned at runtime via spawn() (see ScriptAPI.spawn),
   *    or any other Script-bearing entity created by engine code later.
   *
   * @param {import('../core/Entity.js').Entity} entity
   * @param {boolean} isClone true if this entity was created via
   *   spawn() — passed through so onClone() fires (and
   *   this.isClone reads true) for exactly those instances, matching
   *   Unity's convention that a runtime Instantiate()'d object's own
   *   scripts know they're a clone from their very first onStart().
   */
  _initEntityScripts(entity, isClone) {
    const script = entity.getComponent(SCRIPT);
    if (!script || !script.enabled || !script.source) return;

    const factory = this._compile(script.scriptName, script.source);
    if (!factory) return;

    try {
      const g = this.scriptApi.getGlobals();
      const handlers = factory(
        g.find, g.scene, g.physics, g.input, g.mouse, g.touch, g.time, g.random, g.global, g.debug,
        g.sendMessage, g.broadcastMessage, g.spawn, g.wait, g.cancelWait, g.repeat, g.cancelRepeat,
        console, Math
      );
      const context = this.scriptApi.createEntityContext(entity);
      if (isClone) context._isClone = true;

      if (!this.instances.has(entity.id)) {
        this.instances.set(entity.id, []);
      }
      const inst = {
        handlers,
        context,
        scriptName: script.scriptName,
        enabled: true,
        started: false,
      };
      this.instances.get(entity.id).push(inst);

      // onClone fires ONCE, right before onStart, and ONLY for clones —
      // same try/catch/disable behavior as onStart below, since like
      // onStart it only ever runs once and there's no "next frame" to
      // retry a botched onClone on.
      if (isClone && inst.handlers.onClone) {
        try {
          this._invoke(inst, inst.handlers.onClone);
        } catch (err) {
          this._reportError(script.scriptName, err, "onClone");
          inst.enabled = false;
        }
      }

      if (inst.enabled && inst.handlers.onStart) {
        try {
          this._invoke(inst, inst.handlers.onStart);
          inst.started = true;
        } catch (err) {
          // onStart only ever runs once — there's no "next frame" to
          // retry it on, and letting onUpdate run against state
          // onStart never got to set up would likely just throw
          // again immediately. This is the one case that still
          // disables the instance; every other lifecycle call below
          // recovers on its own next frame instead.
          this._reportError(script.scriptName, err, "onStart");
          inst.enabled = false;
        }
      } else if (inst.enabled) {
        inst.started = true;
      }
    } catch (err) {
      this._reportError(script.scriptName, err, "init");
    }
  }

  _initScripts(world) {
    const entities = world.query(SCRIPT);
    for (const entity of entities) {
      this._initEntityScripts(entity, false);
    }
  }

  /**
   * Runs every frame (cheap: world.query(SCRIPT) is already an O(n)
   * active-entity scan RenderSystem/PhysicsWorld both also do every
   * frame — no extra bookkeeping needed) and compiles/starts scripts
   * for any SCRIPT entity that isn't in `this.instances` yet. This is
   * what makes a clone's onClone()/onStart() actually fire: spawn()
   * only creates the Entity + components (see SceneSerializer.cloneEntity)
   * — it never touches ScriptSystem directly — so without this pass a
   * clone's Script component would sit there compiled-but-never-run
   * forever, since the one-time _initScripts() pass already happened
   * before the clone existed.
   *
   * Also naturally covers any OTHER runtime-created Script entity
   * (e.g. a future spawn path that doesn't go through spawn() at all) —
   * "not in this.instances yet" is the only condition that matters,
   * not how the entity came to exist.
   */
  _initNewInstances(world) {
    const entities = world.query(SCRIPT);
    for (const entity of entities) {
      if (this.instances.has(entity.id)) continue;
      this._initEntityScripts(entity, !!entity.__isClone);
    }
  }

  _invoke(inst, handler, ...args) {
    const previous = this._activeContext;
    this._activeContext = inst.context;
    try {
      return handler.call(inst.context, ...args);
    } finally {
      this._activeContext = previous;
    }
  }

  /**
   * Shared scheduling logic behind wait() and repeat() — the engine's
   * equivalent of a beginner-friendly setTimeout/setInterval, but one
   * that plays correctly with entities being destroyed and scenes
   * restarting/switching (a plain setTimeout/setInterval would happily
   * keep firing against an entity — or an entire scene — that no
   * longer exists).
   *
   * ONE-SHOT vs REPEATING: `interval === null` means wait()'s "run
   * once" behavior — the timer is removed after it fires. A number
   * means repeat()'s "run every N seconds forever" behavior — see
   * _tickTimers() below for how re-arming works.
   *
   * OWNERSHIP: a timer is tied to whichever entity's script called
   * wait()/repeat() — read from this._activeContext, the same "who's
   * currently running" tracking _invoke() already maintains for every
   * other lifecycle call. That entity is the timer's owner:
   *   - if the OWNER is destroyed (this.destroy()) before the timer
   *     fires (or fires again, for repeat()), the timer is cancelled —
   *     see _flushDestroyed()'s call into _cancelTimersForEntity()
   *     below.
   *   - if the SCENE restarts or switches, ALL timers are cancelled —
   *     see destroy() below, the same whole-scene teardown that
   *     already clears every script instance.
   * Either way the callback simply never runs again; nothing throws,
   * nothing needs to check this.destroyed inside the callback itself.
   *
   * The callback runs with `this` bound to the OWNER's own
   * EntityContext (via _invoke, same as onUpdate/onStart/etc.), so
   * `this.x`, this.destroy(), this.wait(...) all work naturally inside
   * it, exactly like any other lifecycle method:
   *   function onStart() {
   *     wait(2, function () { this.visible = false; });
   *   }
   *
   * A timer scheduled from OUTSIDE any lifecycle call (e.g. accidentally
   * at top-level script scope, where there's no "current" entity) is
   * silently ignored, with a console warning — the same "no active
   * entity" situation this.destroy() and other this.* calls already
   * guard against elsewhere in this file.
   *
   * @param {number} seconds must be >= 0; 0 fires on the very next update()
   * @param {function} callback
   * @param {number|null} interval seconds between repeats (repeat()), or null for a one-shot (wait())
   * @returns {number} a timer id you can pass to cancelWait()/cancelRepeat(),
   *   or -1 if there was no active entity to own the timer
   */
  _scheduleTimer(seconds, callback, interval) {
    if (typeof callback !== "function") {
      if (typeof console !== "undefined") {
        const fnName = interval == null ? "wait" : "repeat";
        console.warn(`[${fnName}] second argument must be a function, e.g. ${fnName}(2, function() { ... })`);
      }
      return -1;
    }
    const context = this._activeContext;
    if (!context) {
      if (typeof console !== "undefined") {
        const fnName = interval == null ? "wait" : "repeat";
        console.warn(`[${fnName}] called outside a lifecycle function (onStart/onUpdate/etc.) — ignored, there's no entity to run it on`);
      }
      return -1;
    }
    const entityId = context._entity.id;
    const timer = {
      remaining: Math.max(0, Number(seconds) || 0),
      interval: interval == null ? null : Math.max(0, Number(interval) || 0),
      callback,
      context,
      id: this._nextTimerId++,
      cancelled: false,
    };
    if (!this._timers.has(entityId)) this._timers.set(entityId, []);
    this._timers.get(entityId).push(timer);
    return timer.id;
  }

  /** One-shot form — see _scheduleTimer()'s doc comment above for the
   *  full ownership/cancellation contract shared with repeat(). */
  _scheduleWait(seconds, callback) {
    return this._scheduleTimer(seconds, callback, null);
  }

  /**
   * Schedules `callback` to run every `seconds`, starting `seconds`
   * from now (same beat as Unity's InvokeRepeating with equal delay
   * and interval) — the beginner-friendly way to do "spawn an enemy
   * every 2 seconds" without hand-writing a self-rescheduling wait():
   *   function onStart() {
   *     repeat(2, function () {
   *       spawn("Enemy", { x: random.int(0, 800), y: 0 });
   *     });
   *   }
   * Runs FOREVER until you call cancelRepeat(id)/this.cancelRepeat(id),
   * the owning entity is destroyed, or the scene restarts/switches —
   * exactly the same auto-cancellation rules as wait(), since this is
   * literally the same timer mechanism underneath, just re-armed
   * instead of removed each time it fires. There is deliberately no
   * separate "forever loop" construct in this engine beyond onUpdate()
   * and repeat() — a real infinite loop (while(true)) would freeze the
   * tab, since scripts run synchronously within a single frame with no
   * yield point for the engine to keep rendering.
   * @param {number} seconds interval between calls, and also the delay before the first one
   * @param {function} callback
   * @returns {number} timer id usable with cancelRepeat()
   */
  _scheduleRepeat(seconds, callback) {
    return this._scheduleTimer(seconds, callback, seconds);
  }

  /**
   * Cancels a single pending timer by the id wait()/repeat() returned.
   * Works on BOTH kinds — a one-shot wait() or an ongoing repeat() —
   * since they're the same underlying timer object. Safe to call with
   * an id that already fired (wait()) or was already cancelled — a
   * no-op in both cases, same as the DOM's clearTimeout/clearInterval.
   * @param {number} timerId
   */
  _cancelWait(timerId) {
    for (const list of this._timers.values()) {
      for (const timer of list) {
        if (timer.id === timerId) {
          timer.cancelled = true;
          return;
        }
      }
    }
  }

  /** Alias of _cancelWait — cancelRepeat() and cancelWait() are
   *  literally the same operation under the hood (both just flag the
   *  timer as cancelled), kept as two names purely so repeat()'s API
   *  reads symmetrically with wait()'s rather than mixing vocabulary. */
  _cancelRepeat(timerId) {
    this._cancelWait(timerId);
  }

  /**
   * Cancels every pending timer owned by ONE entity — called from
   * _flushDestroyed() when that entity's own this.destroy() goes
   * through, so a wait() scheduled by a script never fires against an
   * entity (or reads a `this`) that's already gone.
   * @param {string} entityId
   */
  _cancelTimersForEntity(entityId) {
    this._timers.delete(entityId);
  }

  /**
   * Advances every pending timer by dt and fires any whose time is up.
   * Called once per frame from update(), after the regular onUpdate
   * pass — matches Unity's Invoke()/coroutine timing, which also
   * resolve after that frame's Update() has run.
   *
   * A ONE-SHOT timer (wait(), timer.interval === null) is removed once
   * it fires. A REPEATING timer (repeat(), timer.interval is a number)
   * is instead RE-ARMED with `remaining = interval` and kept — same
   * timer object, same id, so a cancelRepeat(id) issued at any point
   * still finds and stops it. Re-arming happens AFTER the callback
   * runs, so if that callback itself calls cancelRepeat() on its own
   * timer (or this.destroy()s its own entity), we check `cancelled`
   * again — and that the entity's timer list still exists at all —
   * before putting it back, rather than resurrecting a timer someone
   * just asked to stop.
   *
   * A timer firing is allowed to schedule ANOTHER wait()/repeat()
   * (including from inside its own callback) — that new timer simply
   * lands in next frame's pass. Iterates over a COPY of each entity's
   * list before writing the surviving ones back, so a callback that
   * itself calls wait()/repeat() again doesn't mutate the array while
   * this loop is still reading it.
   */
  _tickTimers(dt) {
    if (this._timers.size === 0) return;
    for (const [entityId, list] of this._timers) {
      const stillPending = [];
      for (const timer of list) {
        if (timer.cancelled) continue;
        timer.remaining -= dt;
        if (timer.remaining > 0) {
          stillPending.push(timer);
          continue;
        }
        const fnName = timer.interval == null ? "wait" : "repeat";
        try {
          timer.callback.call(timer.context);
        } catch (err) {
          this._reportError(
            (timer.context && timer.context._entity && timer.context._entity.name) || fnName + "()",
            err,
            fnName
          );
          // An erroring repeat() callback would just throw again next
          // interval forever, spamming the error log — stop it here,
          // same call _initEntityScripts makes for a bad onStart.
          continue;
        }
        // Re-arm if this is a repeat() timer that wasn't cancelled (or
        // its owning entity destroyed) from inside the callback itself.
        if (timer.interval != null && !timer.cancelled && this._timers.has(entityId)) {
          timer.remaining = timer.interval;
          stillPending.push(timer);
        }
      }
      if (stillPending.length > 0) {
        this._timers.set(entityId, stillPending);
      } else {
        this._timers.delete(entityId);
      }
    }
  }

  update(world, dt) {
    // Stash world reference so sendMessage / broadcastMessage callbacks
    // (wired up in the constructor) can reach the entity list at call time.
    this._world = world;

    if (!this._started) {
      this._started = true;
      this._initScripts(world);
    } else {
      // Picks up any Script entity that didn't exist during the pass
      // above — i.e. anything spawned at runtime via spawn()
      // since last frame. Skipped on the very first frame itself since
      // _initScripts() just did the identical work for the whole scene.
      this._initNewInstances(world);
    }

    // Update time
    this.scriptApi.time.deltaTime = dt;
    this.scriptApi.time.elapsed += dt;

    // Fixed update accumulator
    this._fixedAccumulator += dt;
    while (this._fixedAccumulator >= FIXED_TIMESTEP) {
      this._tickFixed(world, FIXED_TIMESTEP);
      this._fixedAccumulator -= FIXED_TIMESTEP;
    }

    // Regular update
    for (const [entityId, instances] of this.instances) {
      const entity = world.getEntity(entityId);
      if (!entity || !entity.active) continue;
      for (const inst of instances) {
        if (!inst.enabled || !inst.handlers.onUpdate) continue;
        try {
          this._invoke(inst, inst.handlers.onUpdate, dt);
        } catch (err) {
          // Do NOT disable the instance — skip just this frame's call.
          // The rest of the game (and this entity's other lifecycle
          // methods) keeps running; onUpdate is tried again next frame.
          this._reportError(inst.scriptName, err, "onUpdate");
        }
      }
    }

    // onClick — fires on whichever entities were actually under the
    // pointer the SAME frame the (left) mouse button/a finger went
    // down. Only runs the real hit-test query when a click actually
    // happened this frame (mouse.pressed(0) is a one-frame pulse) —
    // no per-entity physics query on every ordinary frame, since a
    // click is a comparatively rare event next to onUpdate running
    // every single frame regardless.
    if (this.scriptApi && this.scriptApi._mouse && this.scriptApi._mouse.buttonsPressed.has(0)) {
      const clicked = this.scriptApi._entitiesAtPoint(this.scriptApi._mouse.x, this.scriptApi._mouse.y);
      for (const ctx of clicked) {
        const entityId = ctx._entity.id;
        const instances = this.instances.get(entityId);
        if (!instances) continue;
        for (const inst of instances) {
          if (!inst.enabled || !inst.handlers.onClick) continue;
          try {
            this._invoke(inst, inst.handlers.onClick);
          } catch (err) {
            this._reportError(inst.scriptName, err, "onClick");
          }
        }
      }
    }

    // Fire any wait() timers whose time is up. Runs AFTER the regular
    // onUpdate pass (matches Unity's own Invoke()/coroutine timing) but
    // BEFORE _flushDestroyed() below, so a timer callback that calls
    // this.destroy() is picked up by the SAME frame's destroy flush
    // rather than sitting half-destroyed until next frame.
    this._tickTimers(dt);

    // Clear per-frame input state (keyPressed only lasts one frame).
    //
    // BUG FIX — ORDERING: this used to run BEFORE the onUpdate loop
    // above (right after the fixed-update accumulator), which meant
    // input.keyPressed(key) was already wiped back to false by the time
    // ANY script's onUpdate() ran — the single most commonly used
    // per-frame callback. A script doing
    //   if (input.keyPressed("Space")) this.controller.simulateJump();
    // inside onUpdate would never see a true, because this line had
    // already cleared it moments earlier in the very same frame; only
    // onFixedUpdate (which runs BEFORE this point) ever had a chance to
    // observe a one-shot key press. Moved to the end of the frame — after
    // onUpdate — so BOTH onFixedUpdate and onUpdate observe the same
    // keyPressed state for the entire frame the key was actually pressed
    // on, and it's cleared only once every lifecycle callback has had
    // its turn.
    if (this.scriptApi && this.scriptApi._clearFrameKeys) {
      this.scriptApi._clearFrameKeys();
    }

    // Actually remove every entity queued this frame via this.destroy()
    // (see ScriptAPI.js's EntityContext.destroy()) — done LAST, after
    // every system (controller/physics/animation/render/this system's
    // own onUpdate above) has already had its pass for the frame, so
    // nothing reads a half-destroyed entity mid-frame. This is also
    // where onDestroy() actually fires for a per-entity destroy() call
    // (as opposed to a whole-scene teardown, which fires it via this
    // class's own destroy() method instead — see that method's doc
    // comment).
    this._flushDestroyed(world);
  }

  /**
   * Removes every entity queued via this.destroy() this frame: fires
   * onDestroy on that entity's own script instances (same try/catch/
   * report pattern as every other lifecycle call — a buggy onDestroy
   * doesn't stop the rest of cleanup), then drops its instances Map
   * entry and its cached EntityContext (scriptApi.clearContext), and
   * cancels any pending wait() timers it owns, so nothing keeps a stale
   * reference once World.flushDestroyed() below actually removes it —
   * the same reuse-safety clearContexts() exists
   * for on a whole-scene reload, just scoped to one entity here.
   * World.flushDestroyed() itself removes the entity from
   * world.entities; PhysicsWorld.step() and RenderSystem.update()
   * (next frame) then notice it's gone from their queries the same way
   * they already do for any entity removed via the editor's Delete —
   * no separate physics/render cleanup call is needed here.
   */
  _flushDestroyed(world) {
    const removedEntities = world.flushDestroyed();
    if (removedEntities.length === 0) return;
    for (const entity of removedEntities) {
      const instances = this.instances.get(entity.id);
      if (instances) {
        for (const inst of instances) {
          if (inst.enabled && inst.handlers.onDestroy) {
            try {
              this._invoke(inst, inst.handlers.onDestroy);
            } catch (err) {
              this._reportError(inst.scriptName, err, "onDestroy");
            }
          }
        }
        this.instances.delete(entity.id);
      }
      if (this.scriptApi && this.scriptApi.clearContext) {
        this.scriptApi.clearContext(entity.id);
      }
      // Any wait() this entity scheduled (and hasn't fired yet) dies
      // with it — see _scheduleWait()'s doc comment for why this
      // matters: without this, a timer started by an entity that gets
      // destroyed mid-countdown would still fire later against a
      // `this` that no longer exists in the world.
      this._cancelTimersForEntity(entity.id);
    }
  }

  _tickFixed(world, fixedDt) {
    for (const [entityId, instances] of this.instances) {
      const entity = world.getEntity(entityId);
      if (!entity || !entity.active) continue;
      for (const inst of instances) {
        if (!inst.enabled || !inst.handlers.onFixedUpdate) continue;
        try {
          this._invoke(inst, inst.handlers.onFixedUpdate, fixedDt);
        } catch (err) {
          this._reportError(inst.scriptName, err, "onFixedUpdate");
        }
      }
    }
  }

  /**
   * Called by PhysicsSystem when two entities collide. The ScriptSystem
   * forwards the event to each entity's onCollision handler with an
   * EntityContext for the other entity.
   */
  fireCollision(entityId, otherEntity, world) {
    const instances = this.instances.get(entityId);
    if (!instances) return;
    const otherContext = otherEntity ? this.scriptApi.createEntityContext(otherEntity) : null;
    for (const inst of instances) {
      if (!inst.enabled) continue;
      // Fire onCollision (legacy) and onCollisionEnter (preferred alias)
      if (inst.handlers.onCollision) {
        try {
            this._invoke(inst, inst.handlers.onCollision, otherContext);
        } catch (err) {
          this._reportError(inst.scriptName, err, "onCollision");
        }
      }
      if (inst.handlers.onCollisionEnter) {
        try {
            this._invoke(inst, inst.handlers.onCollisionEnter, otherContext);
        } catch (err) {
          this._reportError(inst.scriptName, err, "onCollisionEnter");
        }
      }
    }
  }

  fireCollisionExit(entityId, otherEntity, world) {
    const instances = this.instances.get(entityId);
    if (!instances) return;
    const otherContext = otherEntity ? this.scriptApi.createEntityContext(otherEntity) : null;
    for (const inst of instances) {
      if (!inst.enabled || !inst.handlers.onCollisionExit) continue;
      try {
        this._invoke(inst, inst.handlers.onCollisionExit, otherContext);
      } catch (err) {
        this._reportError(inst.scriptName, err, "onCollisionExit");
      }
    }
  }

  /**
   * Delivers a message to all script instances on a single entity.
   * Called by sendMessage() / broadcastMessage() (wired via ScriptAPI).
   *
   * @param {string}      entityId      target entity
   * @param {string}      message       arbitrary message name
   * @param {object|null} senderContext EntityContext of the sending entity (or null for broadcast)
   * @param {*}           data          optional payload
   */
  fireMessage(entityId, message, senderContext, data) {
    const instances = this.instances.get(entityId);
    if (!instances) return;
    for (const inst of instances) {
      if (!inst.enabled || !inst.handlers.onMessage) continue;
      try {
        if (inst.handlers.onMessage.length >= 3) {
          this._invoke(inst, inst.handlers.onMessage, message, senderContext, data);
        } else if (inst.handlers.onMessage.length === 2) {
          this._invoke(inst, inst.handlers.onMessage, message, data);
        } else {
          this._invoke(inst, inst.handlers.onMessage, message);
        }
      } catch (err) {
        this._reportError(inst.scriptName, err, "onMessage");
      }
    }
  }

  fireTrigger(entityId, otherEntity, world, isEnter) {
    const instances = this.instances.get(entityId);
    if (!instances) return;
    const otherContext = otherEntity ? this.scriptApi.createEntityContext(otherEntity) : null;
    const handlerName = isEnter ? "onTriggerEnter" : "onTriggerExit";
    for (const inst of instances) {
      if (!inst.enabled || !inst.handlers[handlerName]) continue;
      try {
        this._invoke(inst, inst.handlers[handlerName], otherContext);
      } catch (err) {
        this._reportError(inst.scriptName, err, handlerName);
      }
    }
  }

  /**
   * Whole-scene teardown, called by runtime/index.js on BOTH scene
   * restart and scene switch — fires onDestroy for every remaining
   * script instance (a restarting/switching scene still means every
   * entity in it is going away), then wipes every timer regardless of
   * which entity owns it: unlike the single-entity case in
   * _flushDestroyed(), there's no "still running" entity left to check
   * against here — the ENTIRE world is being torn down, so every
   * pending wait() everywhere is cancelled unconditionally. Without
   * this, a wait(10, ...) started just before a restart would still be
   * sitting in this._timers and fire 10 seconds later against a
   * `this` from the OLD scene, even though the player is now several
   * seconds into a brand new one.
   */
  destroy() {
    for (const [, instances] of this.instances) {
      for (const inst of instances) {
        if (inst.enabled && inst.handlers.onDestroy) {
          try {
            this._invoke(inst, inst.handlers.onDestroy);
          } catch (err) {
            this._reportError(inst.scriptName, err, "onDestroy");
          }
        }
      }
    }
    this.instances.clear();
    this._timers.clear();
    this._started = false;
    this._fixedAccumulator = 0;
    this._activeContext = null;
    this._errorThrottle.clear();
  }
}
