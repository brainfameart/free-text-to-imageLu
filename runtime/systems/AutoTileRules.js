/**
 * runtime/systems/AutoTileRules.js
 *
 * Pure function: given which of a cell's 4 orthogonal neighbors are
 * also filled tiles, decide which of the 9 Tileset roles (see
 * components/Tileset.js) that cell should display. This is the same
 * fundamental idea as Unity's 2D Tilemap Extras "Rule Tile" — the tile
 * that appears is DERIVED from the pattern of surrounding tiles as you
 * paint, not chosen by hand per-cell — just collapsed down to the
 * classic 9-slice role set instead of a fully custom rule list, to
 * match this engine's simpler 3x3 authoring UI.
 *
 * Kept as its own file (not inlined into TilemapSystem.js) because it's
 * pure data-in/data-out logic with zero PIXI/World dependency — trivial
 * to unit-test in isolation, and reusable later by an editor-side
 * "preview how this tileset looks" feature without dragging in the
 * whole rendering system.
 *
 * RUNTIME-ONLY FILE (no dependencies at all, in fact — plain JS).
 */

import { TileRole } from "../components/Tileset.js";

// Bit flags for the 4 orthogonal neighbor directions. Only orthogonal
// neighbors are considered (not diagonals) — enough to distinguish all
// 9 classic roles unambiguously, and it's what keeps authoring down to
// a 3x3 grid instead of needing 47-tile Wang-style sets.
export const N = 1 << 0;
export const E = 1 << 1;
export const S = 1 << 2;
export const W = 1 << 3;

/**
 * @param {number} mask bitwise-OR of N/E/S/W for which orthogonal
 *   neighbors are also filled tiles (same tilemap layer)
 * @returns {string} one of the TileRole values
 */
export function resolveRoleForNeighborMask(mask) {
  const n = !!(mask & N);
  const e = !!(mask & E);
  const s = !!(mask & S);
  const w = !!(mask & W);

  // Fully surrounded -> plain center tile.
  if (n && e && s && w) return TileRole.CENTER;

  // Exactly one open side -> the edge tile facing that open side (the
  // three other sides being filled is what makes this an "edge", not
  // a corner or a stub).
  if (!n && e && s && w) return TileRole.EDGE_T;
  if (n && !e && s && w) return TileRole.EDGE_R;
  if (n && e && !s && w) return TileRole.EDGE_B;
  if (n && e && s && !w) return TileRole.EDGE_L;

  // Exactly two ADJACENT open sides -> outward corner tile for that
  // corner (e.g. open on top+left => this cell is the top-left corner
  // of a filled blob).
  if (!n && !w && e && s) return TileRole.CORNER_TL;
  if (!n && !e && s && w) return TileRole.CORNER_TR;
  if (!s && !w && n && e) return TileRole.CORNER_BL;
  if (!s && !e && n && w) return TileRole.CORNER_BR;

  // Everything else (isolated single tile, a straight 1-wide strip, an
  // L with two opposite open sides, three-or-more open sides, etc) has
  // no single unambiguous 9-slice role — fall back to CENTER, same
  // convention as an unmatched Unity Rule Tile falling back to its
  // default sprite. Good enough for solid blob-shaped terrain, which is
  // the common case this 9-role set targets; free-standing single
  // tiles or thin strips will just show the plain center tile rather
  // than a dedicated cap/stub graphic.
  return TileRole.CENTER;
}

/**
 * Computes the orthogonal-neighbor bitmask for a given cell against a
 * Set of "cellKey" strings (see Tilemap.js's cellKey()) representing
 * every filled cell on the SAME layer. Kept generic over "what counts
 * as filled" via the Set so TilemapSystem can build that set once per
 * update rather than this function needing to know about Tilemap's
 * internal storage shape at all.
 * @param {number} col
 * @param {number} row
 * @param {Set<string>} filledCellKeys
 * @param {(col:number,row:number)=>string} cellKey
 * @returns {number} bitmask of N|E|S|W
 */
export function computeNeighborMask(col, row, filledCellKeys, cellKey) {
  let mask = 0;
  if (filledCellKeys.has(cellKey(col, row - 1))) mask |= N;
  if (filledCellKeys.has(cellKey(col + 1, row))) mask |= E;
  if (filledCellKeys.has(cellKey(col, row + 1))) mask |= S;
  if (filledCellKeys.has(cellKey(col - 1, row))) mask |= W;
  return mask;
}
