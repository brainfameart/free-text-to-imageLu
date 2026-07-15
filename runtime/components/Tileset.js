/**
 * runtime/components/Tileset.js
 *
 * Plain data describing an authored autotile tileset: a small named set
 * of "roles" (the 9 classic autotile positions — 4 corners, 4 edges, 1
 * center) each mapped to a spriteKey, plus tile size in pixels.
 *
 * Authoring model (the editor's TilesetPanel.js): the user either
 * imports ONE image and it's auto-sliced into a 3x3 grid, or imports up
 * to 9 separate images and drags each into a role slot — and can drag
 * between slots afterward to reassign. Either way, the END RESULT stored
 * here is identical: nine independent spriteKeys keyed by role name.
 * Runtime code (TilemapSystem.js) never knows or cares which authoring
 * path produced them.
 *
 * Painting-time tile selection is NOT decided here — that's
 * TilemapSystem.js's job, using AutoTileRules.js to turn "which of my 8
 * neighbors are filled" into one of these 9 roles (Unity Rule Tile
 * style: matched by neighbor bitmask, not drawn by hand per-cell). This
 * keeps the same separation of concerns as SpriteRenderer (data) vs
 * RenderSystem (behavior) — see RULES.txt #4.
 *
 * RUNTIME-ONLY FILE.
 */

export const TILESET = "Tileset";

/**
 * The 9 canonical autotile roles, matching the editor's 3x3 authoring
 * grid layout (row-major, top-left to bottom-right):
 *
 *   CORNER_TL  EDGE_T  CORNER_TR
 *   EDGE_L     CENTER  EDGE_R
 *   CORNER_BL  EDGE_B  CORNER_BR
 *
 * CENTER is used whenever all 4 orthogonal neighbors are filled (a tile
 * fully surrounded). Each EDGE_* role is used when that one side is
 * "open" (no matching neighbor) with the other three sides filled.
 * Each CORNER_* role is used for an outward-facing corner (two adjacent
 * open sides). This 9-role set intentionally does NOT disambiguate
 * every one of the 256 possible 8-neighbor bitmasks the way a full
 * Unity Rule Tile / Wang tile set can — see AutoTileRules.js's doc
 * comment for exactly how each of the 256 masks collapses onto these 9.
 */
export const TileRole = Object.freeze({
  CORNER_TL: "cornerTL",
  EDGE_T: "edgeT",
  CORNER_TR: "cornerTR",
  EDGE_L: "edgeL",
  CENTER: "center",
  EDGE_R: "edgeR",
  CORNER_BL: "cornerBL",
  EDGE_B: "edgeB",
  CORNER_BR: "cornerBR",
});

/** Row-major role order — the exact order the 3x3 authoring grid and a
 *  single-image auto-slice both use, so slot index <-> role name is
 *  always this one fixed mapping everywhere in the codebase. */
export const TILE_ROLE_ORDER = [
  TileRole.CORNER_TL, TileRole.EDGE_T, TileRole.CORNER_TR,
  TileRole.EDGE_L, TileRole.CENTER, TileRole.EDGE_R,
  TileRole.CORNER_BL, TileRole.EDGE_B, TileRole.CORNER_BR,
];

export class Tileset {
  constructor({
    name = "New Tileset",
    tileWidth = 32,
    tileHeight = 32,
    /** @type {Record<string, string|null>} role name -> spriteKey (or
     *  null if that slot hasn't been filled in yet). Always has all 9
     *  TILE_ROLE_ORDER keys present (missing ones default to null) so
     *  every consumer can do `slots[role]` without an existence check. */
    slots = {},
  } = {}) {
    this.name = name;
    this.tileWidth = tileWidth;
    this.tileHeight = tileHeight;

    this.slots = {};
    for (const role of TILE_ROLE_ORDER) {
      this.slots[role] = slots[role] !== undefined ? slots[role] : null;
    }
  }
}
