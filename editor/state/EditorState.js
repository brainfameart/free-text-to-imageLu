/**
 * editor/state/EditorState.js
 *
 * Editor-only UI state: which tool is active, what's selected, panel
 * open/closed flags. This is NOT game state — the actual scene data
 * lives in the runtime's World (see runtime/core/World.js), reached
 * through editorState.world.
 */

export const editorState = {
  /** @type {import('../../runtime/core/World.js').World|null} set during editor boot */
  world: null,

  /** @type {ReturnType<import('../../runtime/index.js').createGame>|null} set during editor boot */
  game: null,

  activeTool: "translate",
  selectedId: null,
  animOpen: false,
  isPlaying: false,
  isPaused: false,
  hierarchyFilter: "",
  bottomTab: "project",
  /** @type {"scenes"|"sprites"|"scripts"} which Project > Assets folder is open in the bottom panel */
  projectFolder: "scenes",
  sectionsOpen: { transform: true, camera: true, sprite: true, rigidbody: true, collider: true, movement: true, light: true },
  addComponentMenuOpen: false,
  logs: [{ type: "log", msg: "Editor initialized successfully." }],

  /** @type {string|null} which top menu-bar dropdown is open — currently
   *   only "GameObject" actually opens a real dropdown (Light > 4 types);
   *   the rest of MENUS in Toolbar.js are still inert labels, unchanged. */
  openMenu: null,
  /** @type {string|null} which submenu inside the open menu is expanded
   *   (currently only "Light", inside GameObject) */
  openSubmenu: null,

  /** @type {string|null} id of the scene file currently mid-inline-rename (in the
   *   Project > Scenes folder grid), or null */
  renamingSceneId: null,

  /** @type {string|null} id of the scene file single-click-selected (but not
   *   yet opened) in the Project > Scenes folder grid, or null */
  selectedSceneFileId: null,
};

export function pushLog(type, msg) {
  editorState.logs.push({ type, msg });
}
