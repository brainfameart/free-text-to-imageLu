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
 * Smart string-argument completions:
 *   find("           → all entity names in the scene
 *   scene.load("     → all scene names
 *   scene.find("     → all entity names
 *   input.keyDown("  → full keyboard key-code list
 *   input.keyPressed(" → same
 *   .texture = "     → all sprite/texture asset names
 *   animator.play("  → animation clip names on the context entity
 *   sendMessage("    → all unique entity tags in the scene
 *   .name === "      → all entity names
 *   .tag === "       → all entity tags
 *   .name == "       → all entity names
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
import { getAllSpriteAssets, getAllAudioAssets } from "../../runtime/assets/AssetRegistry.js";
import { getSceneList } from "../../runtime/scene/SceneManager.js";

let _registered = false;

// ─── Keyboard key codes ─────────────────────────────────────────────────────
// Full list of browser KeyboardEvent.code values the engine's input system
// accepts. Shown when the user types input.keyDown(" or input.keyPressed(".
const ALL_KEY_CODES = [
  // Letters
  "KeyA","KeyB","KeyC","KeyD","KeyE","KeyF","KeyG","KeyH","KeyI","KeyJ",
  "KeyK","KeyL","KeyM","KeyN","KeyO","KeyP","KeyQ","KeyR","KeyS","KeyT",
  "KeyU","KeyV","KeyW","KeyX","KeyY","KeyZ",
  // Digits
  "Digit0","Digit1","Digit2","Digit3","Digit4",
  "Digit5","Digit6","Digit7","Digit8","Digit9",
  // Numpad
  "Numpad0","Numpad1","Numpad2","Numpad3","Numpad4",
  "Numpad5","Numpad6","Numpad7","Numpad8","Numpad9",
  "NumpadAdd","NumpadSubtract","NumpadMultiply","NumpadDivide",
  "NumpadDecimal","NumpadEnter","NumLock",
  // Arrows
  "ArrowLeft","ArrowRight","ArrowUp","ArrowDown",
  // Modifiers
  "ShiftLeft","ShiftRight","ControlLeft","ControlRight",
  "AltLeft","AltRight","MetaLeft","MetaRight","CapsLock",
  // Common specials
  "Space","Enter","Escape","Backspace","Tab","Delete","Insert",
  "Home","End","PageUp","PageDown","ContextMenu",
  // Function keys
  "F1","F2","F3","F4","F5","F6","F7","F8","F9","F10","F11","F12",
  // Punctuation / symbols
  "Comma","Period","Slash","Backslash","Semicolon","Quote",
  "BracketLeft","BracketRight","Backquote","Minus","Equal",
  // Short-letter aliases (also valid key codes)
  "a","b","c","d","e","f","g","h","i","j","k","l","m",
  "n","o","p","q","r","s","t","u","v","w","x","y","z",
  " ",  // Space as a character
];

// Human-readable descriptions for the most common keys shown as detail.
const KEY_DETAIL = {
  Space: "Spacebar", Enter: "Enter / Return", Escape: "Escape",
  Backspace: "Backspace", Tab: "Tab", Delete: "Delete",
  ArrowLeft: "← Left arrow", ArrowRight: "→ Right arrow",
  ArrowUp: "↑ Up arrow", ArrowDown: "↓ Down arrow",
  ShiftLeft: "Left Shift", ShiftRight: "Right Shift",
  ControlLeft: "Left Ctrl", ControlRight: "Right Ctrl",
  AltLeft: "Left Alt", AltRight: "Right Alt",
};

// ─── API definitions ─────────────────────────────────────────────────────────

const TRANSFORM_API = [
  { label: "position", detail: "{ x, y } — get/set position as an object", insert: "position", kind: "Property" },
  { label: "rotation", detail: "Rotation in degrees (read/write)", insert: "rotation", kind: "Property" },
  { label: "scale", detail: "{ x, y } — get/set scale as an object", insert: "scale", kind: "Property" },
  { label: "translate(dx, dy)", detail: "Move by a delta amount this frame", insert: "translate(${1:dx}, ${2:dy})", kind: "Method", snippet: true },
  { label: "lookAt(x, y)", detail: "Rotate to face a world-space point", insert: "lookAt(${1:x}, ${2:y})", kind: "Method", snippet: true },
];

const SPRITE_API = [
  { label: "texture", detail: "Sprite texture key (string) — the asset name shown in the Inspector", insert: "texture", kind: "Property" },
  { label: "color", detail: 'Tint color as hex string, e.g. "#ff0000" for red', insert: 'color = "#', kind: "Property" },
  { label: "flipX", detail: "Flip sprite horizontally (boolean)", insert: "flipX = ", kind: "Property" },
  { label: "flipY", detail: "Flip sprite vertically (boolean)", insert: "flipY = ", kind: "Property" },
  { label: "opacity", detail: "Transparency: 0.0 (invisible) to 1.0 (fully visible)", insert: "opacity = ", kind: "Property" },
];

const RIGIDBODY_API_COMMON = [
  { label: "velocity", detail: "{ x, y } — velocity vector", insert: "velocity", kind: "Property" },
  { label: "velocityX", detail: "Horizontal velocity (px/s)", insert: "velocityX = ", kind: "Property" },
  { label: "velocityY", detail: "Vertical velocity (px/s, positive = down)", insert: "velocityY = ", kind: "Property" },
  { label: "type", detail: "'Dynamic' | 'Kinematic' | 'Static' (read-only)", insert: "type", kind: "Property" },
];
const RIGIDBODY_API_DYNAMIC = RIGIDBODY_API_COMMON.concat([
  { label: "mass", detail: "Body mass (affects force/impulse results)", insert: "mass = ", kind: "Property" },
  { label: "gravityScale", detail: "Gravity multiplier (1 = normal, 0 = no gravity)", insert: "gravityScale = ", kind: "Property" },
  { label: "linearDamping", detail: "Linear drag — slows the body over time", insert: "linearDamping = ", kind: "Property" },
  { label: "angularDamping", detail: "Rotational drag", insert: "angularDamping = ", kind: "Property" },
  { label: "addForce(x, y)", detail: "Continuous force — call every frame in onUpdate to sustain a push", insert: "addForce(${1:x}, ${2:y})", kind: "Method", snippet: true },
  { label: "addImpulse(x, y)", detail: "One-shot velocity kick — call once (e.g. in onCollision or a jump)", insert: "addImpulse(${1:x}, ${2:y})", kind: "Method", snippet: true },
  { label: "addTorque(t)", detail: "Continuous spin force — call every frame to sustain rotation", insert: "addTorque(${1:t})", kind: "Method", snippet: true },
  { label: "addAngularImpulse(t)", detail: "One-shot angular velocity kick", insert: "addAngularImpulse(${1:t})", kind: "Method", snippet: true },
]);
const RIGIDBODY_API_KINEMATIC = RIGIDBODY_API_COMMON.concat([
  { label: "move(dx, dy)", detail: "One-shot swept move this frame — blocked/slid by obstacles just like velocity", insert: "move(${1:dx}, ${2:dy})", kind: "Method", snippet: true },
  { label: "isGrounded", detail: "True when the character controller is touching the ground (read-only)", insert: "isGrounded", kind: "Property" },
  { label: "isOnCeiling", detail: "True when touching a ceiling surface above (read-only)", insert: "isOnCeiling", kind: "Property" },
  { label: "isOnWall", detail: "True when touching a wall — only fires for surfaces steeper than wallAngleLimit (read-only)", insert: "isOnWall", kind: "Property" },
  { label: "isOnSlope", detail: "True when grounded on a slope steeper than slopeMinAngle (read-only)", insert: "isOnSlope", kind: "Property" },
  { label: "groundAngle", detail: "Live angle (deg) of the steepest walkable ground contact this step — 0 = flat floor (read-only)", insert: "groundAngle", kind: "Property" },
  { label: "resolvedVelocity", detail: "{ x, y } — actual movement this step after collisions (read-only)", insert: "resolvedVelocity", kind: "Property" },
  { label: "groundAngleLimit", detail: "Max angle from horizontal (deg) that counts as walkable ground — default 45", insert: "groundAngleLimit = ", kind: "Property" },
  { label: "wallAngleLimit", detail: "Min angle (deg) before a surface counts as a wall — default 70", insert: "wallAngleLimit = ", kind: "Property" },
  { label: "slopeMinAngle", detail: "Min angle (deg) before isOnSlope fires — default 10", insert: "slopeMinAngle = ", kind: "Property" },
]);
const RIGIDBODY_API_STATIC = [
  { label: "type", detail: "'Static' — body never moves. Change Body Type in the Inspector to Dynamic or Kinematic.", insert: "type", kind: "Property" },
  { label: "velocity", detail: "Always { x:0, y:0 } — static bodies never move", insert: "velocity", kind: "Property" },
];

const CONTROLLER_API_WALK_COMMON = [
  { label: "controllerType", detail: "'Character Controller' | 'Platformer' | 'Top-Down' (read-only)", insert: "controllerType", kind: "Property" },
  { label: "moveSpeed", detail: "Horizontal move speed in px/s", insert: "moveSpeed = ", kind: "Property" },
  { label: "acceleration", detail: "How fast velocity approaches target speed (higher = snappier)", insert: "acceleration = ", kind: "Property" },
  { label: "airControl", detail: "0-1 multiplier on acceleration while airborne", insert: "airControl = ", kind: "Property" },
  { label: "useGravity", detail: "Whether gravity applies (always true for Platformer, always false for Top-Down)", insert: "useGravity = ", kind: "Property" },
  { label: "useDefaultInput", detail: "Whether WASD/Arrows are wired automatically — turn off to drive movement entirely from script", insert: "useDefaultInput = ", kind: "Property" },
  { label: "simulateMove(x, y)", detail: "Move left/right (and up/down for Top-Down) from script — x/y are -1 to 1", insert: "simulateMove(${1:x}, ${2:y})", kind: "Method", snippet: true },
  { label: "isOnCeiling", detail: "True when touching a ceiling surface above (read-only)", insert: "isOnCeiling", kind: "Property" },
  { label: "isOnWall", detail: "True when touching a wall surface steeper than wallAngleLimit (read-only)", insert: "isOnWall", kind: "Property" },
  { label: "isOnSlope", detail: "True when grounded on a slope steeper than slopeMinAngle (read-only)", insert: "isOnSlope", kind: "Property" },
  { label: "groundAngle", detail: "Live angle (deg) of the steepest walkable ground contact this step (read-only)", insert: "groundAngle", kind: "Property" },
];
const CONTROLLER_API_JUMPABLE = CONTROLLER_API_WALK_COMMON.concat([
  { label: "canJump", detail: "Whether jump is enabled", insert: "canJump = ", kind: "Property" },
  { label: "jumpForce", detail: "Upward velocity applied on jump (px/s)", insert: "jumpForce = ", kind: "Property" },
  { label: "maxJumps", detail: "1 = no double jump, 2 = double jump, etc.", insert: "maxJumps = ", kind: "Property" },
  { label: "isGrounded", detail: "True when touching the ground (read-only)", insert: "isGrounded", kind: "Property" },
  { label: "simulateJump()", detail: "Trigger a jump from script, same as pressing Space — respects canJump/maxJumps", insert: "simulateJump()", kind: "Method" },
]);
const CONTROLLER_API_CHARACTER = CONTROLLER_API_JUMPABLE;
const CONTROLLER_API_PLATFORMER = CONTROLLER_API_JUMPABLE;
const CONTROLLER_API_TOP_DOWN = CONTROLLER_API_WALK_COMMON;
const CONTROLLER_API_CAR = [
  { label: "controllerType", detail: "'Car' (read-only)", insert: "controllerType", kind: "Property" },
  { label: "maxSpeed", detail: "Top forward speed in px/s (reverse caps at half this)", insert: "maxSpeed = ", kind: "Property" },
  { label: "acceleration", detail: "How fast the car speeds up (px/s²)", insert: "acceleration = ", kind: "Property" },
  { label: "brakeForce", detail: "How fast it brakes / goes into reverse (px/s²)", insert: "brakeForce = ", kind: "Property" },
  { label: "turnSpeed", detail: "Max turn rate in deg/s at full speed (scales down at lower speeds)", insert: "turnSpeed = ", kind: "Property" },
  { label: "driftFactor", detail: "0-1: how much lateral velocity is retained (higher = more slide)", insert: "driftFactor = ", kind: "Property" },
  { label: "useDefaultInput", detail: "Whether WASD/Arrows (throttle/brake/steer) are wired automatically", insert: "useDefaultInput = ", kind: "Property" },
];
const CONTROLLER_API_FOLLOW = [
  { label: "controllerType", detail: "'Follow' (read-only)", insert: "controllerType", kind: "Property" },
  { label: "targetName", detail: "Name of the entity to pursue", insert: 'targetName = "', kind: "Property" },
  { label: "followSpeed", detail: "Pursuit speed in px/s", insert: "followSpeed = ", kind: "Property" },
  { label: "followDistance", detail: "Stop when within this many pixels of the target", insert: "followDistance = ", kind: "Property" },
];
const CONTROLLER_API_FREE = [
  { label: "controllerType", detail: "'Free' — fully script-driven. Drive this.rigidbody directly.", insert: "controllerType", kind: "Property" },
];

const ANIMATOR_API = [
  { label: "play(clipName)", detail: "Play a named animation clip", insert: 'play("', kind: "Method" },
  { label: "stop()", detail: "Stop the current animation", insert: "stop()", kind: "Method" },
  { label: "playing", detail: "True while an animation is playing (read-only)", insert: "playing", kind: "Property" },
  { label: "currentClip", detail: "Name of the currently active clip (read-only)", insert: "currentClip", kind: "Property" },
];

const CAMERA_API = [
  { label: "zoom", detail: "Camera size/zoom. Default 5 = no zoom. Smaller = zoomed in, larger = zoomed out.", insert: "zoom = ", kind: "Property" },
  { label: "shake(intensity, duration)", detail: "Shake the camera. intensity=pixels of shake, duration=seconds.", insert: "shake(${1:intensity}, ${2:duration})", kind: "Method", snippet: true },
  { label: "renderToSprite(spriteEntity)", detail: "Render this camera's view onto a sprite's texture every frame (minimap / security feed).", insert: "renderToSprite(${1:spriteEntity})", kind: "Method", snippet: true },
];

const AUDIO_API = [
  { label: "play()", detail: "Start audio playback", insert: "play()", kind: "Method" },
  { label: "stop()", detail: "Stop audio playback", insert: "stop()", kind: "Method" },
  { label: "volume", detail: "Volume: 0.0 (silent) to 1.0 (full)", insert: "volume = ", kind: "Property" },
  { label: "playing", detail: "True while the source is set to play (read-only)", insert: "playing", kind: "Property" },
];

const THIS_SHORTCUTS_BASE = [
  { label: "x", detail: "Position X (number)", insert: "x", kind: "Property" },
  { label: "y", detail: "Position Y (number)", insert: "y", kind: "Property" },
  { label: "position", detail: "{ x, y } position object — read or assign {x,y}", insert: "position", kind: "Property" },
  { label: "rotation", detail: "Rotation in degrees", insert: "rotation = ", kind: "Property" },
  { label: "scaleX", detail: "Scale X", insert: "scaleX = ", kind: "Property" },
  { label: "scaleY", detail: "Scale Y", insert: "scaleY = ", kind: "Property" },
  { label: "translate(dx, dy)", detail: "Move by a delta amount this frame", insert: "translate(${1:dx}, ${2:dy})", kind: "Method", snippet: true },
  { label: "visible", detail: "Show/hide the entity", insert: "visible = ", kind: "Property" },
  { label: "enabled", detail: "Enable/disable this script", insert: "enabled = ", kind: "Property" },
  { label: "name", detail: "The entity's name, set in the Hierarchy panel (read-only)", insert: "name", kind: "Property" },
  { label: "tag", detail: "The entity's tag, set in the Inspector's Tag dropdown (read/write)", insert: "tag", kind: "Property" },
  { label: "destroy()", detail: "Destroy this entity — removed at end of frame, onDestroy() fires just before removal", insert: "destroy()", kind: "Method" },
  { label: "destroyed", detail: "True once destroy() has been called (read-only)", insert: "destroyed", kind: "Property" },
];

const GLOBAL_APIS = [
  { label: "find(name)", detail: 'Find entity by name. Returns an object with .x, .y, .sprite, .rigidbody, etc.', insert: 'find("', kind: "Function" },
  { label: "scene", detail: "Scene utilities: scene.find(), scene.load(), scene.restart()", insert: "scene.", kind: "Module" },
  { label: "physics", detail: "Physics utilities: physics.raycast(x1,y1,x2,y2)", insert: "physics.", kind: "Module" },
  { label: "input", detail: "Input queries: input.keyDown(key), input.keyPressed(key)", insert: "input.", kind: "Module" },
  { label: "time", detail: "Frame timing: time.deltaTime, time.elapsed", insert: "time.", kind: "Module" },
  { label: "random", detail: "Random numbers: random.int(min,max), random.float(min,max)", insert: "random.", kind: "Module" },
  { label: "global", detail: "Cross-script shared state: global.score = 0, global.lives, etc.", insert: "global.", kind: "Module" },
  { label: "debug", detail: "On-screen debug HUD: debug.show(), debug.log(label, value)", insert: "debug.", kind: "Module" },
  { label: "sendMessage(tag, message, data)", detail: 'Send a named message to all entities with the given tag. E.g. sendMessage("Enemy", "takeDamage", { amount: 10 })', insert: 'sendMessage("', kind: "Function" },
  { label: "broadcastMessage(message, data)", detail: 'Send a named message to ALL entities in the scene. E.g. broadcastMessage("gameOver")', insert: 'broadcastMessage("', kind: "Function" },
];

const SCENE_API = [
  { label: "find(name)", detail: "Find entity by name (same as the top-level find() shortcut)", insert: 'find("', kind: "Method" },
  { label: "load(sceneName)", detail: "Load a different scene by name", insert: 'load("', kind: "Method" },
  { label: "restart()", detail: "Restart the current scene from the beginning", insert: "restart()", kind: "Method" },
];
const PHYSICS_API = [
  { label: "raycast(x1, y1, x2, y2)", detail: "Cast a ray from (x1,y1) to (x2,y2). Returns { entity, point, distance } or null.", insert: "raycast(${1:x1}, ${2:y1}, ${3:x2}, ${4:y2})", kind: "Method", snippet: true },
];
const INPUT_API = [
  { label: "keyDown(key)", detail: 'Is the key currently held? Use key codes like "ArrowLeft", "Space", "KeyA"', insert: 'keyDown("', kind: "Method" },
  { label: "keyPressed(key)", detail: 'Was the key pressed this frame only (not held)? Same key codes as keyDown.', insert: 'keyPressed("', kind: "Method" },
];
const TIME_API = [
  { label: "deltaTime", detail: "Seconds since the last frame (use to keep movement frame-rate independent)", insert: "deltaTime", kind: "Property" },
  { label: "elapsed", detail: "Total seconds since the game started", insert: "elapsed", kind: "Property" },
];
const RANDOM_API = [
  { label: "int(min, max)", detail: "Random integer in [min, max] inclusive", insert: "int(${1:min}, ${2:max})", kind: "Method", snippet: true },
  { label: "float(min, max)", detail: "Random float in [min, max)", insert: "float(${1:min}, ${2:max})", kind: "Method", snippet: true },
];
const DEBUG_API = [
  { label: "show(on)", detail: "Turn the on-screen debug HUD on (default) or off — debug.show(false) hides it", insert: "show(${1:true})", kind: "Method", snippet: true },
  { label: "showFps(on)", detail: "Show/hide just the FPS line while the HUD stays on", insert: "showFps(${1:true})", kind: "Method", snippet: true },
  { label: "log(label, value)", detail: 'Add/update a custom HUD line, e.g. debug.log("Player HP", this.hp)', insert: 'log("', kind: "Method" },
  { label: "clear(label)", detail: "Remove one custom HUD line by its label", insert: 'clear("', kind: "Method" },
  { label: "clearAll()", detail: "Remove every custom HUD line", insert: "clearAll()", kind: "Method" },
];

// ─── Live scene data helpers ──────────────────────────────────────────────────

/** All entity names in the current scene (deduped, sorted). */
function _getEntityNames() {
  if (!editorState.world) return [];
  const entities = editorState.world.getAllEntities();
  const names = new Set();
  for (const e of entities) if (e.name) names.add(e.name);
  return [...names].sort();
}

/** All unique entity tags in the current scene (deduped, sorted). */
function _getEntityTags() {
  if (!editorState.world) return [];
  const entities = editorState.world.getAllEntities();
  const tags = new Set();
  for (const e of entities) if (e.tag) tags.add(e.tag);
  return [...tags].sort();
}

/** All scene names from the scene list. */
function _getSceneNames() {
  try {
    const list = getSceneList();
    return list.map(s => s.name).filter(Boolean).sort();
  } catch (_) { return []; }
}

/** All sprite/texture asset names in the project. */
function _getTextureNames() {
  try {
    return getAllSpriteAssets().map(a => a.name || a.key).filter(Boolean).sort();
  } catch (_) { return []; }
}

/** All audio asset names in the project. */
function _getAudioNames() {
  try {
    return getAllAudioAssets().map(a => a.name || a.key).filter(Boolean).sort();
  } catch (_) { return []; }
}

/** Animation clip names for the context entities (animator.play completions). */
function _getAnimClipNames() {
  const entities = _getContextEntities();
  const names = new Set();
  for (const e of entities) {
    const anim = e.getComponent(SPRITE_ANIMATION);
    if (anim && anim.clips) {
      for (const clip of anim.clips) if (clip.name) names.add(clip.name);
    }
  }
  // Also scan all scene entities in case script is unassigned
  if (names.size === 0 && editorState.world) {
    for (const e of editorState.world.getAllEntities()) {
      const anim = e.getComponent(SPRITE_ANIMATION);
      if (anim && anim.clips) {
        for (const clip of anim.clips) if (clip.name) names.add(clip.name);
      }
    }
  }
  return [...names].sort();
}

// ─── String-argument context detection ───────────────────────────────────────
// Returns a string tag describing what kind of completions to provide when
// the cursor is inside a string argument (trigger character `"`).
//
// Patterns are ordered from most-specific to least-specific so the first
// match wins.
function _detectStringContext(lineUntil) {
  // Each pattern matches the opening quote followed by zero or more characters
  // that are not a closing quote — so completions keep working as the user
  // types partial text inside the string (not just immediately after the quote).
  const q = `["'][^"']*`;

  // input.keyDown(" / input.keyPressed(" / input.keyUp(" etc.
  if (new RegExp(`\\binput\\s*\\.\\s*key\\w*\\s*\\(\\s*${q}$`).test(lineUntil)) return "keyCode";

  // scene.load("
  if (new RegExp(`\\bscene\\s*\\.\\s*load\\s*\\(\\s*${q}$`).test(lineUntil)) return "sceneName";

  // scene.find("
  if (new RegExp(`\\bscene\\s*\\.\\s*find\\s*\\(\\s*${q}$`).test(lineUntil)) return "entityName";

  // find("  (top-level shortcut or this.find — any context)
  if (new RegExp(`\\bfind\\s*\\(\\s*${q}$`).test(lineUntil)) return "entityName";

  // animator.play("
  if (new RegExp(`\\banimator\\s*\\.\\s*play\\s*\\(\\s*${q}$`).test(lineUntil)) return "clipName";

  // .texture = " or .texture = '
  if (new RegExp(`\\.texture\\s*=\\s*${q}$`).test(lineUntil)) return "textureName";

  // sendMessage(tag, ...) — first argument is a tag
  if (new RegExp(`\\bsendMessage\\s*\\(\\s*${q}$`).test(lineUntil)) return "entityTag";

  // .tag === " / .tag == " / .tag !== "
  if (new RegExp(`\\.tag\\s*[!=]==?\\s*${q}$`).test(lineUntil)) return "entityTag";

  // .name === " / .name == " / .name !== "
  if (new RegExp(`\\.name\\s*[!=]==?\\s*${q}$`).test(lineUntil)) return "entityName";

  // controller.targetName = "
  if (new RegExp(`\\.targetName\\s*=\\s*${q}$`).test(lineUntil)) return "entityName";

  // broadcastMessage("  — first arg is a message label
  if (new RegExp(`\\bbroadcastMessage\\s*\\(\\s*${q}$`).test(lineUntil)) return "messageLabel";

  return null;
}

// ─── Whole-document diagnostics (typo squiggles) ──────────────────────────────
// Scans the full script text for calls whose string argument we can verify
// against live scene/project data (find("Player"), input.keyDown("KeyA"),
// .texture = "icon", etc.) and flags values that don't match anything that
// currently exists — the classic "works until Play mode, then silently no-ops"
// class of bug (misspelled entity name, wrong key code, renamed texture).
//
// This is intentionally separate from Monaco's built-in JS diagnostics
// (which stay disabled — see ScriptEditorWindow.js) so it can't get
// confused by engine-only globals like `find`/`this.transform` that aren't
// real JS. Markers are owned under a private marker "owner" name so they
// never collide with or get cleared by any other diagnostics source.
const DIAGNOSTIC_OWNER = "zenengine-string-args";

// One entry per validated call pattern: regex captures the string value,
// `values()` returns the current valid set, `label` is used in the message.
// The regex is intentionally the same shape as _detectStringContext's
// patterns but anchored to a full call (opening AND closing quote) instead
// of "up to the cursor", since this runs on the whole document, not live
// per-keystroke.
function _diagnosticRules() {
  return [
    {
      label: "key code",
      regex: /\binput\s*\.\s*key\w*\s*\(\s*["']([^"']*)["']/g,
      values: () => new Set(ALL_KEY_CODES),
      hint: (v) => `Unknown key code "${v}". Check spelling — key codes are case-sensitive (e.g. "KeyA", "Space", "ArrowLeft").`,
    },
    {
      label: "scene name",
      regex: /\bscene\s*\.\s*load\s*\(\s*["']([^"']*)["']/g,
      values: () => new Set(_getSceneNames()),
      hint: (v) => `No scene named "${v}" found in the project.`,
    },
    {
      label: "entity name",
      regex: /\b(?:scene\s*\.\s*find|find)\s*\(\s*["']([^"']*)["']/g,
      values: () => new Set(_getEntityNames()),
      hint: (v) => `No object named "${v}" found in the current scene.`,
    },
    {
      label: "animation clip",
      regex: /\banimator\s*\.\s*play\s*\(\s*["']([^"']*)["']/g,
      values: () => new Set(_getAnimClipNames()),
      hint: (v) => `No animation clip named "${v}" on this object.`,
    },
    {
      label: "texture",
      regex: /\.texture\s*=\s*["']([^"']*)["']/g,
      values: () => new Set(_getTextureNames()),
      hint: (v) => `No sprite/texture asset named "${v}" found in the project.`,
    },
    {
      label: "entity tag",
      regex: /\bsendMessage\s*\(\s*["']([^"']*)["']/g,
      values: () => new Set(_getEntityTags()),
      hint: (v) => `No object in the scene currently has the tag "${v}".`,
    },
    {
      label: "entity tag",
      regex: /\.tag\s*[!=]==?\s*["']([^"']*)["']/g,
      values: () => new Set(_getEntityTags()),
      hint: (v) => `No object in the scene currently has the tag "${v}".`,
    },
    {
      label: "entity name",
      regex: /\.name\s*[!=]==?\s*["']([^"']*)["']/g,
      values: () => new Set(_getEntityNames()),
      hint: (v) => `No object named "${v}" found in the current scene.`,
    },
    {
      label: "entity name",
      regex: /\.targetName\s*=\s*["']([^"']*)["']/g,
      values: () => new Set(_getEntityNames()),
      hint: (v) => `No object named "${v}" found in the current scene. The Follow controller needs targetName to match an existing object's name exactly.`,
    },
  ];
}

/** Scan the model's full text and return Monaco marker objects for any
 *  string-argument value that doesn't match live scene/project data.
 *  Empty strings ("" — still being typed) are skipped so half-typed code
 *  never gets flagged. */
function _computeDiagnostics(monaco, model) {
  const text = model.getValue();
  const markers = [];
  const rules = _diagnosticRules();

  for (const rule of rules) {
    const valid = rule.values();
    // Nothing to validate against yet (e.g. no textures imported) — skip
    // rather than flag every single call as wrong.
    if (valid.size === 0) continue;

    rule.regex.lastIndex = 0;
    let m;
    while ((m = rule.regex.exec(text)) !== null) {
      const value = m[1];
      if (!value) continue; // still-empty string, nothing to check yet
      if (valid.has(value)) continue;

      // m[1] is captured by the regex's own group, so its offset within
      // the full match is exactly m[0].length minus everything after the
      // value (the value itself + its closing quote character). This is
      // unambiguous — unlike searching for `value` inside m[0], which
      // could match the wrong spot if the value text happens to repeat.
      const valueStart = m.index + m[0].length - value.length - 1;
      const startPos = model.getPositionAt(valueStart);
      const endPos = model.getPositionAt(valueStart + value.length);

      markers.push({
        severity: monaco.MarkerSeverity.Warning,
        message: rule.hint(value),
        startLineNumber: startPos.lineNumber,
        startColumn: startPos.column,
        endLineNumber: endPos.lineNumber,
        endColumn: endPos.column,
        source: "ZenEngine",
      });
    }
  }

  return markers;
}

/** Re-run diagnostics on a model and apply them as squiggly-underline
 *  markers. Safe to call often — pass a debounced caller from the editor
 *  (see ScriptEditorWindow.js) so it doesn't re-scan on every keystroke. */
export function refreshScriptDiagnostics(monaco, model) {
  if (!monaco || !model || model.isDisposed()) return;
  try {
    const markers = _computeDiagnostics(monaco, model);
    monaco.editor.setModelMarkers(model, DIAGNOSTIC_OWNER, markers);
  } catch (e) {
    // Never let a diagnostics bug break the editor itself.
    console.warn("[ZenEngine IntelliSense] diagnostics pass failed:", e);
  }
}

/** Clear any diagnostics markers previously applied to a model (called
 *  when a model is disposed so stale markers don't linger). */
export function clearScriptDiagnostics(monaco, model) {
  if (!monaco || !model || model.isDisposed()) return;
  try {
    monaco.editor.setModelMarkers(model, DIAGNOSTIC_OWNER, []);
  } catch (e) {}
}



function _parseFindVariables(text) {
  const map = {};
  const regex = /(?:\b(?:var|let|const)\s+)?(\w+)\s*=\s*find\s*\(\s*["']([^"']+)["']\s*\)/g;
  let match;
  while ((match = regex.exec(text)) !== null) {
    map[match[1]] = match[2];
  }
  return map;
}

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

function _rigidbodyApiForBodyType(bodyType) {
  if (bodyType === BodyType.DYNAMIC) return RIGIDBODY_API_DYNAMIC;
  if (bodyType === BodyType.KINEMATIC) return RIGIDBODY_API_KINEMATIC;
  return RIGIDBODY_API_STATIC;
}

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

function _contextComponentKeys() {
  const entities = _getContextEntities();
  const set = new Set();
  for (const e of entities) {
    for (const c of COMPONENT_APIS) {
      if (e.hasComponent(c.key)) set.add(c.key);
    }
  }
  const se = editorState.scriptEditor;
  const forced = (se.forcedApis && se.activeTab && se.forcedApis[se.activeTab]) || [];
  for (const f of forced) set.add(f);
  return set;
}

// Union of every rigidbody API across all body types — for untracked paths.
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

const COMPONENT_APIS = [
  { key: TRANSFORM, name: "transform", api: TRANSFORM_API },
  { key: SPRITE_RENDERER, name: "sprite", api: SPRITE_API },
  { key: RIGIDBODY_2D, name: "rigidbody", api: RIGIDBODY_API_ALL },
  { key: SPRITE_ANIMATION, name: "animator", api: ANIMATOR_API },
  { key: CAMERA, name: "camera", api: CAMERA_API },
  { key: AUDIO_SOURCE, name: "audio", api: AUDIO_API },
  { key: CHARACTER_CONTROLLER, name: "controller", api: CONTROLLER_API_ALL },
];

// ─── Completion item builder ──────────────────────────────────────────────────

function _kindConstant(monaco, kindName) {
  const K = monaco.languages.CompletionItemKind;
  switch (kindName) {
    case "Property":  return K.Property;
    case "Method":    return K.Method;
    case "Function":  return K.Function;
    case "Module":    return K.Module;
    case "Snippet":   return K.Snippet;
    case "Value":     return K.Value;
    case "Variable":  return K.Variable;
    case "Field":     return K.Field;
    default:          return K.Function;
  }
}

function _makeCompletion(monaco, item, range) {
  const insert = item.insert;
  const opensString = typeof insert === "string" && /["']$/.test(insert);

  const entry = {
    label: item.label,
    kind: _kindConstant(monaco, item.kind || "Function"),
    detail: item.detail || "",
    insertText: insert,
    range: range,
  };

  if (opensString) {
    // Items like find(", keyDown(", play(" end with an opening quote and
    // used to rely on Monaco's auto-closing-bracket feature to add the
    // matching closing quote. Auto-pairing only fires for characters the
    // user physically types — it never fires for text a completion item
    // inserts programmatically — so clicking these produced an unclosed
    // string (e.g. find(" instead of find("")) and left the cursor after
    // the quote with nothing to close it.
    // Fix: insert both quotes ourselves as a snippet, put the cursor
    // between them with $1, and immediately re-trigger suggestions so the
    // string-argument completion list (entity names, key codes, etc.)
    // shows up right away instead of requiring the quote to be retyped.
    const quoteChar = insert.slice(-1);
    entry.insertText = insert + "$1" + quoteChar;
    entry.insertTextRules = monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet;
    entry.command = { id: "editor.action.triggerSuggest", title: "Trigger Suggest" };
  } else if (item.snippet) {
    // Multi-argument (or otherwise non-string) calls like
    // addForce(${1:x}, ${2:y}) or raycast(${1:x1}, ${2:y1}, ...) — insert
    // as a real snippet so Tab walks through each argument in order
    // instead of leaving the user to guess the parameter count/order
    // after a bare "addForce(" with nothing else typed.
    entry.insertTextRules = monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet;
  } else if (typeof insert === "string" && insert.endsWith(".")) {
    // When the inserted text ends with "." the suggest widget does not
    // automatically re-open. Attach a command so Monaco immediately
    // re-triggers suggestions after insertion (e.g. "scene." → scene API).
    entry.command = { id: "editor.action.triggerSuggest", title: "Trigger Suggest" };
  }

  return entry;
}

/** Make a string-value completion item (entity name, key code, etc.), used
 *  when the cursor is already inside an open string (find("pl|"), etc.).
 *  insertText is the bare value. Whether a closing quote needs to be
 *  appended depends on what's actually in the document immediately after
 *  the completion range — NOT on Monaco auto-pairing, which (as above)
 *  never fires for programmatic inserts and can't be relied on here either.
 *  `hasClosingQuote` should reflect the real document state at the call site. */
function _makeValueCompletion(monaco, label, detail, insertText, range, hasClosingQuote) {
  let text = typeof insertText === "string" ? insertText.replace(/["']$/, "") : insertText;
  const entry = {
    label: label,
    kind: monaco.languages.CompletionItemKind.Value,
    detail: detail || "",
    insertText: text,
    range: range,
  };
  if (!hasClosingQuote && typeof text === "string") {
    // No closing quote exists yet in the document (e.g. the user typed
    // find(" and never got an auto-paired closer, or is editing inside an
    // already-unbalanced string) — add it ourselves and land the cursor
    // right after it rather than leaving the string open.
    entry.insertText = text + "$0" + '"';
    entry.insertTextRules = monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet;
  }
  return entry;
}

function _allCompletions(monaco, range) {
  const suggestions = [];
  for (const item of THIS_SHORTCUTS_BASE) {
    suggestions.push(_makeCompletion(monaco, item, range));
  }
  for (const c of COMPONENT_APIS) {
    for (const item of c.api) {
      suggestions.push(Object.assign(_makeCompletion(monaco, item, range), { label: c.name + "." + item.label }));
    }
    suggestions.push(_makeCompletion(monaco, { label: c.name, detail: c.name + " component", insert: c.name + ".", kind: "Module" }, range));
  }
  for (const item of GLOBAL_APIS) {
    suggestions.push(_makeCompletion(monaco, item, range));
  }
  return suggestions;
}

function _pushShortcutCompletions(monaco, range, suggestions, keys, entities) {
  for (const item of THIS_SHORTCUTS_BASE) {
    suggestions.push(_makeCompletion(monaco, item, range));
  }
}

// ─── Provider registration ────────────────────────────────────────────────────

export function registerIntelliSense(monaco) {
  if (_registered) return;
  _registered = true;

  monaco.languages.registerCompletionItemProvider("javascript", {
    triggerCharacters: [".", "(", '"', "'"],

    provideCompletionItems: function (model, position) {
      const textUntilPosition = model.getValueInRange({
        startLineNumber: 1,
        startColumn: 1,
        endLineNumber: position.lineNumber,
        endColumn: position.column,
      });

      const lineUntil = textUntilPosition.slice(textUntilPosition.lastIndexOf("\n") + 1);

      const word = model.getWordUntilPosition(position);
      const range = {
        startLineNumber: position.lineNumber,
        endLineNumber: position.lineNumber,
        startColumn: word.startColumn,
        endColumn: word.endColumn,
      };

      const suggestions = [];

      // ── String-argument context ──────────────────────────────────────────
      // Detect patterns like find("  scene.load("  input.keyDown("  .texture="
      // and return scene-aware / project-aware completions instead of code.
      const stringCtx = _detectStringContext(lineUntil);
      if (stringCtx) {
        // Does a closing quote already exist immediately where the string
        // ends? Checked against the real document instead of assuming
        // Monaco auto-paired one — auto-pairing only fires for keys the
        // user actually types, so a string opened by clicking a completion
        // (find(") or one the user is re-editing may have no closer at all.
        // We look at the rest of the current line: if the very next
        // character is the same quote character used to open the string,
        // treat it as already closed.
        const quoteMatch = lineUntil.match(/["']([^"']*)$/);
        const quoteChar = quoteMatch ? quoteMatch[0][0] : '"';
        const restOfLine = model.getLineContent(position.lineNumber).slice(position.column - 1);
        const hasClosingQuote = restOfLine.slice(0, 1) === quoteChar;

        if (stringCtx === "entityName") {
          const names = _getEntityNames();
          for (const name of names) {
            suggestions.push(_makeValueCompletion(
              monaco, name, "Scene object", name + '"', range, hasClosingQuote
            ));
          }
          return { suggestions };
        }

        if (stringCtx === "sceneName") {
          const scenes = _getSceneNames();
          for (const name of scenes) {
            suggestions.push(_makeValueCompletion(
              monaco, name, "Scene", name + '"', range, hasClosingQuote
            ));
          }
          return { suggestions };
        }

        if (stringCtx === "keyCode") {
          for (const key of ALL_KEY_CODES) {
            suggestions.push(_makeValueCompletion(
              monaco, key,
              KEY_DETAIL[key] || "Keyboard key code",
              key + '"',
              range,
              hasClosingQuote
            ));
          }
          return { suggestions };
        }

        if (stringCtx === "textureName") {
          const textures = _getTextureNames();
          for (const name of textures) {
            suggestions.push(_makeValueCompletion(
              monaco, name, "Sprite / texture asset", name + '"', range, hasClosingQuote
            ));
          }
          // If no textures yet, still return empty (don't fall through)
          return { suggestions };
        }

        if (stringCtx === "clipName") {
          const clips = _getAnimClipNames();
          for (const name of clips) {
            suggestions.push(_makeValueCompletion(
              monaco, name, "Animation clip", name + '"', range, hasClosingQuote
            ));
          }
          return { suggestions };
        }

        if (stringCtx === "entityTag") {
          const tags = _getEntityTags();
          for (const tag of tags) {
            suggestions.push(_makeValueCompletion(
              monaco, tag, "Entity tag", tag + '"', range, hasClosingQuote
            ));
          }
          return { suggestions };
        }

        if (stringCtx === "messageLabel") {
          // Scan the full script text for onMessage handlers to suggest
          // existing message labels (broadcastMessage("xxx") → "xxx").
          const fullText = model.getValue();
          const msgRegex = /broadcastMessage\s*\(\s*["']([^"']+)["']/g;
          const sendRegex = /sendMessage\s*\(\s*["'][^"']*["']\s*,\s*["']([^"']+)["']/g;
          const labels = new Set();
          let m;
          while ((m = msgRegex.exec(fullText)) !== null) labels.add(m[1]);
          while ((m = sendRegex.exec(fullText)) !== null) labels.add(m[1]);
          for (const lbl of [...labels].sort()) {
            suggestions.push(_makeValueCompletion(
              monaco, lbl, "Message label (used in this script)", lbl + '"', range, hasClosingQuote
            ));
          }
          return { suggestions };
        }

        return { suggestions: [] };
      }

      // ── this.<partial> → entity-aware completions ────────────────────────
      if (lineUntil.match(/\bthis\.\w*$/)) {
        const contextEntities = _getContextEntities();
        const keys = _contextComponentKeys();
        _pushShortcutCompletions(monaco, range, suggestions, keys, contextEntities);
        for (const c of COMPONENT_APIS) {
          if (keys.has(c.key)) {
            const api = c.key === RIGIDBODY_2D ? _rigidbodyApiForEntities(contextEntities)
              : c.key === CHARACTER_CONTROLLER ? _controllerApiForEntities(contextEntities)
              : c.api;
            for (const item of api) {
              suggestions.push(Object.assign(
                _makeCompletion(monaco, item, range),
                { label: c.name + "." + item.label, insertText: c.name + "." + item.insert }
              ));
            }
            suggestions.push(_makeCompletion(monaco, { label: c.name, detail: c.name + " component", insert: c.name + ".", kind: "Module" }, range));
          }
        }
        return { suggestions };
      }

      // ── <subobj>.<partial> → that sub-object's API ───────────────────────
      const subMatch = lineUntil.match(/(\w+)\.\w*$/);
      if (subMatch && subMatch[1] !== "this") {
        const subObj = subMatch[1];
        let items = null;
        let isKnownSubObj = false;

        const contextEntities = _getContextEntities();
        const hasContext = contextEntities.length > 0;
        const keys = hasContext ? _contextComponentKeys() : null;

        if (subObj === "transform") {
          isKnownSubObj = true;
          items = TRANSFORM_API;
        } else if (subObj === "sprite") {
          isKnownSubObj = true;
          if (!keys || keys.has(SPRITE_RENDERER)) items = SPRITE_API;
        } else if (subObj === "rigidbody") {
          isKnownSubObj = true;
          if (!keys || keys.has(RIGIDBODY_2D)) items = _rigidbodyApiForEntities(contextEntities);
        } else if (subObj === "animator") {
          isKnownSubObj = true;
          if (!keys || keys.has(SPRITE_ANIMATION)) items = ANIMATOR_API;
        } else if (subObj === "camera") {
          isKnownSubObj = true;
          if (!keys || keys.has(CAMERA)) items = CAMERA_API;
        } else if (subObj === "audio") {
          isKnownSubObj = true;
          if (!keys || keys.has(AUDIO_SOURCE)) items = AUDIO_API;
        } else if (subObj === "controller") {
          isKnownSubObj = true;
          if (!keys || keys.has(CHARACTER_CONTROLLER)) items = _controllerApiForEntities(contextEntities);
        } else if (subObj === "scene") {
          isKnownSubObj = true;
          items = SCENE_API;
        } else if (subObj === "physics") {
          isKnownSubObj = true;
          items = PHYSICS_API;
        } else if (subObj === "input") {
          isKnownSubObj = true;
          items = INPUT_API;
        } else if (subObj === "time") {
          isKnownSubObj = true;
          items = TIME_API;
        } else if (subObj === "random") {
          isKnownSubObj = true;
          items = RANDOM_API;
        } else if (subObj === "debug") {
          isKnownSubObj = true;
          items = DEBUG_API;
        }

        if (items) {
          for (const item of items) {
            suggestions.push(_makeCompletion(monaco, item, range));
          }
          return { suggestions };
        }
        if (isKnownSubObj) return { suggestions: [] };

        // Unknown sub-object — check if it's a tracked find() variable.
        const findVars = _parseFindVariables(textUntilPosition);
        if (findVars[subObj]) {
          const entityKeys = _entityComponentKeys(findVars[subObj]);
          if (entityKeys) {
            const foundEntity = editorState.world ? editorState.world.findFirstByName(findVars[subObj]) : null;
            const foundEntities = foundEntity ? [foundEntity] : [];
            _pushShortcutCompletions(monaco, range, suggestions, entityKeys, foundEntities);
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
                suggestions.push(_makeCompletion(monaco, { label: c.name, detail: c.name + " component", insert: c.name + ".", kind: "Module" }, range));
              }
            }
            return { suggestions };
          }
        }
        // Untracked variable — show the full API list.
        return { suggestions: _allCompletions(monaco, range) };
      }

      // ── Global / top-level ────────────────────────────────────────────────
      for (const item of GLOBAL_APIS) {
        suggestions.push(_makeCompletion(monaco, item, range));
      }

      // Lifecycle method snippets
      const snippets = [
        { label: "function onStart()", detail: "Called once before the first onUpdate — use for initialization", insert: "onStart() {\n  $1\n}" },
        { label: "function onUpdate(dt)", detail: "Called every frame. dt = seconds since last frame (use for movement)", insert: "onUpdate(dt) {\n  $1\n}" },
        { label: "function onFixedUpdate(dt)", detail: "Called at a fixed 60 Hz rate — use for physics/rigidbody changes", insert: "onFixedUpdate(dt) {\n  $1\n}" },
        { label: "function onCollision(other)", detail: "Called when this entity's collider touches another. 'other' has .x, .y, .name, .tag, etc.", insert: "onCollision(other) {\n  $1\n}" },
        { label: "function onCollisionEnter(other)", detail: "Called when collision begins. 'other' has .x, .y, .name, etc.", insert: "onCollisionEnter(other) {\n  $1\n}" },
        { label: "function onCollisionExit(other)", detail: "Called when collision ends.", insert: "onCollisionExit(other) {\n  $1\n}" },
        { label: "function onTriggerEnter(other)", detail: "Called when entering a trigger collider (Is Trigger = on)", insert: "onTriggerEnter(other) {\n  $1\n}" },
        { label: "function onTriggerExit(other)", detail: "Called when leaving a trigger collider", insert: "onTriggerExit(other) {\n  $1\n}" },
        { label: "function onMessage(message, sender, data)", detail: "Called when this entity receives a message via sendMessage() or broadcastMessage()", insert: "onMessage(message, sender, data) {\n  $1\n}" },
        { label: "function onDestroy()", detail: "Called once when this entity is destroyed or the scene ends", insert: "onDestroy() {\n  $1\n}" },
      ];
      for (const s of snippets) {
        suggestions.push({
          label: s.label,
          kind: monaco.languages.CompletionItemKind.Snippet,
          detail: s.detail,
          insertText: s.insert,
          insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
          range: range,
        });
      }

      return { suggestions };
    },
  });
}
