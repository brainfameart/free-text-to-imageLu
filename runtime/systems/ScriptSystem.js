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
 *   onCollision(other) — when this entity's collider touches another
 *   onTriggerEnter(other) — when entering a trigger collider
 *   onTriggerExit(other)  — when leaving a trigger collider
 *   onDestroy()       — once, when the entity is destroyed / scene ends
 *
 * If a script throws, the error is caught here, reported via the
 * error callback (wired to the editor's console via postMessage),
 * and the script instance is disabled so it doesn't spam errors
 * every frame. The editor itself never crashes.
 *
 * RUNTIME-ONLY FILE.
 */

import { SCRIPT } from "../components/Script.js";

const FIXED_TIMESTEP = 1 / 60;

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
  }

  /**
   * Sets a callback that receives { scriptName, message, line, method }.
   * The play popup wires this to postMessage back to the editor.
   */
  onError(cb) {
    this._errorCallback = cb;
  }

  _reportError(scriptName, err, methodName) {
    const message = err && err.message ? err.message : String(err);
    // Try to extract a line number from the error stack
    let line = "?";
    if (err && err.stack) {
      const m = err.stack.match(/<anonymous>:(\d+):(\d+)/);
      if (m) line = String(parseInt(m[1], 10) - 2); // offset for the wrapper preamble
    }
    if (this._errorCallback) {
      this._errorCallback({ scriptName, message, line, method: methodName || "?" });
    }
    if (typeof console !== "undefined") {
      console.error("[Script] " + scriptName + "." + (methodName || "?") + "(): " + message);
    }
  }

  /**
   * Compiles user source into a factory function. The factory is called
   * with ZenEngine globals as parameters, and returns an object with
   * whichever lifecycle handlers the user declared.
   */
  _compile(scriptName, source) {
    try {
      const factory = new Function(
        "find", "scene", "physics", "input", "time", "random", "global", "console", "Math",
        '"use strict";\n' + source + '\n' +
        "return {\n" +
        "  onStart: typeof onStart !== 'undefined' ? onStart : null,\n" +
        "  onUpdate: typeof onUpdate !== 'undefined' ? onUpdate : null,\n" +
        "  onFixedUpdate: typeof onFixedUpdate !== 'undefined' ? onFixedUpdate : null,\n" +
        "  onCollision: typeof onCollision !== 'undefined' ? onCollision : null,\n" +
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
          g.find, g.scene, g.physics, g.input, g.time, g.random, g.global,
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
          this._reportError(inst.scriptName, err, "onUpdate");
          inst.enabled = false;
        }
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
          inst.enabled = false;
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
      if (!inst.enabled || !inst.handlers.onCollision) continue;
      try {
        inst.handlers.onCollision.call(inst.context, otherContext);
      } catch (err) {
        this._reportError(inst.scriptName, err, "onCollision");
        inst.enabled = false;
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
        inst.enabled = false;
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
  }
}
