/**
 * editor/state/ConsoleCapture.js
 *
 * Pipes REAL browser-level errors into the editor's own Console panel
 * (editorState.logs / pushLog), not just the handful of manual pushLog()
 * calls scattered through editor code. This is what lets you open the
 * in-engine Console tab and see PixiJS texture/WebGL errors, uncaught
 * exceptions, unhandled promise rejections, and any console.warn/error
 * call from ANY module (including PixiJS itself) — without needing the
 * browser's own devtools console open.
 *
 * Call installConsoleCapture() exactly once, as early as possible in
 * editor/main.js, before createViewport()/PIXI boot.
 */

import { pushLog } from "./EditorState.js";

let installed = false;

function stringifyArg(arg) {
  if (arg instanceof Error) {
    return arg.message + (arg.stack ? "\n" + arg.stack : "");
  }
  if (typeof arg === "object" && arg !== null) {
    try {
      return JSON.stringify(arg);
    } catch (err) {
      return String(arg);
    }
  }
  return String(arg);
}

export function installConsoleCapture() {
  if (installed) return;
  installed = true;

  // 1. Uncaught synchronous errors (includes PixiJS internal throws,
  //    e.g. bad texture data, WebGL context creation failures).
  window.addEventListener("error", (event) => {
    const msg = event.error ? stringifyArg(event.error) : event.message;
    pushLog("error", "[Uncaught] " + msg + (event.filename ? " (" + event.filename + ":" + event.lineno + ")" : ""));
  });

  // 2. Unhandled promise rejections (e.g. a failed PIXI.Assets.load(),
  //    or a rejected texture-loading promise from AssetManager that
  //    nobody .catch()'d).
  window.addEventListener("unhandledrejection", (event) => {
    const reason = event.reason ? stringifyArg(event.reason) : "Unhandled promise rejection";
    pushLog("error", "[Unhandled Promise] " + reason);
  });

  // 3. Mirror console.warn / console.error / console.log into the panel
  //    too, so PixiJS's own internal console.warn() calls (deprecated
  //    API usage, missing textures, etc.) show up here as well. Keep
  //    calling the real console methods so browser devtools still work
  //    normally alongside this.
  const realWarn = console.warn.bind(console);
  const realError = console.error.bind(console);

  console.warn = (...args) => {
    realWarn(...args);
    pushLog("warn", "[console.warn] " + args.map(stringifyArg).join(" "));
  };

  console.error = (...args) => {
    realError(...args);
    pushLog("error", "[console.error] " + args.map(stringifyArg).join(" "));
  };

  pushLog("log", "Console capture installed: window errors, unhandled rejections, console.warn/error now mirrored here.");
}

/**
 * Wraps a PIXI.Application's renderer/loader-level events, if present in
 * the running PIXI version, so texture load failures surface as engine
 * console entries with the offending resource named explicitly.
 * Safe no-op if the PIXI build doesn't expose these hooks.
 *
 * @param {PIXI.Application} pixiApp
 */
export function attachPixiDiagnostics(pixiApp) {
  if (!pixiApp || !pixiApp.renderer) return;

  try {
    pixiApp.renderer.on("error", (err) => {
      pushLog("error", "[PIXI renderer] " + stringifyArg(err));
    });
  } catch (err) {
    // renderer.on may not exist on every PIXI renderer type; ignore.
  }

  try {
    const gl = pixiApp.renderer.gl;
    if (gl && pixiApp.view) {
      pixiApp.view.addEventListener("webglcontextlost", (e) => {
        e.preventDefault();
        pushLog("error", "[PIXI] WebGL context lost. Rendering has stopped until the context is restored.");
      });
      pixiApp.view.addEventListener("webglcontextrestored", () => {
        pushLog("log", "[PIXI] WebGL context restored.");
      });
    }
  } catch (err) {
    // ignore — not all renderer types expose .gl (e.g. canvas fallback)
  }
}
