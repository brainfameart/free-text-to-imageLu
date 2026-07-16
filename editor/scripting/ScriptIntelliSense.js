/**
 * editor/scripting/ScriptIntelliSense.js
 *
 * Registers a Monaco completion provider for ZenEngine scripting APIs.
 * Completions are context-aware: typing `this.` shows only the
 * properties/components valid for the object the active script was
 * opened from. When a script is shared by several objects (opened
 * from the Scripts folder), the union of every owning object's
 * components is offered so every property stays valid no matter which
 * object runs it.
 *
 * Typing a global name shows only safe engine APIs (never document,
 * window, localStorage, etc.).
 *
 * EDITOR-ONLY FILE.
 */

import { editorState } from "../state/EditorState.js";
import { TRANSFORM } from "../../runtime/components/Transform.js";
import { SPRITE_RENDERER } from "../../runtime/components/SpriteRenderer.js";
import { RIGIDBODY_2D, BodyType } from "../../runtime/components/Rigidbody2D.js";
import { CAMERA } from "../../runtime/components/Camera.js";
import { AUDIO_SOURCE } from "../../runtime/components/AudioSource.js";
import { SPRITE_ANIMATION } from "../../runtime/components/SpriteAnimation.js";

let _registered = false;

// API definitions for each component sub-object
const TRANSFORM_API = [
  { label: "position", detail: "{ x, y } — position vector", insert: "position" },
  { label: "translate(dx, dy)", detail: "Move by delta", insert: "translate(" },
  { label: "lookAt(x, y)", detail: "Rotate to face a point", insert: "lookAt(" },
];
const SPRITE_API = [
  { label: "texture", detail: "Sprite texture key", insert: "texture" },
  { label: "color", detail: "Tint color (#rrggbb)", insert: 'color = "#' },
  { label: "opacity", detail: "0.0 – 1.0", insert: "opacity = " },
  { label: "flipX", detail: "Flip horizontally", insert: "flipX = " },
  { label: "flipY", detail: "Flip vertically", insert: "flipY = " },
];

// Rigidbody scripting API is SPLIT PER BODY TYPE, matching
// runtime/scripting/components/RigidbodyAPI.js: a Dynamic body gets
// forces/impulses (Rapier's solver owns it), a Kinematic body gets
// velocity-drive + move() + grounded (Rapier never applies forces to
// it), and a Static body gets almost nothing (it never moves by
// definition). This is what stops the editor from ever suggesting
// `rigidbody.addForce(...)` on a Kinematic/Static object in the first
// place, instead of letting the user type something that throws at
// runtime.
const RIGIDBODY_API_COMMON = [
  { label: "velocity", detail: "{ x, y } — velocity vector (read-only on Static)", insert: "velocity" },
  { label: "type", detail: "'Dynamic' | 'Kinematic' | 'Static'", insert: "type" },
];
const RIGIDBODY_API_DYNAMIC = RIGIDBODY_API_COMMON.concat([
  { label: "velocityX", detail: "Horizontal velocity", insert: "velocityX = " },
  { label: "velocityY", detail: "Vertical velocity", insert: "velocityY = " },
  { label: "mass", detail: "Body mass", insert: "mass = " },
  { label: "gravityScale", detail: "Gravity multiplier", insert: "gravityScale = " },
  { label: "linearDamping", detail: "Linear drag", insert: "linearDamping = " },
  { label: "angularDamping", detail: "Angular drag", insert: "angularDamping = " },
  { label: "addForce(x, y)", detail: "Continuous force — call every frame to sustain a push", insert: "addForce(" },
  { label: "addImpulse(x, y)", detail: "Instant velocity change, applied once", insert: "addImpulse(" },
  { label: "addTorque(t)", detail: "Continuous rotational force — call every frame to sustain a spin", insert: "addTorque(" },
  { label: "addAngularImpulse(t)", detail: "Instant angular velocity change, applied once", insert: "addAngularImpulse(" },
]);
const RIGIDBODY_API_KINEMATIC = RIGIDBODY_API_COMMON.concat([
  { label: "velocityX", detail: "Horizontal velocity (drives movement)", insert: "velocityX = " },
  { label: "velocityY", detail: "Vertical velocity (drives movement)", insert: "velocityY = " },
  { label: "move(dx, dy)", detail: "One-shot swept move this frame, blocked/slid by obstacles", insert: "move(" },
  { label: "grounded", detail: "Real sweep-based ground contact (read-only)", insert: "grounded" },
  { label: "resolvedVelocity", detail: "{ x, y } — actual movement achieved last step (read-only)", insert: "resolvedVelocity" },
]);
const RIGIDBODY_API_STATIC = [
  { label: "type", detail: "'Static' — this body never moves. Change Body Type in the Inspector to move it.", insert: "type" },
];
const ANIMATOR_API = [
  { label: "play(clipName)", detail: "Play an animation clip", insert: 'play("' },
  { label: "stop()", detail: "Stop current animation", insert: "stop()" },
];
const CAMERA_API = [
  { label: "zoom", detail: "Camera zoom level", insert: "zoom = " },
  { label: "shake(intensity, duration)", detail: "Shake the camera", insert: "shake(" },
];
const AUDIO_API = [
  { label: "play()", detail: "Play audio source", insert: "play()" },
  { label: "stop()", detail: "Stop audio", insert: "stop()" },
];

const THIS_SHORTCUTS = [
  { label: "x", detail: "Position X (alias for transform.x)", insert: "x" },
  { label: "y", detail: "Position Y (alias for transform.y)", insert: "y" },
  { label: "rotation", detail: "Rotation in degrees", insert: "rotation = " },
  { label: "scaleX", detail: "Scale X", insert: "scaleX = " },
  { label: "scaleY", detail: "Scale Y", insert: "scaleY = " },
  { label: "visible", detail: "Is entity visible", insert: "visible = " },
  { label: "enabled", detail: "Is this script enabled", insert: "enabled = " },
  { label: "velocityX", detail: "Velocity X (alias for rigidbody.velocityX)", insert: "velocityX = " },
  { label: "velocityY", detail: "Velocity Y (alias for rigidbody.velocityY)", insert: "velocityY = " },
];

const GLOBAL_APIS = [
  { label: "find(name)", detail: "Find entity by name → returns object with .x, .y, .sprite, etc.", insert: 'find("' },
  { label: "scene", detail: "Scene management: find(), load(), restart()", insert: "scene." },
  { label: "physics", detail: "Physics: raycast()", insert: "physics." },
  { label: "input", detail: "Input: keyDown(), keyPressed()", insert: "input." },
  { label: "time", detail: "Time: deltaTime, elapsed", insert: "time." },
  { label: "random", detail: "Random: int(), float()", insert: "random." },
  { label: "global", detail: "Persistent variables: global.score++, etc.", insert: "global." },
];

const SCENE_API = [
  { label: "find(name)", detail: "Find entity by name", insert: 'find("' },
  { label: "load(sceneName)", detail: "Load a scene", insert: 'load("' },
  { label: "restart()", detail: "Restart current scene", insert: "restart()" },
];
const PHYSICS_API = [
  { label: "raycast(x1, y1, x2, y2)", detail: "Raycast from point A to B", insert: "raycast(" },
];
const INPUT_API = [
  { label: "keyDown(key)", detail: "Is key currently held? e.g. keyDown('ArrowLeft')", insert: 'keyDown("' },
  { label: "keyPressed(key)", detail: "Was key pressed this frame?", insert: 'keyPressed("' },
];
const TIME_API = [
  { label: "deltaTime", detail: "Seconds since last frame", insert: "deltaTime" },
  { label: "elapsed", detail: "Total seconds since game started", insert: "elapsed" },
];
const RANDOM_API = [
  { label: "int(min, max)", detail: "Random integer [min, max]", insert: "int(" },
  { label: "float(min, max)", detail: "Random float [min, max)", insert: "float(" },
];

// Parses variable assignments from find() calls so autocomplete can
// resolve `var player = find("Player")` → player gets Player's APIs.
function _parseFindVariables(text) {
  const map = {};
  const regex = /(?:\b(?:var|let|const)\s+)?(\w+)\s*=\s*find\s*\(\s*["']([^"']+)["']\s*\)/g;
  let match;
  while ((match = regex.exec(text)) !== null) {
    map[match[1]] = match[2];
  }
  return map;
}

// Returns the set of component keys for an entity found by name, or
// null if no entity with that name exists.
function _entityComponentKeys(entityName) {
  if (!editorState.world) return null;
  const entity = editorState.world.findFirstByName(entityName);
  if (!entity) return null;
  const set = new Set();
  for (const c of COMPONENT_APIS) {
    if (entity.hasComponent(c.key)) set.add(c.key);
  }
  return set;
}

// Picks the rigidbody scripting API list matching an entity's ACTUAL
// Rigidbody2D.bodyType — mirrors runtime/scripting/components/
// RigidbodyAPI.js exactly, so autocomplete never offers e.g.
// addForce() on a Kinematic/Static object only for it to throw at
// runtime. Falls back to the read-only Static shape if the component
// is missing or the type is unrecognized (an entity with only a
// Collider2D — no Rigidbody2D — behaves as an implicit static
// collider in PhysicsWorld, so Static is the correct, safe default).
function _rigidbodyApiForBodyType(bodyType) {
  if (bodyType === BodyType.DYNAMIC) return RIGIDBODY_API_DYNAMIC;
  if (bodyType === BodyType.KINEMATIC) return RIGIDBODY_API_KINEMATIC;
  return RIGIDBODY_API_STATIC;
}

// Same idea as _rigidbodyApiForBodyType, but for a SET of entities (the
// "union across owners" case when a script is shared by several
// objects — see COMPONENT_APIS' rigidbody entry below). If every owner
// shares the same body type, only that type's API is offered; if body
// types differ across owners, the union is offered so nothing valid on
// any owner is missing — matching how _contextComponentKeys() already
// unions plain component membership across owners.
function _rigidbodyApiForEntities(entities) {
  const seen = new Set();
  const lists = [];
  for (const e of entities) {
    if (!e.hasComponent(RIGIDBODY_2D)) continue;
    const rb = e.getComponent(RIGIDBODY_2D);
    const bodyType = rb ? rb.bodyType : BodyType.STATIC;
    if (seen.has(bodyType)) continue;
    seen.add(bodyType);
    lists.push(_rigidbodyApiForBodyType(bodyType));
  }
  if (lists.length === 0) return RIGIDBODY_API_STATIC;
  if (lists.length === 1) return lists[0];
  // Mixed body types across owners — union by label so nothing is
  // duplicated and every owner's valid members are still offered.
  const merged = [];
  const labelsSeen = new Set();
  for (const list of lists) {
    for (const item of list) {
      if (labelsSeen.has(item.label)) continue;
      labelsSeen.add(item.label);
      merged.push(item);
    }
  }
  return merged;
}

// Full list of every API (shortcuts + all components + globals).
// Used when the engine can't track a variable's type.
function _allCompletions(monaco, range) {
  const suggestions = [];
  for (const item of THIS_SHORTCUTS) {
    suggestions.push(_makeCompletion(monaco, item, range));
  }
  for (const c of COMPONENT_APIS) {
    for (const item of c.api) {
      suggestions.push(Object.assign(_makeCompletion(monaco, item, range), { label: c.name + "." + item.label }));
    }
    suggestions.push(_makeCompletion(monaco, { label: c.name, detail: c.name + " component", insert: c.name + "." }, range));
  }
  for (const item of GLOBAL_APIS) {
    suggestions.push(_makeCompletion(monaco, item, range));
  }
  return suggestions;
}

// Union of every rigidbody API across all three body types — used ONLY
// by the generic/untracked paths below (_allCompletions, and an
// untracked find() variable) where there is no real entity to check
// the actual bodyType against, so showing everything is the safer
// fallback than guessing wrong. The entity-aware paths (`this.` and a
// find()-tracked variable — see _rigidbodyApiForEntities /
// _rigidbodyApiForBodyType above) always resolve the PRECISE list for
// the real body type instead of this union.
const RIGIDBODY_API_ALL = (function () {
  const merged = [];
  const seen = new Set();
  for (const list of [RIGIDBODY_API_DYNAMIC, RIGIDBODY_API_KINEMATIC, RIGIDBODY_API_STATIC]) {
    for (const item of list) {
      if (seen.has(item.label)) continue;
      seen.add(item.label);
      merged.push(item);
    }
  }
  return merged;
})();

// Maps a component key to its sub-object name + API list.
const COMPONENT_APIS = [
  { key: TRANSFORM, name: "transform", api: TRANSFORM_API },
  { key: SPRITE_RENDERER, name: "sprite", api: SPRITE_API },
  { key: RIGIDBODY_2D, name: "rigidbody", api: RIGIDBODY_API_ALL },
  { key: SPRITE_ANIMATION, name: "animator", api: ANIMATOR_API },
  { key: CAMERA, name: "camera", api: CAMERA_API },
  { key: AUDIO_SOURCE, name: "audio", api: AUDIO_API },
];

function _makeCompletion(monaco, item, range) {
  return {
    label: item.label,
    kind: monaco.languages.CompletionItemKind.Function,
    detail: item.detail,
    insertText: item.insert,
    range: range,
  };
}

// The entities whose components drive `this.` completions for the
// currently active script tab. Set when a script is opened via an
// object (single entity) or the Scripts folder (one entity, or the
// union of every object that shares the script).
function _getContextEntities() {
  const se = editorState.scriptEditor;
  const ctx = se.contextByScript ? se.contextByScript[se.activeTab] : null;
  if (!ctx || !editorState.world) return [];
  const ids = ctx.entityId ? [ctx.entityId] : ctx.entityIds || [];
  const out = [];
  for (const id of ids) {
    const e = editorState.world.getEntity(id);
    if (e) out.push(e);
  }
  return out;
}

// Union of component keys present across all context entities, merged
// with any APIs the user forced on via the API Management panel. When a
// script is shared by objects with different components, every
// component from every owner is included — so each property is valid on
// at least one object and nothing breaks.
function _contextComponentKeys() {
  const entities = _getContextEntities();
  const set = new Set();
  for (const e of entities) {
    for (const c of COMPONENT_APIS) {
      if (e.hasComponent(c.key)) set.add(c.key);
    }
  }
  const forced = editorState.scriptEditor.forcedApis || [];
  for (const f of forced) set.add(f);
  return set;
}

export function registerIntelliSense(monaco) {
  if (_registered) return;
  _registered = true;

  monaco.languages.registerCompletionItemProvider("javascript", {
    triggerCharacters: [".", "(", '"'],

    provideCompletionItems: function (model, position) {
      const textUntilPosition = model.getValueInRange({
        startLineNumber: 1,
        startColumn: 1,
        endLineNumber: position.lineNumber,
        endColumn: position.column,
      });

      // Only consider the current line up to the cursor — the chain
      // that decides the suggestion set is whatever was just typed.
      const lineUntil = textUntilPosition.slice(textUntilPosition.lastIndexOf("\n") + 1);

      const word = model.getWordUntilPosition(position);
      const range = {
        startLineNumber: position.lineNumber,
        endLineNumber: position.lineNumber,
        startColumn: word.startColumn,
        endColumn: word.endColumn,
      };

      const suggestions = [];

      // this.<optional partial word> → entity-aware completions.
      // Suggestions stay visible (and filter) as the user types after
      // the dot, so the list is always based on what was typed.
      if (lineUntil.match(/\bthis\.\w*$/)) {
        for (const item of THIS_SHORTCUTS) {
          suggestions.push(_makeCompletion(monaco, item, range));
        }
        const contextEntities = _getContextEntities();
        const keys = _contextComponentKeys();
        for (const c of COMPONENT_APIS) {
          if (keys.has(c.key)) {
            // Rigidbody is body-type-aware: resolve the PRECISE API for
            // the real entity/entities behind this script tab instead
            // of the generic union, so a Kinematic object's `this.`
            // never suggests addForce()/addImpulse() etc.
            const api = c.key === RIGIDBODY_2D ? _rigidbodyApiForEntities(contextEntities) : c.api;
            for (const item of api) {
              suggestions.push(Object.assign(_makeCompletion(monaco, item, range), { label: c.name + "." + item.label }));
            }
            suggestions.push(_makeCompletion(monaco, { label: c.name, detail: c.name + " component", insert: c.name + "." }, range));
          }
        }
        return { suggestions: suggestions };
      }

      // <subobj>.<optional partial word> → that sub-object's API.
      const subMatch = lineUntil.match(/(\w+)\.\w*$/);
      if (subMatch && subMatch[1] !== "this") {
        const subObj = subMatch[1];
        let items = null;
        if (subObj === "transform") items = TRANSFORM_API;
        else if (subObj === "sprite") items = SPRITE_API;
        else if (subObj === "rigidbody") items = _rigidbodyApiForEntities(_getContextEntities());
        else if (subObj === "animator") items = ANIMATOR_API;
        else if (subObj === "camera") items = CAMERA_API;
        else if (subObj === "audio") items = AUDIO_API;
        else if (subObj === "scene") items = SCENE_API;
        else if (subObj === "physics") items = PHYSICS_API;
        else if (subObj === "input") items = INPUT_API;
        else if (subObj === "time") items = TIME_API;
        else if (subObj === "random") items = RANDOM_API;
        if (items) {
          for (const item of items) {
            suggestions.push(_makeCompletion(monaco, item, range));
          }
          return { suggestions: suggestions };
        }
        // Unknown sub-object — check if it's a tracked find() variable.
        // If assigned from find("EntityName"), show that entity's
        // component APIs (same as `this.` for that entity). If the
        // engine can't track the variable (e.g. random.int()), show
        // the full API list so the user still gets suggestions.
        const findVars = _parseFindVariables(textUntilPosition);
        if (findVars[subObj]) {
          const entityKeys = _entityComponentKeys(findVars[subObj]);
          if (entityKeys) {
            const foundEntity = editorState.world ? editorState.world.findFirstByName(findVars[subObj]) : null;
            for (const item of THIS_SHORTCUTS) {
              suggestions.push(_makeCompletion(monaco, item, range));
            }
            for (const c of COMPONENT_APIS) {
              if (entityKeys.has(c.key)) {
                const api = c.key === RIGIDBODY_2D
                  ? _rigidbodyApiForEntities(foundEntity ? [foundEntity] : [])
                  : c.api;
                for (const item of api) {
                  suggestions.push(Object.assign(_makeCompletion(monaco, item, range), { label: c.name + "." + item.label }));
                }
                suggestions.push(_makeCompletion(monaco, { label: c.name, detail: c.name + " component", insert: c.name + "." }, range));
              }
            }
            return { suggestions: suggestions };
          }
        }
        // Untracked variable — show the full API list.
        return { suggestions: _allCompletions(monaco, range) };
      }

      // Global APIs (when not after a dot)
      for (const item of GLOBAL_APIS) {
        suggestions.push(_makeCompletion(monaco, item, range));
      }
      suggestions.push(_makeCompletion(monaco, { label: "function onStart()", detail: "Called once at start", insert: "onStart() {\n  \n}" }, range));
      suggestions.push(_makeCompletion(monaco, { label: "function onUpdate()", detail: "Called every frame", insert: "onUpdate() {\n  \n}" }, range));
      suggestions.push(_makeCompletion(monaco, { label: "function onFixedUpdate()", detail: "Called at fixed 60Hz", insert: "onFixedUpdate() {\n  \n}" }, range));
      suggestions.push(_makeCompletion(monaco, { label: "function onCollision(other)", detail: "Called on collision", insert: "onCollision(other) {\n  \n}" }, range));
      suggestions.push(_makeCompletion(monaco, { label: "function onDestroy()", detail: "Called when destroyed", insert: "onDestroy() {\n  \n}" }, range));
      return { suggestions: suggestions };
    },
  });
}
