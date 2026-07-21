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
import { CHARACTER_CONTROLLER, ControllerType } from "../../runtime/components/CharacterController.js";

let _registered = false;

// API definitions for each component sub-object.
// These lists are the single source of truth for what shows up in
// autocomplete — if an API exists in the runtime scripting files but
// not here, add it here. If something listed here does NOT exist in the
// runtime, remove it. One entry per feature: no duplicates.

const TRANSFORM_API = [
  { label: "position", detail: "{ x, y } — get/set position as an object", insert: "position" },
  { label: "rotation", detail: "Rotation in degrees (read/write)", insert: "rotation" },
  { label: "scale", detail: "{ x, y } — get/set scale as an object", insert: "scale" },
  { label: "translate(dx, dy)", detail: "Move by a delta amount this frame", insert: "translate(" },
  { label: "lookAt(x, y)", detail: "Rotate to face a world-space point", insert: "lookAt(" },
];

const SPRITE_API = [
  { label: "texture", detail: "Sprite texture key (string) — the asset key shown in the Inspector", insert: "texture" },
  { label: "color", detail: "Tint color as hex string, e.g. \"#ff0000\" for red", insert: 'color = "#' },
  { label: "flipX", detail: "Flip sprite horizontally (boolean)", insert: "flipX = " },
  { label: "flipY", detail: "Flip sprite vertically (boolean)", insert: "flipY = " },
  { label: "opacity", detail: "Transparency: 0.0 (invisible) to 1.0 (fully visible)", insert: "opacity = " },
];

// Rigidbody scripting API is SPLIT PER BODY TYPE, matching
// runtime/scripting/components/RigidbodyAPI.js exactly.
// A Dynamic body gets forces/impulses (Rapier's solver owns it);
// a Kinematic body gets velocity-drive + move() + contact-state flags
// (Rapier applies no forces to it); a Static body is read-only.
// Autocomplete only shows the API valid for the actual body type of
// the entity whose script is open — so a Kinematic entity never sees
// addForce() in autocomplete, and it won't exist at runtime either.
const RIGIDBODY_API_COMMON = [
  { label: "velocity", detail: "{ x, y } — velocity vector", insert: "velocity" },
  { label: "velocityX", detail: "Horizontal velocity (px/s)", insert: "velocityX = " },
  { label: "velocityY", detail: "Vertical velocity (px/s, positive = down)", insert: "velocityY = " },
  { label: "type", detail: "'Dynamic' | 'Kinematic' | 'Static' (read-only)", insert: "type" },
];
const RIGIDBODY_API_DYNAMIC = RIGIDBODY_API_COMMON.concat([
  { label: "mass", detail: "Body mass (affects force/impulse results)", insert: "mass = " },
  { label: "gravityScale", detail: "Gravity multiplier (1 = normal, 0 = no gravity)", insert: "gravityScale = " },
  { label: "linearDamping", detail: "Linear drag — slows the body over time", insert: "linearDamping = " },
  { label: "angularDamping", detail: "Rotational drag", insert: "angularDamping = " },
  { label: "addForce(x, y)", detail: "Continuous force — call every frame in onUpdate to sustain a push", insert: "addForce(" },
  { label: "addImpulse(x, y)", detail: "One-shot velocity kick — call once (e.g. in onCollision or a jump)", insert: "addImpulse(" },
  { label: "addTorque(t)", detail: "Continuous spin force — call every frame to sustain rotation", insert: "addTorque(" },
  { label: "addAngularImpulse(t)", detail: "One-shot angular velocity kick", insert: "addAngularImpulse(" },
]);
const RIGIDBODY_API_KINEMATIC = RIGIDBODY_API_COMMON.concat([
  { label: "move(dx, dy)", detail: "One-shot swept move this frame — blocked/slid by obstacles just like velocity", insert: "move(" },
  { label: "isGrounded", detail: "True when the character controller is touching the ground (read-only)", insert: "isGrounded" },
  { label: "isOnCeiling", detail: "True when touching a ceiling surface above (read-only)", insert: "isOnCeiling" },
  { label: "isOnWall", detail: "True when touching a wall — only fires for surfaces steeper than wallAngleLimit (read-only)", insert: "isOnWall" },
  { label: "isOnSlope", detail: "True when grounded on a slope steeper than slopeMinAngle (read-only)", insert: "isOnSlope" },
  { label: "groundAngle", detail: "Live angle (deg) of the steepest walkable ground/slope contact this step — 0 = flat floor, up to groundAngleLimit. 0 when not touching a walkable surface (read-only)", insert: "groundAngle" },
  { label: "resolvedVelocity", detail: "{ x, y } — actual movement this step after collisions (read-only)", insert: "resolvedVelocity" },
  { label: "groundAngleLimit", detail: "Max angle from horizontal (deg) that counts as walkable ground — default 45. Steeper contacts are unclimbable or walls.", insert: "groundAngleLimit = " },
  { label: "wallAngleLimit", detail: "Min angle (deg) before a surface counts as a wall — default 70. Contacts between groundAngleLimit and this are steep-but-not-wall.", insert: "wallAngleLimit = " },
  { label: "slopeMinAngle", detail: "Min angle (deg) before isOnSlope fires — default 10. Raise to ignore minor floor tilt noise.", insert: "slopeMinAngle = " },
]);
const RIGIDBODY_API_STATIC = [
  { label: "type", detail: "'Static' — body never moves. Change Body Type in the Inspector to Dynamic or Kinematic.", insert: "type" },
  { label: "velocity", detail: "Always { x:0, y:0 } — static bodies never move", insert: "velocity" },
];

// Controller scripting API is SPLIT PER MOVEMENT TYPE, matching
// runtime/scripting/components/ControllerAPI.js exactly — mirrors the
// same body-type-split convention RigidbodyAPI.js uses. Autocomplete
// only shows the members valid for the entity's ACTUAL Movement Type
// (Inspector's CharacterController.controllerType), so a Car never
// sees isGrounded/simulateJump and a Follow never sees moveSpeed.
const CONTROLLER_API_WALK_COMMON = [
  { label: "controllerType", detail: "'Character Controller' | 'Platformer' | 'Top-Down' (read-only)", insert: "controllerType" },
  { label: "moveSpeed", detail: "Horizontal move speed in px/s", insert: "moveSpeed = " },
  { label: "acceleration", detail: "How fast velocity approaches target speed (higher = snappier)", insert: "acceleration = " },
  { label: "airControl", detail: "0-1 multiplier on acceleration while airborne (Character Controller and Platformer only — no effect on Top-Down, which has no gravity/airborne concept)", insert: "airControl = " },
  { label: "useGravity", detail: "Whether gravity applies (always true for Platformer, always false for Top-Down)", insert: "useGravity = " },
  { label: "useDefaultInput", detail: "Whether WASD/Arrows are wired automatically — turn off to drive movement entirely from script", insert: "useDefaultInput = " },
  { label: "simulateMove(x, y)", detail: "Move left/right (and up/down for Top-Down) from script, same as holding Arrows/WASD — x/y are -1 to 1, y optional. Call every frame you want movement to continue.", insert: "simulateMove(" },
  { label: "isOnCeiling", detail: "True when touching a ceiling surface above (read-only). Real per-frame value on Kinematic bodies; always false on Dynamic (no per-axis contact tracking — Rapier's own solver handles it).", insert: "isOnCeiling" },
  { label: "isOnWall", detail: "True when touching a wall surface steeper than wallAngleLimit (read-only). Real per-frame value on Kinematic bodies; always false on Dynamic.", insert: "isOnWall" },
  { label: "isOnSlope", detail: "True when grounded on a slope steeper than slopeMinAngle (read-only). Real per-frame value on Kinematic bodies; always false on Dynamic.", insert: "isOnSlope" },
  { label: "groundAngle", detail: "Live angle (deg) of the steepest walkable ground/slope contact this step — 0 = flat, up to groundAngleLimit (read-only). Real per-frame value on Kinematic bodies; always 0 on Dynamic.", insert: "groundAngle" },
];
const CONTROLLER_API_JUMPABLE = CONTROLLER_API_WALK_COMMON.concat([
  { label: "canJump", detail: "Whether jump is enabled", insert: "canJump = " },
  { label: "jumpForce", detail: "Upward velocity applied on jump (px/s)", insert: "jumpForce = " },
  { label: "maxJumps", detail: "1 = no double jump, 2 = double jump, etc.", insert: "maxJumps = " },
  { label: "isGrounded", detail: "True when touching the ground (read-only)", insert: "isGrounded" },
  { label: "simulateJump()", detail: "Trigger a jump from script, same as pressing Space — respects canJump/maxJumps", insert: "simulateJump()" },
]);
const CONTROLLER_API_CHARACTER = CONTROLLER_API_JUMPABLE;
const CONTROLLER_API_PLATFORMER = CONTROLLER_API_JUMPABLE;
const CONTROLLER_API_TOP_DOWN = CONTROLLER_API_WALK_COMMON;
const CONTROLLER_API_CAR = [
  { label: "controllerType", detail: "'Car' (read-only)", insert: "controllerType" },
  { label: "maxSpeed", detail: "Top forward speed in px/s (reverse caps at half this)", insert: "maxSpeed = " },
  { label: "acceleration", detail: "How fast the car speeds up (px/s²) — maps to the Inspector's Acceleration field", insert: "acceleration = " },
  { label: "brakeForce", detail: "How fast it brakes / goes into reverse (px/s²)", insert: "brakeForce = " },
  { label: "turnSpeed", detail: "Max turn rate in deg/s at full speed (scales down at lower speeds)", insert: "turnSpeed = " },
  { label: "driftFactor", detail: "0-1: how much lateral velocity is retained (higher = more slide)", insert: "driftFactor = " },
  { label: "useDefaultInput", detail: "Whether WASD/Arrows (throttle/brake/steer) are wired automatically", insert: "useDefaultInput = " },
];
const CONTROLLER_API_FOLLOW = [
  { label: "controllerType", detail: "'Follow' (read-only)", insert: "controllerType" },
  { label: "targetName", detail: "Name of the entity to pursue", insert: 'targetName = "' },
  { label: "followSpeed", detail: "Pursuit speed in px/s", insert: "followSpeed = " },
  { label: "followDistance", detail: "Stop when within this many pixels of the target", insert: "followDistance = " },
];
const CONTROLLER_API_FREE = [
  { label: "controllerType", detail: "'Free' — fully script-driven, ControllerSystem does nothing for this entity. Drive this.rigidbody directly.", insert: "controllerType" },
];

const ANIMATOR_API = [
  { label: "play(clipName)", detail: "Play a named animation clip", insert: 'play("' },
  { label: "stop()", detail: "Stop the current animation", insert: "stop()" },
  { label: "playing", detail: "True while an animation is playing (read-only)", insert: "playing" },
  { label: "currentClip", detail: "Name of the currently active clip (read-only)", insert: "currentClip" },
];

const CAMERA_API = [
  { label: "zoom", detail: "Camera size/zoom. Default 5 = no zoom. Smaller = zoomed in, larger = zoomed out.", insert: "zoom = " },
  { label: "shake(intensity, duration)", detail: "Shake the camera. intensity=pixels of shake, duration=seconds.", insert: "shake(" },
  { label: "renderToSprite(spriteEntity)", detail: "Render this camera's view onto a sprite's texture every frame (minimap / security feed). Pass an entity from find(), e.g. renderToSprite(find('Minimap'))", insert: "renderToSprite(" },
];

const AUDIO_API = [
  { label: "play()", detail: "Start audio playback", insert: "play()" },
  { label: "stop()", detail: "Stop audio playback", insert: "stop()" },
  { label: "volume", detail: "Volume: 0.0 (silent) to 1.0 (full)", insert: "volume = " },
  { label: "playing", detail: "True while the source is set to play (read-only)", insert: "playing" },
];

// this.* shortcut arrays — filtered per-entity in provideCompletionItems
// so only shortcuts relevant to the entity's actual components appear.

// Always shown (every entity has Transform, visible, enabled).
const THIS_SHORTCUTS_BASE = [
  { label: "x", detail: "Position X (number)", insert: "x" },
  { label: "y", detail: "Position Y (number)", insert: "y" },
  { label: "position", detail: "{ x, y } position object — read or assign {x,y}", insert: "position" },
  { label: "rotation", detail: "Rotation in degrees", insert: "rotation = " },
  { label: "scaleX", detail: "Scale X", insert: "scaleX = " },
  { label: "scaleY", detail: "Scale Y", insert: "scaleY = " },
  { label: "translate(dx, dy)", detail: "Move by a delta amount this frame", insert: "translate(" },
  { label: "visible", detail: "Show/hide the entity", insert: "visible = " },
  { label: "enabled", detail: "Enable/disable this script", insert: "enabled = " },
  { label: "name", detail: "The entity's name, set in the Hierarchy panel (read-only). Use to identify what you collided with, e.g. other.name === \"Obstacle\"", insert: "name" },
  { label: "tag", detail: "The entity's tag, set in the Inspector's Tag dropdown (read/write). Use to categorize entities, e.g. other.tag === \"Enemy\"", insert: "tag" },
  { label: "destroy()", detail: "Destroy this entity — removed at the end of this frame, onDestroy() fires just before removal", insert: "destroy()" },
  { label: "destroyed", detail: "True once destroy() has been called on this entity but before it's actually removed (read-only)", insert: "destroyed" },
];

// NOTE: there is deliberately no THIS_SPRITE_SHORTCUTS, THIS_VELOCITY_
// SHORTCUTS, THIS_KINEMATIC_SHORTCUTS, THIS_DYNAMIC_SHORTCUTS, or
// THIS_CONTROLLER_SHORTCUTS array here. Sprite, rigidbody/physics, and
// movement-type properties are reached ONLY through this.sprite.*,
// this.rigidbody.*, and this.controller.* (see SPRITE_API and the
// RIGIDBODY_API_*/CONTROLLER_API_* lists below, which mirror
// runtime/scripting/components/SpriteAPI.js, RigidbodyAPI.js, and
// ControllerAPI.js exactly) — one API per capability, so autocomplete
// never offers two different-looking ways to do the same thing
// (this.addForce() vs this.rigidbody.addForce(), or this.isOnGround vs
// this.controller.isGrounded) that could behave differently, especially
// since RigidbodyAPI's shape depends on the entity's actual body type
// and ControllerAPI's shape depends on the entity's actual movement type.

const GLOBAL_APIS = [
  { label: "find(name)", detail: "Find entity by name → same as scene.find(name). Returns an object with .x, .y, .sprite, .rigidbody, etc.", insert: 'find("' },
  { label: "scene", detail: "Scene utilities: scene.find(), scene.load(), scene.restart()", insert: "scene." },
  { label: "physics", detail: "Physics utilities: physics.raycast(x1,y1,x2,y2)", insert: "physics." },
  { label: "input", detail: "Input queries: input.keyDown(key), input.keyPressed(key)", insert: "input." },
  { label: "time", detail: "Frame timing: time.deltaTime, time.elapsed", insert: "time." },
  { label: "random", detail: "Random numbers: random.int(min,max), random.float(min,max)", insert: "random." },
  { label: "global", detail: "Cross-script shared state: global.score = 0, global.lives, etc.", insert: "global." },
  { label: "debug", detail: "On-screen debug HUD: debug.show(), debug.log(label, value)", insert: "debug." },
];

const SCENE_API = [
  { label: "find(name)", detail: "Find entity by name (same as the top-level find() shortcut)", insert: 'find("' },
  { label: "load(sceneName)", detail: "Load a different scene by name", insert: 'load("' },
  { label: "restart()", detail: "Restart the current scene from the beginning", insert: "restart()" },
];
const PHYSICS_API = [
  { label: "raycast(x1, y1, x2, y2)", detail: "Cast a ray from (x1,y1) to (x2,y2). Returns { entity, point, distance } or null.", insert: "raycast(" },
];
const INPUT_API = [
  { label: "keyDown(key)", detail: "Is the key currently held? Use key codes like 'ArrowLeft', 'Space', 'KeyA'", insert: 'keyDown("' },
  { label: "keyPressed(key)", detail: "Was the key pressed this frame only (not held)? Same key codes as keyDown.", insert: 'keyPressed("' },
];
const TIME_API = [
  { label: "deltaTime", detail: "Seconds since the last frame (use to keep movement frame-rate independent)", insert: "deltaTime" },
  { label: "elapsed", detail: "Total seconds since the game started", insert: "elapsed" },
];
const RANDOM_API = [
  { label: "int(min, max)", detail: "Random integer in [min, max] inclusive", insert: "int(" },
  { label: "float(min, max)", detail: "Random float in [min, max)", insert: "float(" },
];
const DEBUG_API = [
  { label: "show(on)", detail: "Turn the on-screen debug HUD on (default) or off — debug.show(false) hides it", insert: "show(" },
  { label: "showFps(on)", detail: "Show/hide just the FPS line while the HUD stays on", insert: "showFps(" },
  { label: "log(label, value)", detail: "Add/update a custom line in the HUD, e.g. debug.log(\"Player HP\", this.hp)", insert: 'log("' },
  { label: "clear(label)", detail: "Remove one custom HUD line by its label", insert: 'clear("' },
  { label: "clearAll()", detail: "Remove every custom HUD line (FPS line stays if showFps is on)", insert: "clearAll()" },
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

// Same idea as _rigidbodyApiForBodyType/_rigidbodyApiForEntities, but
// for CharacterController.controllerType — mirrors
// runtime/scripting/components/ControllerAPI.js exactly, so
// autocomplete never offers e.g. simulateJump() on a Car/Follow/Free
// entity only for it to throw at runtime.
function _controllerApiForType(controllerType) {
  if (controllerType === ControllerType.CHARACTER) return CONTROLLER_API_CHARACTER;
  if (controllerType === ControllerType.PLATFORMER) return CONTROLLER_API_PLATFORMER;
  if (controllerType === ControllerType.TOP_DOWN) return CONTROLLER_API_TOP_DOWN;
  if (controllerType === ControllerType.CAR) return CONTROLLER_API_CAR;
  if (controllerType === ControllerType.FOLLOW) return CONTROLLER_API_FOLLOW;
  return CONTROLLER_API_FREE;
}

function _controllerApiForEntities(entities) {
  const seen = new Set();
  const lists = [];
  for (const e of entities) {
    if (!e.hasComponent(CHARACTER_CONTROLLER)) continue;
    const cc = e.getComponent(CHARACTER_CONTROLLER);
    const controllerType = cc ? cc.controllerType : ControllerType.FREE;
    if (seen.has(controllerType)) continue;
    seen.add(controllerType);
    lists.push(_controllerApiForType(controllerType));
  }
  if (lists.length === 0) return CONTROLLER_API_FREE;
  if (lists.length === 1) return lists[0];
  // Mixed movement types across owners — union by label, same approach
  // _rigidbodyApiForEntities uses for mixed body types.
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

// Full list of every shortcut + component API + global.
// Used when the engine can't track a variable's type (untracked variable,
// generic find() result). Shows everything so nothing valid is hidden.
function _allCompletions(monaco, range) {
  const suggestions = [];
  // Flat Transform/entity shortcuts (the only flat this.<x> shortcuts —
  // see the note above GLOBAL_APIS for why sprite/rigidbody aren't here)
  for (const item of THIS_SHORTCUTS_BASE) {
    suggestions.push(_makeCompletion(monaco, item, range));
  }
  // Sub-object completions
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

// Pushes the flat `this.` shortcut completions (Transform/entity only —
// see the note above GLOBAL_APIS) into `suggestions`. Sprite and
// rigidbody/physics properties are offered exclusively via their
// sub-object completions (this.sprite., this.rigidbody.) below in
// provideCompletionItems, so `keys`/`entities` aren't needed here
// anymore, but are kept as parameters for call-site compatibility.
function _pushShortcutCompletions(monaco, range, suggestions, keys, entities) {
  for (const item of THIS_SHORTCUTS_BASE) {
    suggestions.push(_makeCompletion(monaco, item, range));
  }
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

// Union of every controller API across all movement types — same
// untracked-fallback purpose as RIGIDBODY_API_ALL above.
const CONTROLLER_API_ALL = (function () {
  const merged = [];
  const seen = new Set();
  for (const list of [CONTROLLER_API_CHARACTER, CONTROLLER_API_TOP_DOWN, CONTROLLER_API_CAR, CONTROLLER_API_FOLLOW, CONTROLLER_API_FREE]) {
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
  { key: CHARACTER_CONTROLLER, name: "controller", api: CONTROLLER_API_ALL },
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
      if (lineUntil.match(/\bthis\.\w*$/)) {
        const contextEntities = _getContextEntities();
        const keys = _contextComponentKeys();
        // Flat shortcuts filtered by component presence + body type
        _pushShortcutCompletions(monaco, range, suggestions, keys, contextEntities);
        // Sub-object completions (this.sprite, this.rigidbody, etc.)
        for (const c of COMPONENT_APIS) {
          if (keys.has(c.key)) {
            // Rigidbody is body-type-aware and Controller is movement-
            // type-aware, so a Kinematic entity's this. never sees
            // addForce()/addImpulse(), and a Car/Follow/Free entity's
            // this. never sees isGrounded()/simulateJump() in
            // autocomplete.
            const api = c.key === RIGIDBODY_2D ? _rigidbodyApiForEntities(contextEntities)
              : c.key === CHARACTER_CONTROLLER ? _controllerApiForEntities(contextEntities)
              : c.api;
            for (const item of api) {
              // insertText must be the FULL sub-object path (e.g. "camera.zoom")
              // so that clicking "camera.zoom" in the list after typing "this."
              // inserts the full token, not just "zoom".
              suggestions.push(Object.assign(
                _makeCompletion(monaco, item, range),
                { label: c.name + "." + item.label, insertText: c.name + "." + item.insert }
              ));
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
        else if (subObj === "controller") items = _controllerApiForEntities(_getContextEntities());
        else if (subObj === "scene") items = SCENE_API;
        else if (subObj === "physics") items = PHYSICS_API;
        else if (subObj === "input") items = INPUT_API;
        else if (subObj === "time") items = TIME_API;
        else if (subObj === "random") items = RANDOM_API;
        else if (subObj === "debug") items = DEBUG_API;
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
            const foundEntities = foundEntity ? [foundEntity] : [];
            // Flat shortcuts filtered by the found entity's components
            _pushShortcutCompletions(monaco, range, suggestions, entityKeys, foundEntities);
            // Sub-object completions
            for (const c of COMPONENT_APIS) {
              if (entityKeys.has(c.key)) {
                const api = c.key === RIGIDBODY_2D
                  ? _rigidbodyApiForEntities(foundEntities)
                  : c.key === CHARACTER_CONTROLLER
                  ? _controllerApiForEntities(foundEntities)
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
      suggestions.push(_makeCompletion(monaco, { label: "function onStart()", detail: "Called once before the first onUpdate — use for initialization", insert: "onStart() {\n  \n}" }, range));
      suggestions.push(_makeCompletion(monaco, { label: "function onUpdate(dt)", detail: "Called every frame. dt = seconds since last frame (use for movement)", insert: "onUpdate(dt) {\n  \n}" }, range));
      suggestions.push(_makeCompletion(monaco, { label: "function onFixedUpdate(dt)", detail: "Called at a fixed 60 Hz rate — use for physics/rigidbody changes", insert: "onFixedUpdate(dt) {\n  \n}" }, range));
      suggestions.push(_makeCompletion(monaco, { label: "function onCollision(other)", detail: "Called when this entity's collider touches another (alias for onCollisionEnter). 'other' has .x, .y, etc.", insert: "onCollision(other) {\n  \n}" }, range));
      suggestions.push(_makeCompletion(monaco, { label: "function onCollisionEnter(other)", detail: "Called when collision begins. 'other' has .x, .y, .name, etc. Works for all body types.", insert: "onCollisionEnter(other) {\n  \n}" }, range));
      suggestions.push(_makeCompletion(monaco, { label: "function onCollisionExit(other)", detail: "Called when collision ends. 'other' has .x, .y, .name, etc. Works for all body types.", insert: "onCollisionExit(other) {\n  \n}" }, range));
      suggestions.push(_makeCompletion(monaco, { label: "function onTriggerEnter(other)", detail: "Called when entering a trigger collider (Is Trigger = on)", insert: "onTriggerEnter(other) {\n  \n}" }, range));
      suggestions.push(_makeCompletion(monaco, { label: "function onTriggerExit(other)", detail: "Called when leaving a trigger collider", insert: "onTriggerExit(other) {\n  \n}" }, range));
      suggestions.push(_makeCompletion(monaco, { label: "function onDestroy()", detail: "Called once when this entity is destroyed or the scene ends", insert: "onDestroy() {\n  \n}" }, range));
      return { suggestions: suggestions };
    },
  });
}
