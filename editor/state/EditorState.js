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
  /** @type {string[]} ids of ALL selected entities (multi-select).
   *  selectedId is the PRIMARY (last-clicked) — the one the Inspector
   *  and transform gizmo operate on. selectedIds always contains
   *  selectedId. Plain click sets both to a single id; Shift+click
   *  toggles membership (and updates the primary). Delete / Copy /
   *  Duplicate act on every id in here. */
  selectedIds: [],
  animOpen: false,
  isPlaying: false,
  isPaused: false,
  hierarchyFilter: "",
  bottomTab: "project",
  /** @type {"scenes"|"sprites"|"scripts"} which Project > Assets folder is open in the bottom panel */
  projectFolder: "scenes",
  sectionsOpen: { transform: true, camera: true, sprite: true, rigidbody: true, collider: true, movement: true, spriteanimation: true, light: true, shadowcaster: true, lightingsettings: true },
  addComponentMenuOpen: false,

  /** @type {string|null} which top menu-bar dropdown is open ("GameObject", etc), or null */
  openMenu: null,

  /** @type {string|null} which submenu within the open menu is open ("Light"), or null */
  openSubmenu: null,
  logs: [{ type: "log", msg: "Editor initialized successfully." }],

  /** @type {string|null} id of the scene file currently mid-inline-rename (in the
   *   Project > Scenes folder grid), or null */
  renamingSceneId: null,

  /** @type {string|null} id of the scene file single-click-selected (but not
   *   yet opened) in the Project > Scenes folder grid, or null */
  selectedSceneFileId: null,

  /** Animation panel (editor/panels/AnimationWindow.js) UI state — kept
   *  here (not local module state) because the whole editor re-renders
   *  its entire innerHTML from editorState on every change (see
   *  editor/main.js's render()), so anything that must survive a
   *  re-render has to live here, the same reason selectedSceneFileId
   *  and renamingSceneId above do. */
  anim: {
    /** @type {string|null} id of the clip currently being edited/previewed
     *  in the panel — INDEPENDENT of SpriteAnimation.currentClipId,
     *  since the panel should stay open on whatever clip the user is
     *  authoring even if gameplay (or the Inspector) switches the
     *  entity's actual playing clip elsewhere. */
    editingClipId: null,
    /** @type {number} which frame is shown in the panel's own preview,
     *  independent of the live component's currentFrameIndex */
    previewFrameIndex: 0,
    /** whether the panel's own preview is actively auto-advancing */
    previewPlaying: false,
    /** @type {number|null} index of the frame currently being dragged
     *  for reorder, or null */
    draggingFrameIndex: null,
    /** @type {string|null} id of a clip whose name is being inline-edited */
    renamingClipId: null,
    /** @type {{cols:number, rows:number}|null} pending manual grid
     *  override for the NEXT sprite-sheet import — set via the panel's
     *  "Slice Sheet" dialog before the file picker's change event fires */
    pendingSheetGrid: null,
    /** whether the Animation panel's preview overlays the current
     *  collider (clip override, or else the entity's base Collider2D)
     *  as a sized outline on top of the frame thumbnail */
    showColliderInPreview: false,
  },
};

export function pushLog(type, msg) {
  editorState.logs.push({ type, msg });
}
