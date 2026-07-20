/**
 * runtime/systems/ScriptSystem.js
 *
 * Compiles and runs user scripts attached via the Script component.
 * Scripts are compiled with `new Function()` — they NEVER touch eval()
 * or the editor's scope. Each script's `this` is an EntityContext built
 * by ScriptAPI (see scripting/ScriptAPI.js), giving it safe access to
 * this.x, this.transform, this.sprite, find(), scene, physics, input,
 * time, random, and global.
 *
 * Lifecycle events called automatically:
 *   onStart()          — once, before the first onUpdate
 *   onUpdate(dt)       — every render frame
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
        "find", "scene", "physics", "input", "time", "random", "global", "debug", "console", "Math",
        '"use strict";\n' + source + '\n' +
        "return {\n" +
        "  onStart: typeof onStart !== 'undefined' ? onStart : null,\n" +
        "  onUpdate: typeof onUpdate !== 'undefined' ? onUpdate : null,\n" +
        "  onFixedUpdate: typeof onFixedUpdate !== 'undefined' ? onFixedUpdate : null,\n" +
        "  onCollision: typeof onCollision !== 'undefined' ? onCollision : null,\n" +
        "  onCollisionEnter: typeof onCollisionEnter !== 'undefined' ? onCollisionEnter : null,\n" +
        "  onCollisionExit: typeof onCollisionExit !== 'undefined' ? onCollisionExit : null,\n" +
        "  onTriggerEnter: typeof onTriggerEnter !== 'undefined' ? onTriggerEnter : null,\n" +
        "  onTriggerExit: typeof onTriggerExit !== 'undefined' ? onTriggerExit : null,\n" +
        "  onDestroy: typeof onDestroy !== 'undefined' ? onDestroy : null,\n" +
        "};\n"
      );
      return factory;
    } catch (err) {
      this._reportError(scriptName, err, "compile");
      return null;
    }
  }

  _initScripts(world) {
    const entities = world.query(SCRIPT);
    for (const entity of entities) {
      const script = entity.getComponent(SCRIPT);
      if (!script || !script.enabled || !script.source) continue;

      const factory = this._compile(script.scriptName, script.source);
      if (!factory) continue;

      try {
        const g = this.scriptApi.getGlobals();
        const handlers = factory(
          g.find, g.scene, g.physics, g.input, g.time, g.random, g.global, g.debug,
          console, Math
        );
        const context = this.scriptApi.createEntityContext(entity);

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

        if (inst.handlers.onStart) {
          try {
            inst.handlers.onStart.call(inst.context);
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
        } else {
          inst.started = true;
        }
      } catch (err) {
        this._reportError(script.scriptName, err, "init");
      }
    }
  }

  update(world, dt) {
    if (!this._started) {
      this._started = true;
      this._initScripts(world);
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

    // Clear per-frame input state (keyPressed only lasts one frame)
    if (this.scriptApi && this.scriptApi._clearFrameKeys) {
      this.scriptApi._clearFrameKeys();
    }

    // Regular update
    for (const [entityId, instances] of this.instances) {
      const entity = world.getEntity(entityId);
      if (!entity || !entity.active) continue;
      for (const inst of instances) {
        if (!inst.enabled || !inst.handlers.onUpdate) continue;
        try {
          inst.handlers.onUpdate.call(inst.context, dt);
        } catch (err) {
          // Do NOT disable the instance — skip just this frame's call.
          // The rest of the game (and this entity's other lifecycle
          // methods) keeps running; onUpdate is tried again next frame.
          this._reportError(inst.scriptName, err, "onUpdate");
        }
      }
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
   * entry and its cached EntityContext (scriptApi.clearContext) so
   * nothing keeps a stale reference once World.flushDestroyed() below
   * actually removes it — the same reuse-safety clearContexts() exists
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
              inst.handlers.onDestroy.call(inst.context);
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
    }
  }

  _tickFixed(world, fixedDt) {
    for (const [entityId, instances] of this.instances) {
      const entity = world.getEntity(entityId);
      if (!entity || !entity.active) continue;
      for (const inst of instances) {
        if (!inst.enabled || !inst.handlers.onFixedUpdate) continue;
        try {
          inst.handlers.onFixedUpdate.call(inst.context, fixedDt);
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
          inst.handlers.onCollision.call(inst.context, otherContext);
        } catch (err) {
          this._reportError(inst.scriptName, err, "onCollision");
        }
      }
      if (inst.handlers.onCollisionEnter) {
        try {
          inst.handlers.onCollisionEnter.call(inst.context, otherContext);
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
        inst.handlers.onCollisionExit.call(inst.context, otherContext);
      } catch (err) {
        this._reportError(inst.scriptName, err, "onCollisionExit");
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
        inst.handlers[handlerName].call(inst.context, otherContext);
      } catch (err) {
        this._reportError(inst.scriptName, err, handlerName);
      }
    }
  }

  destroy() {
    for (const [, instances] of this.instances) {
      for (const inst of instances) {
        if (inst.enabled && inst.handlers.onDestroy) {
          try {
            inst.handlers.onDestroy.call(inst.context);
          } catch (err) {
            this._reportError(inst.scriptName, err, "onDestroy");
          }
        }
      }
    }
    this.instances.clear();
    this._started = false;
    this._fixedAccumulator = 0;
    this._errorThrottle.clear();
  }
}
