/**
 * Deterministic camp → Area materialization for the OTel provider.
 *
 * Each camp gets ONE contiguous rectangular room:
 *
 *   - a 1-tile wall ring (TileType WALL) encloses the region, with a single
 *     door gap (1–2 floor tiles) in the top wall, facing the rest of the office;
 *   - inside, one workstation (desk + chair) per bindle, laid out in a
 *     deterministic 2-column cell grid;
 *   - interior floor tiles are painted with the camp's Area label (walls and
 *     the door gap stay unlabeled, mirroring the webview editor's paintArea,
 *     which only labels floor tiles).
 *
 * Allocation is first-fit over free floor (scanning room-sized rectangles
 * plus a 1-tile floor margin on every side, so two rooms always keep ≥1 tile
 * of separation); when nothing fits, the grid grows downward (and rightward
 * when the room is wider than the grid), bounded by MAX_COLS/MAX_ROWS like
 * the editor's expandLayout.
 *
 * Pure functions over the persisted layout JSON — no DOM, no sprites. The
 * webview rebuilds seats from chair furniture on the next `layoutLoaded`.
 */

import type { FurnitureAsset } from '../../assetLoader.js';
import {
  GRID_GROW_ROWS,
  GROWN_TILE_COLOR,
  MAX_COLS,
  MAX_ROWS,
  TILE_FLOOR_1,
  TILE_VOID,
  TILE_WALL,
  WORKSTATION_CELL_H,
  WORKSTATION_CELL_W,
} from './constants.js';

// ── Minimal layout shape (mirrors webview-ui OfficeLayout) ───

export interface AreaDefinition {
  label: string;
  color: string;
}

export interface PlacedFurnitureLike {
  uid: string;
  type: string;
  col: number;
  row: number;
  [k: string]: unknown;
}

export interface OfficeLayoutLike {
  version: number;
  cols: number;
  rows: number;
  tiles: number[];
  furniture: PlacedFurnitureLike[];
  tileColors?: Array<unknown>;
  areas?: AreaDefinition[];
  areaTiles?: Array<string | null>;
  [k: string]: unknown;
}

// ── Deterministic color ──────────────────────────────────────

/** FNV-1a 32-bit hash. */
function fnv1a(str: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function hslToHex(h: number, s: number, l: number): string {
  const a = s * Math.min(l, 1 - l);
  const f = (n: number): string => {
    const k = (n + h / 30) % 12;
    const c = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(c * 255)
      .toString(16)
      .padStart(2, '0');
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

/** Deterministic Area color from the camp name (hash → hue, fixed sat/light). */
export function areaColorForName(name: string): string {
  const hue = fnv1a(name) % 360;
  return hslToHex(hue, 0.65, 0.55);
}

/** Filesystem/uid-safe slug for a camp or bindle name. */
export function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'otel';
}

// ── Room geometry ────────────────────────────────────────────

/** Workstation cells per row inside a room. 3 keeps a 1–3 seat room one cell
 *  row tall (9 rows with walls), so three camps fit under MAX_ROWS=64 with the
 *  default 22-row office, and growing from 1→3 seats never needs relocation. */
const CELLS_PER_ROW = 3;
/** Gap between cells and between cells and the interior walls. */
const CELL_GAP = 1;

export interface RoomSize {
  /** Room width/height including the wall ring. */
  roomW: number;
  roomH: number;
  /** Interior (labelable) width/height. */
  interiorW: number;
  interiorH: number;
  cellRows: number;
  /** Seat capacity of a room this size. */
  capacity: number;
}

/** Room size for a given seat count (cells laid out CELLS_PER_ROW per row). */
export function roomSizeForSeats(seats: number): RoomSize {
  const cellRows = Math.max(1, Math.ceil(Math.max(1, seats) / CELLS_PER_ROW));
  const interiorW = CELLS_PER_ROW * WORKSTATION_CELL_W + (CELLS_PER_ROW - 1) * CELL_GAP + 2 * CELL_GAP;
  const interiorH = cellRows * WORKSTATION_CELL_H + (cellRows - 1) * CELL_GAP + 2 * CELL_GAP;
  return {
    roomW: interiorW + 2,
    roomH: interiorH + 2,
    interiorW,
    interiorH,
    cellRows,
    capacity: cellRows * CELLS_PER_ROW,
  };
}

// ── Tile helpers ─────────────────────────────────────────────

function tileAt(layout: OfficeLayoutLike, col: number, row: number): number {
  return layout.tiles[row * layout.cols + col];
}

function isFloorTile(layout: OfficeLayoutLike, col: number, row: number): boolean {
  if (col < 0 || col >= layout.cols || row < 0 || row >= layout.rows) return false;
  const t = tileAt(layout, col, row);
  return t !== TILE_WALL && t !== TILE_VOID;
}

function setTile(layout: OfficeLayoutLike, col: number, row: number, value: number): void {
  const idx = row * layout.cols + col;
  layout.tiles[idx] = value;
  if (layout.tileColors) {
    layout.tileColors[idx] = value === TILE_WALL ? null : { ...GROWN_TILE_COLOR };
  }
}

function setLabel(layout: OfficeLayoutLike, col: number, row: number, label: string | null): void {
  if (!layout.areaTiles) {
    layout.areaTiles = new Array<string | null>(layout.tiles.length).fill(null);
  }
  layout.areaTiles[row * layout.cols + col] = label;
}

interface Footprint {
  col: number;
  row: number;
  w: number;
  h: number;
}

function buildFootprints(
  layout: OfficeLayoutLike,
  catalog: ReadonlyMap<string, { w: number; h: number }>,
): Footprint[] {
  return layout.furniture.map((f) => {
    const entry = catalog.get(f.type);
    return { col: f.col, row: f.row, w: entry?.w ?? 1, h: entry?.h ?? 1 };
  });
}

/** True when the rect is entirely floor tiles, unlabeled, and furniture-free. */
export function isRegionFree(
  layout: OfficeLayoutLike,
  col: number,
  row: number,
  w: number,
  h: number,
  footprints: Footprint[],
): boolean {
  if (col < 0 || row < 0 || col + w > layout.cols || row + h > layout.rows) return false;
  const areaTiles = layout.areaTiles;
  for (let r = row; r < row + h; r++) {
    for (let c = col; c < col + w; c++) {
      if (!isFloorTile(layout, c, r)) return false;
      const label = areaTiles ? areaTiles[r * layout.cols + c] : null;
      if (label !== null && label !== undefined) return false;
      for (const f of footprints) {
        if (c >= f.col && c < f.col + f.w && r >= f.row && r < f.row + f.h) return false;
      }
    }
  }
  return true;
}

/** First-fit scan (top-left, row-major) for a free w×h region. Deterministic. */
export function findFreeRegion(
  layout: OfficeLayoutLike,
  w: number,
  h: number,
  footprints: Footprint[],
): { col: number; row: number } | null {
  for (let row = 0; row + h <= layout.rows; row++) {
    for (let col = 0; col + w <= layout.cols; col++) {
      if (isRegionFree(layout, col, row, w, h, footprints)) {
        return { col, row };
      }
    }
  }
  return null;
}

// ── Grid growth ──────────────────────────────────────────────

/** Append rows of floor tiles at the bottom. Returns null past MAX_ROWS. */
function growDown(layout: OfficeLayoutLike, addRows: number): OfficeLayoutLike | null {
  const newRows = layout.rows + addRows;
  if (newRows > MAX_ROWS) return null;
  const tiles = [...layout.tiles];
  const tileColors = layout.tileColors ? [...layout.tileColors] : undefined;
  const areaTiles = layout.areaTiles ? [...layout.areaTiles] : undefined;
  for (let r = layout.rows; r < newRows; r++) {
    for (let c = 0; c < layout.cols; c++) {
      tiles.push(TILE_FLOOR_1);
      tileColors?.push({ ...GROWN_TILE_COLOR });
      areaTiles?.push(null);
    }
  }
  return {
    ...layout,
    rows: newRows,
    tiles,
    ...(tileColors ? { tileColors } : {}),
    ...(areaTiles ? { areaTiles } : {}),
  };
}

/** Append columns of floor tiles on the right. Returns null past MAX_COLS. */
function growRight(layout: OfficeLayoutLike, addCols: number): OfficeLayoutLike | null {
  const newCols = layout.cols + addCols;
  if (newCols > MAX_COLS) return null;
  const tiles: number[] = new Array(newCols * layout.rows);
  const tileColors: unknown[] = new Array(newCols * layout.rows);
  const areaTiles: Array<string | null> = new Array(newCols * layout.rows);
  for (let r = 0; r < layout.rows; r++) {
    for (let c = 0; c < newCols; c++) {
      const newIdx = r * newCols + c;
      if (c < layout.cols) {
        const oldIdx = r * layout.cols + c;
        tiles[newIdx] = layout.tiles[oldIdx];
        tileColors[newIdx] = layout.tileColors ? layout.tileColors[oldIdx] : null;
        areaTiles[newIdx] = layout.areaTiles ? layout.areaTiles[oldIdx] : null;
      } else {
        tiles[newIdx] = TILE_FLOOR_1;
        tileColors[newIdx] = { ...GROWN_TILE_COLOR };
        areaTiles[newIdx] = null;
      }
    }
  }
  return {
    ...layout,
    cols: newCols,
    tiles,
    ...(layout.tileColors ? { tileColors } : {}),
    ...(layout.areaTiles ? { areaTiles } : {}),
  };
}

// ── Existing-room analysis (validity + migration) ────────────

export type CampRoomStatus =
  | { kind: 'absent' }
  | { kind: 'valid'; seats: number }
  | { kind: 'fragmented'; components: number; seats: number }
  | { kind: 'unenclosed'; leaks: number; seats: number };

/** Count seats contributed by OTel-placed chairs for one camp slug. */
function countCampSeats(layout: OfficeLayoutLike, campSlug: string): number {
  const prefix = `otel-${campSlug}-ws`;
  let seats = 0;
  for (const f of layout.furniture) {
    if (f.uid.startsWith(prefix) && f.uid.endsWith('-chair')) seats += 1;
  }
  return seats;
}

/** True when the camp has OTel-placed furniture (our auto-materialization marker). */
export function hasOtelFurniture(layout: OfficeLayoutLike, campLabel: string): boolean {
  const prefix = `otel-${slugify(campLabel)}-ws`;
  return layout.furniture.some((f) => f.uid.startsWith(prefix));
}

/**
 * Inspect the tiles labeled `campLabel`:
 *   - absent     — no labeled tiles;
 *   - fragmented — labels form more than one 4-connected component;
 *   - unenclosed — one component, but labeled floor touches more than a
 *                  door-width (2) of unlabeled floor (no wall ring);
 *   - valid      — one component with ≤2 "leak" adjacencies (the door).
 */
export function analyzeCampRoom(layout: OfficeLayoutLike, campLabel: string): CampRoomStatus {
  const seats = countCampSeats(layout, slugify(campLabel));
  const areaTiles = layout.areaTiles;
  const labeled: number[] = [];
  if (areaTiles) {
    for (let i = 0; i < areaTiles.length; i++) {
      if (areaTiles[i] === campLabel) labeled.push(i);
    }
  }
  if (labeled.length === 0) return { kind: 'absent' };

  // Connected components over labeled tiles (4-neighbourhood).
  const labeledSet = new Set(labeled);
  let components = 0;
  const seen = new Set<number>();
  for (const start of labeled) {
    if (seen.has(start)) continue;
    components += 1;
    const stack = [start];
    seen.add(start);
    while (stack.length > 0) {
      const idx = stack.pop()!;
      const col = idx % layout.cols;
      const row = Math.floor(idx / layout.cols);
      for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const nc = col + dc;
        const nr = row + dr;
        if (nc < 0 || nc >= layout.cols || nr < 0 || nr >= layout.rows) continue;
        const nIdx = nr * layout.cols + nc;
        if (labeledSet.has(nIdx) && !seen.has(nIdx)) {
          seen.add(nIdx);
          stack.push(nIdx);
        }
      }
    }
  }
  if (components > 1) return { kind: 'fragmented', components, seats };

  // Enclosure: count labeled tiles touching unlabeled floor (leaks).
  let leaks = 0;
  for (const idx of labeled) {
    const col = idx % layout.cols;
    const row = Math.floor(idx / layout.cols);
    for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const nc = col + dc;
      const nr = row + dr;
      if (nc < 0 || nc >= layout.cols || nr < 0 || nr >= layout.rows) continue;
      const nIdx = nr * layout.cols + nc;
      if (labeledSet.has(nIdx)) continue;
      if (isFloorTile(layout, nc, nr) && (areaTiles?.[nIdx] ?? null) === null) {
        leaks += 1;
        break; // one leak per labeled tile is enough
      }
    }
  }
  if (leaks > 2) return { kind: 'unenclosed', leaks, seats };
  return { kind: 'valid', seats };
}

/**
 * Remove every trace of a camp room: labels cleared, OTel furniture removed.
 * With `unwall`, the wall ring around the label bounding box is also reverted
 * to floor — used when relocating an intact room, where the ring geometry is
 * exactly ours. Fragmented/unenclosed remnants keep their walls (we can't
 * tell them apart from user walls).
 */
function wipeCamp(layout: OfficeLayoutLike, campLabel: string, unwall: boolean): void {
  if (unwall) {
    const bbox = labelBbox(layout, campLabel);
    if (bbox) {
      for (let r = bbox.minR - 1; r <= bbox.maxR + 1; r++) {
        for (let c = bbox.minC - 1; c <= bbox.maxC + 1; c++) {
          const onRing =
            r === bbox.minR - 1 || r === bbox.maxR + 1 || c === bbox.minC - 1 || c === bbox.maxC + 1;
          if (!onRing || r < 0 || c < 0 || r >= layout.rows || c >= layout.cols) continue;
          if (tileAt(layout, c, r) === TILE_WALL) setTile(layout, c, r, TILE_FLOOR_1);
        }
      }
    }
  }
  const prefix = `otel-${slugify(campLabel)}-ws`;
  layout.furniture = layout.furniture.filter((f) => !f.uid.startsWith(prefix));
  if (layout.areaTiles) {
    for (let i = 0; i < layout.areaTiles.length; i++) {
      if (layout.areaTiles[i] === campLabel) layout.areaTiles[i] = null;
    }
  }
}

// ── Room construction ────────────────────────────────────────

interface FurniturePick {
  desk: FurnitureAsset | null;
  chair: FurnitureAsset | null;
}

function pickFurniture(catalog: readonly FurnitureAsset[]): FurniturePick {
  return {
    desk: catalog.find((a) => a.isDesk && a.orientation === 'front') ?? null,
    chair:
      catalog.find((a) => a.category === 'chairs' && a.orientation === 'back') ??
      catalog.find((a) => a.category === 'chairs') ??
      null,
  };
}

/** Place workstation cells inside a room interior. Returns seats placed. */
function placeWorkstations(
  layout: OfficeLayoutLike,
  campSlug: string,
  interiorCol: number,
  interiorRow: number,
  startIndex: number,
  count: number,
  pick: FurniturePick,
): void {
  for (let i = 0; i < count; i++) {
    const n = startIndex + i;
    const cellCol = interiorCol + CELL_GAP + (n % CELLS_PER_ROW) * (WORKSTATION_CELL_W + CELL_GAP);
    const cellRow =
      interiorRow + CELL_GAP + Math.floor(n / CELLS_PER_ROW) * (WORKSTATION_CELL_H + CELL_GAP);
    if (pick.desk) {
      layout.furniture.push({
        uid: `otel-${campSlug}-ws${n}-desk`,
        type: pick.desk.id,
        col: cellCol,
        row: cellRow,
      });
    }
    if (pick.chair) {
      layout.furniture.push({
        uid: `otel-${campSlug}-ws${n}-chair`,
        type: pick.chair.id,
        col: cellCol + 1,
        row: cellRow + 2,
      });
    }
  }
}

/** Paint the room interior with the camp label (walls + door stay unlabeled). */
function paintInterior(
  layout: OfficeLayoutLike,
  col: number,
  row: number,
  size: RoomSize,
  label: string,
): void {
  for (let r = row + 1; r < row + 1 + size.interiorH; r++) {
    for (let c = col + 1; c < col + 1 + size.interiorW; c++) {
      if (isFloorTile(layout, c, r)) setLabel(layout, c, r, label);
    }
  }
}

/** Build the wall ring with a 2-tile (or 1-tile on narrow rooms) top door. */
function buildWallRing(
  layout: OfficeLayoutLike,
  col: number,
  row: number,
  size: RoomSize,
): { doorCols: number[] } {
  const right = col + size.roomW - 1;
  const bottom = row + size.roomH - 1;
  const doorStart = col + 1 + Math.floor((size.interiorW - 2) / 2);
  const doorCols = size.interiorW >= 4 ? [doorStart, doorStart + 1] : [col + 1];
  for (let c = col; c <= right; c++) {
    setTile(layout, c, row, TILE_WALL);
    setTile(layout, c, bottom, TILE_WALL);
  }
  for (let r = row; r <= bottom; r++) {
    setTile(layout, col, r, TILE_WALL);
    setTile(layout, right, r, TILE_WALL);
  }
  for (const dc of doorCols) {
    setTile(layout, dc, row, TILE_FLOOR_1);
  }
  return { doorCols };
}

/**
 * After growth placement, open a corridor from the door upward into the rest
 * of the office: walk straight up from the door, crossing floor gaps freely
 * and punching any wall tiles to floor, stopping once floor is reached beyond
 * the first wall. Never punches a wall that has labeled floor above it (that
 * would be another room's wall).
 */
function punchCorridorUp(layout: OfficeLayoutLike, doorCols: number[], doorRow: number): void {
  for (const dc of doorCols) {
    let seenWall = false;
    for (let r = doorRow - 1; r >= 0; r--) {
      const t = tileAt(layout, dc, r);
      if (t === TILE_WALL) {
        const above = r > 0 ? (layout.areaTiles?.[(r - 1) * layout.cols + dc] ?? null) : null;
        if (above !== null) break; // another room's wall — don't breach it
        seenWall = true;
        setTile(layout, dc, r, TILE_FLOOR_1);
      } else if (seenWall) {
        break; // reached open floor beyond the wall(s)
      }
    }
  }
}

/**
 * Allocate a fresh room for the camp: first-fit free rectangle (room + 1-tile
 * floor margin on every side), growing the grid when nothing fits.
 * Returns true when the room was placed.
 */
function allocateRoom(
  layout: OfficeLayoutLike,
  campLabel: string,
  campSlug: string,
  seats: number,
  pick: FurniturePick,
  footprints: ReadonlyMap<string, { w: number; h: number }>,
): boolean {
  const size = roomSizeForSeats(seats);
  const searchW = size.roomW + 2; // 1-tile floor margin on each side
  const searchH = size.roomH + 2;

  let origin = findFreeRegion(layout, searchW, searchH, buildFootprints(layout, footprints));
  let grew = false;
  if (!origin) {
    // Grow downward (new band below the office), widening when the room is
    // wider than the grid. Mirrors the editor's expandLayout bounds.
    const neededCols = searchW + 2;
    if (layout.cols < neededCols) {
      const grown = growRight(layout, neededCols - layout.cols);
      if (grown) layout = copyInto(layout, grown);
    }
    const grown = growDown(layout, Math.max(GRID_GROW_ROWS, searchH));
    if (grown) layout = copyInto(layout, grown);
    origin = findFreeRegion(layout, searchW, searchH, buildFootprints(layout, footprints));
    grew = true;
  }
  if (!origin) return false;

  const roomCol = origin.col + 1;
  const roomRow = origin.row + 1;
  const { doorCols } = buildWallRing(layout, roomCol, roomRow, size);
  paintInterior(layout, roomCol, roomRow, size, campLabel);
  placeWorkstations(
    layout,
    campSlug,
    roomCol + 1,
    roomRow + 1,
    0,
    Math.min(seats, size.capacity),
    pick,
  );
  if (grew) {
    punchCorridorUp(layout, doorCols, roomRow);
  }
  return true;
}

/** Copy mutated fields from one layout object into another (in-place growth). */
function copyInto(target: OfficeLayoutLike, source: OfficeLayoutLike): OfficeLayoutLike {
  target.cols = source.cols;
  target.rows = source.rows;
  target.tiles = source.tiles;
  if (source.tileColors) target.tileColors = source.tileColors;
  if (source.areaTiles) target.areaTiles = source.areaTiles;
  return target;
}

/** Bounding box of the camp's labeled (interior) tiles, or null when none. */
function labelBbox(
  layout: OfficeLayoutLike,
  campLabel: string,
): { minC: number; maxC: number; minR: number; maxR: number } | null {
  const areaTiles = layout.areaTiles ?? [];
  let minC = Infinity;
  let maxC = -Infinity;
  let minR = Infinity;
  let maxR = -Infinity;
  for (let i = 0; i < areaTiles.length; i++) {
    if (areaTiles[i] !== campLabel) continue;
    const c = i % layout.cols;
    const r = Math.floor(i / layout.cols);
    minC = Math.min(minC, c);
    maxC = Math.max(maxC, c);
    minR = Math.min(minR, r);
    maxR = Math.max(maxR, r);
  }
  if (maxC < 0) return null;
  return { minC, maxC, minR, maxR };
}

/** Seat capacity derived from interior height: interiorH = 6*cellRows + 1. */
function roomCapacity(bbox: { minR: number; maxR: number }): number {
  const interiorH = bbox.maxR - bbox.minR + 1;
  const cellRows = Math.floor((interiorH - 1) / (WORKSTATION_CELL_H + CELL_GAP));
  return Math.max(0, cellRows) * CELLS_PER_ROW;
}

// ── Public entry point ───────────────────────────────────────

export interface EnsureCampAreaResult {
  layout: OfficeLayoutLike;
  /** True when the layout was modified (room built, grown, or rebuilt). */
  changed: boolean;
  /** Total seats available for this camp after the call. */
  seats: number;
  /** Human-readable note when something was skipped (e.g. invalid user area). */
  note?: string;
}

export interface EnsureCampAreaOptions {
  /** Allow wiping + rebuilding an invalid (fragmented/unenclosed) room that
   *  has OTel-placed furniture. Used by boot-time migration. */
  migrate?: boolean;
}

/**
 * Ensure the camp's Area exists as ONE contiguous walled room with at least
 * `neededSeats` workstations. Existing valid rooms are never moved; invalid
 * auto-materialized ones are rebuilt in place when `migrate` is set. Invalid
 * areas WITHOUT our furniture marker are left untouched (user-painted areas).
 * Deterministic: same inputs → same layout.
 */
export function ensureCampArea(
  inputLayout: OfficeLayoutLike,
  campLabel: string,
  neededSeats: number,
  catalog: readonly FurnitureAsset[],
  options: EnsureCampAreaOptions = {},
): EnsureCampAreaResult {
  // Deep-copy the arrays we mutate; leave everything else shared.
  const layout: OfficeLayoutLike = {
    ...inputLayout,
    tiles: [...inputLayout.tiles],
    furniture: [...inputLayout.furniture],
    ...(inputLayout.tileColors ? { tileColors: [...inputLayout.tileColors] } : {}),
    areas: inputLayout.areas ? [...inputLayout.areas] : [],
    areaTiles: inputLayout.areaTiles
      ? [...inputLayout.areaTiles]
      : new Array<string | null>(inputLayout.tiles.length).fill(null),
  };
  let changed = false;

  if (!(layout.areas ?? []).some((a) => a.label === campLabel)) {
    layout.areas = [...(layout.areas ?? []), { label: campLabel, color: areaColorForName(campLabel) }];
    changed = true;
  }

  const campSlug = slugify(campLabel);
  const pick = pickFurniture(catalog);
  const footprints = new Map<string, { w: number; h: number }>();
  for (const a of catalog) footprints.set(a.id, { w: a.footprintW, h: a.footprintH });

  // ── Existing room handling ──
  const status = analyzeCampRoom(layout, campLabel);
  if (status.kind === 'fragmented' || status.kind === 'unenclosed') {
    if (!hasOtelFurniture(layout, campLabel)) {
      return {
        layout,
        changed,
        seats: status.seats,
        note: `camp "${campLabel}" area is ${status.kind} but has no OTel furniture — left untouched (user area)`,
      };
    }
    if (!options.migrate) {
      return {
        layout,
        changed,
        seats: status.seats,
        note: `camp "${campLabel}" room is ${status.kind} — will be rebuilt on next migration pass`,
      };
    }
    // Migration: wipe the broken room and re-allocate below. Remnant walls
    // are kept (can't be told apart from user walls when the room is broken).
    wipeCamp(layout, campLabel, false);
    changed = true;
    neededSeats = Math.max(neededSeats, status.seats);
  } else if (status.kind === 'valid') {
    if (status.seats >= neededSeats) {
      return { layout, changed, seats: status.seats };
    }
    const bbox = labelBbox(layout, campLabel);
    if (!bbox) return { layout, changed, seats: status.seats };
    const capacity = roomCapacity(bbox);
    if (neededSeats <= capacity) {
      // Spare capacity: place the missing workstations in the existing
      // interior. Existing chairs never move.
      for (let n = status.seats; n < neededSeats; n++) {
        placeWorkstations(layout, campSlug, bbox.minC, bbox.minR, n, 1, pick);
      }
      return { layout, changed: true, seats: neededSeats };
    }
    // Room full: relocate — wipe the intact room (including our wall ring,
    // which unblocks the floor) and allocate a fresh, larger single room.
    // Workstation uids are stable (ws0..wsN), so seated characters keep their
    // seat assignments across the webview's layout rebuild.
    wipeCamp(layout, campLabel, true);
    changed = true;
    // fall through to fresh allocation below
  }

  // ── Fresh allocation (no room, or wiped by migration) ──
  const targetSeats = Math.max(neededSeats, countCampSeats(layout, campSlug));
  if (targetSeats > 0) {
    const placed = allocateRoom(layout, campLabel, campSlug, targetSeats, pick, footprints);
    if (!placed) {
      return {
        layout,
        changed,
        seats: 0,
        note: `no free region for camp "${campLabel}" and grid is at MAX — bindles use unzoned seats`,
      };
    }
    changed = true;
  }

  return { layout, changed, seats: countCampSeats(layout, campSlug) };
}
