/**
 * editor/panels/StatusBar.js
 *
 * Bottom-most status strip. The initial HTML is rendered as part of the
 * editor's full DOM rebuild (render() in main.js), but the live values
 * (FPS, memory, object count) are updated independently via a lightweight
 * interval in startLiveStats() — querying getElementById and writing
 * textContent — so the numbers tick without rebuilding the entire editor
 * DOM 60 times a second.
 */

import { icon } from "../icons/IconLibrary.js";

export function renderStatusBar() {
  return (
    '<div class="statusbar">' +
    '<div class="left">' +
    icon("info", 12) +
    '<span id="sb-autosave">Auto-save completed.</span></div>' +
    '<div class="right">' +
    '<span>Objects: <b id="sb-objects">0</b></span>' +
    '<span>FPS: <b id="sb-fps">—</b></span>' +
    '<span>Memory: <b id="sb-memory">—</b></span>' +
    '<span class="mono">version: 1.1</span>' +
    "</div>" +
    "</div>"
  );
}

/**
 * Starts a lightweight live-update loop for the status bar's FPS,
 * memory, and object-count readouts. Call once at editor boot.
 *
 * FPS is measured with a requestAnimationFrame frame counter sampled
 * every 500 ms (accurate enough for a status readout, and far cheaper
 * than per-frame DOM writes). Memory uses performance.memory (Chromium)
 * when available; other browsers show "N/A" rather than a fake number.
 * Object count is read from the live World.
 *
 * @param {object} editorState
 */
export function startLiveStats(editorState) {
  let frames = 0;
  let lastSample = performance.now();
  let rafHandle = null;

  // FPS frame counter — counts every RAF tick, then converts to a rate
  // when the 500 ms sample interval fires.
  function countFrame() {
    frames++;
    rafHandle = requestAnimationFrame(countFrame);
  }
  rafHandle = requestAnimationFrame(countFrame);

  const interval = setInterval(() => {
    const now = performance.now();
    const elapsed = now - lastSample;
    const fps = elapsed > 0 ? Math.round((frames * 1000) / elapsed) : 0;
    lastSample = now;
    frames = 0;

    setText("sb-fps", String(fps));

    // Object count from the live world (entities map size — O(1)).
    const count = editorState.world ? editorState.world.entities.size : 0;
    setText("sb-objects", String(count));

    // Memory: performance.memory is Chromium-only and non-standard, but
    // the editor runs in a Chromium-based webview/iframe in practice.
    // measureUserAgentSpecificMemory requires cross-origin isolation
    // headers the editor iframe doesn't have, so we fall back to the
    // legacy API and gracefully show "N/A" where neither exists.
    const mem = performance.memory;
    if (mem && typeof mem.usedJSHeapSize === "number") {
      setText("sb-memory", formatMB(mem.usedJSHeapSize));
    } else {
      setText("sb-memory", "N/A");
    }
  }, 500);

  // Return a cleanup handle (unused in practice — the editor lives for
  // the page lifetime — but keeps the function self-contained).
  return function stop() {
    clearInterval(interval);
    if (rafHandle !== null) cancelAnimationFrame(rafHandle);
  };
}

/** Writes textContent into the element if it exists in the DOM right now. */
function setText(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}

function formatMB(bytes) {
  const mb = bytes / (1024 * 1024);
  return mb >= 100 ? Math.round(mb) + " MB" : mb.toFixed(1) + " MB";
}
