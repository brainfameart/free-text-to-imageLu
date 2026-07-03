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
  sectionsOpen: { transform: true, camera: true, sprite: true, rigidbody: true, collider: true },
  addComponentMenuOpen: false,
  logs: [{ type: "log", msg: "Editor initialized successfully." }],

  /** @type {string|null} id of the scene tab currently mid-inline-rename, or null */
  renamingSceneId: null,
};

export function pushLog(type, msg) {
  editorState.logs.push({ type, msg });
}
