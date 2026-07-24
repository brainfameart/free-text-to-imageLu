/**
 * editor/viewport/play-popup.js
 *
 * Boots inside the play-mode popup window (play-popup.html). This is
 * editor tooling, NOT part of /player — but it imports ONLY from
 * /runtime for the actual game (same rule as /player: what you see here
 * must be identical to a real exported build, no editor-only rendering
 * path). Reads the scene JSON + target resolution handed to it by
 * PlayWindow.js through window.opener.__ZENGINE_PLAY_PAYLOAD__, then:
 *   1. Creates a PIXI Application at the EXACT camera resolution
 *      (runtime/core/CameraUtils.js is the single source of truth for
 *      that resolution — same function the editor's CameraGizmo uses).
 *   2. Loads the current in-editor scene data into a brand new World.
 *   3. Starts the GameLoop. No grid, no gizmos — game time.
 * AspectFit: if the popup's actual window is bigger/smaller than the
 * target resolution (user resized it, or it got clamped to fit the
 * screen), the canvas is scaled via CSS transform to fit centered with
 * letterbox bars, without changing the game's internal resolution.
 */

import { createGame } from "../../runtime/index.js";
import { registerTexture, registerAudio } from "../../runtime/assets/AssetManager.js";
import { RenderSystem } from "../../runtime/systems/RenderSystem.js";
import { CAMERA } from "../../runtime/components/Camera.js";
import { TRANSFORM } from "../../runtime/components/Transform.js";

/**
 * Rebuilds this popup's own AssetManager texture cache from the
 * dataUrls handed over in the payload. Required because this popup is
 * a separate module realm from the editor: its import of
 * AssetManager.js gets a brand new, empty _textureCache, so any sprite
 * imported in the editor is otherwise unknown here and falls back to
 * the pink missing-texture marker.
 * @param {Array<{key:string,dataUrl:string}>} spriteAssets
 */
function loadSpriteAssets(spriteAssets) {
  const loads = (spriteAssets || []).map(
    ({ key, dataUrl }) =>
      new Promise((resolve) => {
        const img = new Image();
        img.onload = () => {
          try {
            const baseTexture = PIXI.BaseTexture.from(img);
            registerTexture(key, new PIXI.Texture(baseTexture));
          } catch (err) {
            console.error("[play] Failed to register texture for", key, err);
          }
          resolve();
        };
        img.onerror = () => {
          console.error("[play] Failed to decode image asset for", key);
          resolve();
        };
        img.src = dataUrl;
      })
  );
  return Promise.all(loads);
}

/**
 * Same reasoning as loadSpriteAssets() above, for audio: this popup's
 * import of AssetManager.js gets a brand new, empty _audioCache, so
 * any imported audio clip is otherwise unknown here and every
 * AudioSource would silently resolve to nothing and never play.
 * @param {Array<{key:string,dataUrl:string}>} audioAssets
 */
function loadAudioAssets(audioAssets) {
  for (const { key, dataUrl } of audioAssets || []) {
    registerAudio(key, dataUrl);
  }
}

/**
 * Wraps this popup's console.log/warn/error so every call is ALSO
 * posted to the editor window as a "zengine_console_log" message —
 * this is what makes a script's plain console.log("...") calls (not
 * just thrown errors) show up in the editor's Console panel while
 * Play mode is running in this separate popup window/document.
 */
function _wireConsoleForwarding() {
  function forwardLog(level, args) {
    if (!(window.opener && !window.opener.closed)) return;
    const text = args
      .map(function (a) {
        if (a instanceof Error) return a.message;
        if (typeof a === "object" && a !== null) {
          try { return JSON.stringify(a); } catch (e) { return String(a); }
        }
        return String(a);
      })
      .join(" ");
    window.opener.postMessage({
      type: "zengine_console_log",
      level: level,
      message: text,
    }, "*");
  }

  const realLog = console.log.bind(console);
  const realWarn = console.warn.bind(console);
  const realError = console.error.bind(console);

  console.log = function (...args) {
    realLog(...args);
    forwardLog("log", args);
  };
  console.warn = function (...args) {
    realWarn(...args);
    forwardLog("warn", args);
  };
  console.error = function (...args) {
    realError(...args);
    forwardLog("error", args);
  };
}

/**
 * Creates the (initially hidden) debug HUD overlay element — a small
 * fixed-position monospace panel in the top-left corner of the game
 * window. Positioned as a sibling of #game-canvas inside #letterbox so
 * it sits on top of the PIXI canvas regardless of AspectFit scaling
 * (the canvas itself is scaled via CSS transform — see applyAspectFit
 * below — but this overlay is NOT, so its text always stays crisp and
 * readable at 1:1 size no matter how small/large the game view is).
 */
function createDebugOverlay() {
  const el = document.createElement("div");
  el.id = "zengine-debug-hud";
  el.style.cssText =
    "position:absolute; top:8px; left:8px; z-index:9999; " +
    "font:12px/1.5 'Consolas','Menlo',monospace; color:#0f0; " +
    "background:rgba(0,0,0,0.6); padding:6px 10px; border-radius:4px; " +
    "white-space:pre; pointer-events:none; display:none;";
  document.body.appendChild(el);
  return el;
}

/**
 * Tracks a rolling FPS estimate from raw frame delta-times. Uses a
 * short rolling window (averaged over ~0.5s) rather than the
 * instantaneous 1/dt so the HUD number doesn't flicker wildly frame to
 * frame — a single slow frame (e.g. a GC pause) shouldn't make the
 * counter jump from 60 to 12 and back on consecutive frames.
 */
function createFpsTracker() {
  let acc = 0;
  let frames = 0;
  let lastFps = 0;
  return function tick(dt) {
    acc += dt;
    frames++;
    if (acc >= 0.5) {
      lastFps = Math.round(frames / acc);
      acc = 0;
      frames = 0;
    }
    return lastFps;
  };
}

/**
 * Renders scriptApi.debugState into the HUD element. Called every
 * frame from game.loop's onTick (wired in boot() below) — cheap no-op
 * when debugState.enabled is false, so it costs nothing for games that
 * never call debug.show().
 */
function updateDebugOverlay(el, scriptApi, fps) {
  const state = scriptApi.debugState;
  if (!state || !state.enabled) {
    if (el.style.display !== "none") el.style.display = "none";
    return;
  }
  el.style.display = "block";
  const lines = [];
  if (state.showFps) lines.push("FPS: " + fps);
  for (const [label, value] of state.stats) {
    lines.push(label + ": " + value);
  }
  el.textContent = lines.join("\n") || "(debug on — no stats yet)";
}

async function boot() {
  // Forward this popup's own console.log/warn/error to the editor's
  // Console panel FIRST, before anything else in boot() has a chance
  // to log — so asset load failures, scene validation errors, and
  // script console.log() calls are ALL visible in the editor Console
  // panel, not just crashes. Wrapping console itself (rather than only
  // catching thrown errors) is what makes plain console.log() calls
  // show up too, not just errors.
  _wireConsoleForwarding();

  // Belt-and-suspenders for keyboard focus: PlayWindow.js already calls
  // playWin.focus() right after window.open(), but that can still lose
  // to the OS/browser handing focus back to the opener (observed on
  // ChromeOS) — the popup then renders and runs fine, just silently
  // never receives keydown/keyup, so every input.keyDown()/keyPressed()
  // check in a script stays false forever with no visible error.
  // Re-asserting focus here (on load) and again on the very first click
  // anywhere in the popup guarantees the window has focus by the time
  // the player actually starts pressing movement keys.
  window.focus();
  window.addEventListener("pointerdown", function () { window.focus(); });

  const payload = window.opener && window.opener.__ZENGINE_PLAY_PAYLOAD__;
  if (!payload) {
    document.body.innerHTML =
      '<div style="color:#eee;font:12px monospace;padding:16px;">No scene data received from the editor. Close this window and press Play again.</div>';
    return;
  }

  let { sceneData, width, height, spriteAssets, audioAssets } = payload;

  // Register real textures BEFORE the scene loads, so sprite entities
  // resolve to the actual imported images on their very first frame
  // instead of momentarily (or permanently) showing the missing marker.
  await loadSpriteAssets(spriteAssets);
  loadAudioAssets(audioAssets);

  const mount = document.getElementById("game-canvas");
  mount.style.width = width + "px";
  mount.style.height = height + "px";

  const pixiApp = new PIXI.Application({
    width,
    height,
    backgroundColor: 0x000000,
    antialias: true,
    autoDensity: true,
    resolution: window.devicePixelRatio || 1,
  });
  mount.appendChild(pixiApp.view);

  const game = createGame({ pixiApp, followMainCamera: true });

  // Register ALL scenes so scene.load('Name') can find them by name
  // during play. Without this the popup's SceneManager starts empty and
  // every scene.load() call logs "no scene found" even when the name is
  // spelled correctly. allScenes carries {id,name,data} for every scene
  // the editor has, captured by PlayWindow.js right before opening the
  // popup (with the active scene saved first so its data is current).
  if (payload.allScenes && payload.allScenes.length) {
    game.loadAllScenes(payload.allScenes);
  }

  game.loadFromData(sceneData);

  // Applied once, right here, at the moment Play was pressed — this
  // popup never re-reads editor state after boot, so there is no "live
  // tracking" of further Camera edits while the game is running, which
  // is exactly the requested "update in game mode only when play is
  // pressed" behavior (contrast with SceneViewport.js's syncBackgroundColor(),
  // which DOES re-apply live on every edit, because that's the editor
  // preview, not a running game).
  const mainCameraEntity = game.world.query(TRANSFORM, CAMERA).find((e) => e.getComponent(CAMERA).isMain);
  if (mainCameraEntity) {
    RenderSystem.applyBackgroundColor(pixiApp, mainCameraEntity.getComponent(CAMERA).backgroundColor);
  }

  const validation = game.validate();
  if (!validation.ok) {
    console.error("[play] Scene validation failed:", validation.errors);
  }

  // Wire script errors back to the editor's console via postMessage,
  // so script crashes are visible in the editor without the editor
  // itself ever executing user code. Deliberately does NOT also call
  // console.error() here — that would double-report the same error,
  // since console.error is itself forwarded as a zengine_console_log
  // message by _wireConsoleForwarding() above. The real console.error
  // (bound before wrapping) still gets it for anyone with devtools open.
  if (game.scriptSystem) {
    game.scriptSystem.onError(function (err) {
      if (window.opener && !window.opener.closed) {
        window.opener.postMessage({
          type: "zengine_script_error",
          scriptName: err.scriptName,
          message: err.message,
          line: err.line,
          method: err.method,
          kind: err.kind,
        }, "*");
      }
    });
  }

  // Also forward any OTHER error that happens inside the play popup —
  // an uncaught exception outside a script lifecycle call (e.g. a
  // runtime/engine bug, a bad asset, a rejected Promise) or a raw
  // console.error() call a script's own code triggers indirectly.
  // ScriptSystem.onError above only covers errors THROWN from inside
  // one of the six script lifecycle methods it calls directly; this
  // catches everything else in the same popup window so the editor's
  // console is a true mirror of what actually happened in the browser,
  // not just script-lifecycle crashes.
  _wireGlobalErrorForwarding();

  function _wireGlobalErrorForwarding() {
    function forward(message, line, scriptName, method) {
      if (window.opener && !window.opener.closed) {
        window.opener.postMessage({
          type: "zengine_script_error",
          scriptName: scriptName || "(engine)",
          message: message,
          line: line != null ? String(line) : "?",
          method: method || "runtime",
        }, "*");
      }
    }

    window.addEventListener("error", function (e) {
      // Errors already reported via ScriptSystem.onError (thrown inside
      // a compiled script's own lifecycle call) still bubble up here as
      // a browser-level "error" event too — but ScriptSystem already
      // catches those with try/catch, so they never actually reach
      // window here uncaught. This listener only ever fires for errors
      // OUTSIDE that try/catch (engine code, asset loading, etc).
      forward(e.message, e.lineno, "(engine)", "runtime");
    });

    window.addEventListener("unhandledrejection", function (e) {
      var reason = e.reason;
      var message = reason && reason.message ? reason.message : String(reason);
      forward(message, "?", "(engine)", "promise");
    });
  }

  game.loop.start();
  window.__zengineGame = game;

  // Debug HUD (FPS + any custom debug.log() stats a script has set) —
  // created hidden, shown only once a script calls debug.show(). Polls
  // scriptApi.debugState (see runtime/scripting/ScriptAPI.js) once per
  // rendered frame via GameLoop's onTick, same hook the loop already
  // exposes for host-side per-frame work.
  const debugOverlayEl = createDebugOverlay();
  const fpsTick = createFpsTracker();
  game.loop.onTick = function (dt) {
    const fps = fpsTick(dt);
    updateDebugOverlay(debugOverlayEl, game.scriptApi, fps);
  };

  // When a script calls scene.load() / scene.restart() and the new
  // scene's Main Camera has a different orientation/dimension than the
  // one this window booted with (e.g. Landscape → Portrait), resize the
  // renderer + mount and re-fit so the play window matches the new
  // scene's camera exactly — same getCameraResolution source of truth
  // PlayWindow used to size the boot window.
  game.onSceneCameraChanged(function (w, h, bgColor) {
    width = w;
    height = h;
    pixiApp.renderer.resize(w, h);
    mount.style.width = w + "px";
    mount.style.height = h + "px";
    applyAspectFit(w, h);
  });

  applyAspectFit(width, height);
  window.addEventListener("resize", () => applyAspectFit(width, height));
}

/**
 * Scales (via CSS transform) the fixed-resolution game canvas to fit
 * inside the actual current window size, centered, preserving exact
 * aspect ratio — the game itself always renders at its true resolution,
 * only the on-screen presentation is scaled.
 */
function applyAspectFit(targetW, targetH) {
  const scale = Math.min(window.innerWidth / targetW, window.innerHeight / targetH);
  const mount = document.getElementById("game-canvas");
  mount.style.transform = "scale(" + scale + ")";
  mount.style.transformOrigin = "center center";
}

boot();
