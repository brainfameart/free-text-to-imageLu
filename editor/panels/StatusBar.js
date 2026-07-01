/**
 * editor/panels/StatusBar.js
 *
 * Bottom-most status strip (autosave message, memory, engine name tag).
 */

import { icon } from "../icons/IconLibrary.js";

export function renderStatusBar() {
  return (
    '<div class="statusbar">' +
    '<div class="left">' +
    icon("info", 12) +
    "<span>Auto-save completed.</span></div>" +
    '<div class="right"><span>Memory: 142 MB</span><span class="mono">ZenEngine Editor</span></div>' +
    "</div>"
  );
}
