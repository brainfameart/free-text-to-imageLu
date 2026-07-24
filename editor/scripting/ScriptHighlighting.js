/**
 * editor/scripting/ScriptHighlighting.js
 *
 * Custom semantic-ish highlighting for ZenEngine scripts, layered on
 * top of Monaco's normal JavaScript tokenizer.
 *
 * Monaco's built-in JS grammar only knows generic token types
 * (keyword, identifier, string, etc.) — it has no idea that `input`,
 * `this.sprite`, or `.addForce(` are OUR engine's API surface rather
 * than an arbitrary user variable. To get real semantic coloring
 * (engine classes vs engine objects vs engine members vs plain user
 * code) without pulling in a full TypeScript type-checker, this file
 * takes a simpler, reliable approach:
 *
 *   1. A custom theme (zenengine-dark) defines four extra token
 *      colors on top of vs-dark's normal palette.
 *   2. A lightweight regex/scan pass runs on every content change and
 *      re-applies Monaco decorations (`deltaDecorations`) that tag
 *      matched ranges with CSS classes mapping to those token colors.
 *
 * This is intentionally NOT full semantic analysis — it's a curated
 * keyword-list match against the identifiers this engine actually
 * exposes (kept in sync with ScriptIntelliSense.js's own API tables).
 * That's enough to make ZenEngine's own API visually pop against
 * plain user code, which is the actual goal, without the cost/fragility
 * of a real type checker running in the browser.
 *
 * EDITOR-ONLY FILE.
 */

// ─── Color tiers ────────────────────────────────────────────────────────────
// 1. JavaScript keywords       → Monaco's normal keyword color (untouched)
// 2. Engine classes/globals    → the top-level names scripts are handed:
//                                find, scene, physics, input, time, random,
//                                global, debug, sendMessage, broadcastMessage
// 3. Engine objects            → the per-entity sub-objects hanging off
//                                `this`: transform, sprite, rigidbody,
//                                animator, camera, audio, controller
// 4. Engine methods/properties → members accessed off any of the above,
//                                e.g. .addForce(, .keyDown(, .position,
//                                .isGrounded, .velocityX — a large but
//                                curated list kept in sync with the
//                                autocomplete tables in ScriptIntelliSense.js
// 5. Everything else (user variables/functions) → Monaco's normal
//                                identifier color, i.e. left alone entirely.

const ENGINE_GLOBALS = [
  "find", "scene", "physics", "input", "time", "random", "global",
  "debug", "sendMessage", "broadcastMessage",
];

const ENGINE_LIFECYCLE = [
  "onStart", "onUpdate", "onFixedUpdate", "onCollision",
  "onCollisionEnter", "onCollisionExit", "onTriggerEnter",
  "onTriggerExit", "onMessage", "onDestroy",
];

const ENGINE_OBJECTS = [
  "transform", "sprite", "rigidbody", "animator", "camera", "audio", "controller",
];

// Members accessed off an engine global/object, e.g. input.keyDown(...),
// this.rigidbody.addForce(...), this.transform.position. Deliberately
// excludes generic single-purpose names (x, y, name, type, key, entity)
// that are too likely to collide with the user's own variables/fields —
// those stay uncolored (tier 5) rather than risk false positives.
const ENGINE_MEMBERS = [
  // Transform
  "position", "rotation", "scale", "scaleX", "scaleY", "translate", "lookAt",
  // Sprite
  "texture", "color", "flipX", "flipY", "opacity",
  // Rigidbody (common + dynamic + kinematic)
  "velocity", "velocityX", "velocityY", "mass", "gravityScale",
  "linearDamping", "angularDamping", "addForce", "addImpulse", "addTorque",
  "addAngularImpulse", "move", "isGrounded", "isOnCeiling", "isOnWall",
  "isOnSlope", "groundAngle", "resolvedVelocity", "groundAngleLimit",
  "wallAngleLimit", "slopeMinAngle",
  // Controller (walk + car variants)
  "controllerType", "moveSpeed", "acceleration", "airControl", "useGravity",
  "useDefaultInput", "simulateMove", "simulateJump", "canJump", "jumpForce",
  "maxJumps", "maxSpeed", "turnSpeed", "brakeForce", "driftFactor",
  "followDistance", "followSpeed", "targetName",
  // Animator
  "play", "stop", "playing", "currentClip",
  // Camera
  "zoom", "shake", "renderToSprite",
  // Audio
  "volume",
  // Scene
  "load", "restart",
  // Physics
  "raycast",
  // Input
  "keyDown", "keyPressed",
  // Time
  "deltaTime", "elapsed",
  // Random
  "int", "float",
  // Debug
  "show", "showFps", "log", "clear", "clearAll",
  // Entity-level (this.*, not tied to a sub-object)
  "destroy", "destroyed", "visible", "enabled", "tag",
];

const THEME_NAME = "zenengine-dark";

let _themeDefined = false;
let _decorationIds = {}; // scriptName -> string[] (last applied decoration ids for that model)

/**
 * Defines the zenengine-dark theme once. Extends vs-dark's normal
 * palette (keywords, strings, comments, numbers all untouched) and
 * adds three extra token colors for our own classes.
 */
export function defineZenTheme(monaco) {
  if (_themeDefined) return;
  monaco.editor.defineTheme(THEME_NAME, {
    base: "vs-dark",
    inherit: true,
    rules: [
      // Engine classes/globals (find, scene, physics, input, time,
      // random, global, debug, sendMessage, broadcastMessage) — a
      // warm gold, distinct from both keywords (blue) and strings
      // (orange), so they read as "this is a Thing the engine gives you".
      { token: "zen-global", foreground: "e0af68", fontStyle: "bold" },
      // Engine objects (this.sprite, this.rigidbody, etc.) — teal,
      // visually a sibling of the gold globals but clearly a
      // different tier (per-entity, not top-level).
      { token: "zen-object", foreground: "56c2c0", fontStyle: "bold" },
      // Engine methods/properties (.addForce, .keyDown, .position, ...)
      // — a soft, subtle lavender. Deliberately lower-contrast than
      // the two tiers above since these appear constantly and
      // shouldn't visually dominate every line that touches the API.
      { token: "zen-member", foreground: "9d9dc7" },
      // Script lifecycle callbacks — bright violet so the functions that
      // ZenEngine invokes automatically stand out from user functions.
      { token: "zen-lifecycle", foreground: "c586c0", fontStyle: "bold" },
    ],
    colors: {},
  });
  _themeDefined = true;
}

/**
 * Scans `model`'s current text for engine identifiers and applies
 * Monaco decorations with the matching zen-* CSS class. Called on
 * every content change (debounced by the caller) and on tab switch.
 *
 * Approach: three passes with word-boundary regexes built from the
 * curated lists above.
 *   - ENGINE_GLOBALS: matched as bare identifiers anywhere (they're
 *     top-level names — as parameters/variables in this scripting
 *     context, they only ever refer to the engine API).
 *   - ENGINE_OBJECTS: matched only right after "this." or ".", since
 *     e.g. "camera" as a bare word could be a user's own variable, but
 *     "this.camera" / "someEntity.camera" is unambiguous.
 *   - ENGINE_MEMBERS: matched only right after a "." (property/method
 *     access position), same reasoning — "velocity" alone could be a
 *     user variable, but ".velocity" is a property read on some object.
 *
 * This is a lightweight lexical scan rather than a full JavaScript parser.
 * It tracks quoted strings, template strings, line comments, and block
 * comments before matching identifiers. This keeps highlighting reliable
 * across Monaco versions: model.getLineTokens() is not part of the public
 * ITextModel API in the Monaco build used by this project.
 */
export function applyZenDecorations(monaco, editorInstance, model, scriptName) {
  if (!monaco || !editorInstance || !model) return;

  const text = model.getValue();
  const decorations = [];

  function buildCodeMask(source) {
    const mask = new Array(source.length).fill(true);
    let state = "code";
    let quote = "";

    for (let i = 0; i < source.length; i++) {
      const ch = source[i];
      const next = source[i + 1];

      if (state === "line-comment") {
        mask[i] = false;
        if (ch === "\n") state = "code";
        continue;
      }
      if (state === "block-comment") {
        mask[i] = false;
        if (ch === "*" && next === "/") {
          mask[i + 1] = false;
          i++;
          state = "code";
        }
        continue;
      }
      if (state === "string") {
        mask[i] = false;
        if (ch === "\\") {
          if (i + 1 < source.length) mask[i + 1] = false;
          i++;
        } else if (ch === quote) {
          state = "code";
        }
        continue;
      }

      if (ch === "/" && next === "/") {
        mask[i] = false;
        mask[i + 1] = false;
        i++;
        state = "line-comment";
      } else if (ch === "/" && next === "*") {
        mask[i] = false;
        mask[i + 1] = false;
        i++;
        state = "block-comment";
      } else if (ch === "'" || ch === '"' || ch === "`") {
        mask[i] = false;
        quote = ch;
        state = "string";
      }
    }
    return mask;
  }

  const codeMask = buildCodeMask(text);

  function addMatches(regex, className) {
    let m;
    regex.lastIndex = 0;
    while ((m = regex.exec(text))) {
      const word = m[1] || m[0];
      const matchStart = m.index + m[0].lastIndexOf(word);
      let isCode = true;
      for (let i = matchStart; i < matchStart + word.length; i++) {
        if (!codeMask[i]) {
          isCode = false;
          break;
        }
      }
      if (!isCode) continue;
      const pos = model.getPositionAt(matchStart);
      const endPos = model.getPositionAt(matchStart + word.length);
      decorations.push({
        range: new monaco.Range(pos.lineNumber, pos.column, endPos.lineNumber, endPos.column),
        options: { inlineClassName: className },
      });
    }
  }

  const globalsPattern = "\\b(" + ENGINE_GLOBALS.join("|") + ")\\b";
  addMatches(new RegExp(globalsPattern, "g"), "zen-token-global");

  const objectsPattern = "(?:\\bthis\\.|\\.)(" + ENGINE_OBJECTS.join("|") + ")\\b";
  addMatches(new RegExp(objectsPattern, "g"), "zen-token-object");

  const membersPattern = "\\.(" + ENGINE_MEMBERS.join("|") + ")\\b";
  addMatches(new RegExp(membersPattern, "g"), "zen-token-member");

  const lifecyclePattern = "\\b(" + ENGINE_LIFECYCLE.join("|") + ")\\b";
  addMatches(new RegExp(lifecyclePattern, "g"), "zen-token-lifecycle");

  const prevIds = _decorationIds[scriptName] || [];
  _decorationIds[scriptName] = editorInstance.deltaDecorations(prevIds, decorations);
}

/**
 * Drops cached decoration ids for a script — call when a tab/model is
 * disposed so deltaDecorations isn't handed stale ids on next open.
 */
export function clearZenDecorations(scriptName) {
  delete _decorationIds[scriptName];
}

// Inject the CSS classes the decorations above reference. Monaco's
// inlineClassName only takes effect if the class actually exists in
// the page's stylesheet — these three lines are that stylesheet.
(function injectZenTokenCSS() {
  if (document.getElementById("zenengine-token-css")) return;
  var style = document.createElement("style");
  style.id = "zenengine-token-css";
  style.textContent =
    ".zen-token-global{color:#e0af68!important;font-weight:600;}" +
    ".zen-token-object{color:#56c2c0!important;font-weight:600;}" +
    ".zen-token-member{color:#9d9dc7!important;}" +
    ".zen-token-lifecycle{color:#c586c0!important;font-weight:600;}";
  document.head.appendChild(style);
})();
