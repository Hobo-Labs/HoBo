
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

export function areaColorForName(name: string): string {
  const hue = fnv1a(name) % 360;
  return hslToHex(hue, 0.65, 0.55);
}

export function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'otel';
}


const CELLS_PER_ROW = 3;
const CELL_GAP = 1;

export interface RoomSize {
  roomW: number;
  roomH: number;
  interiorW: number;
  interiorH: number;
  cellRows: number;
  capacity: number;
}

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


export type CampRoomStatus =
  | { kind: 'absent' }
  | { kind: 'valid'; seats: number }
  | { kind: 'fragmented'; components: number; seats: number }
  | { kind: 'unenclosed'; leaks: number; seats: number };

function countCampSeats(layout: OfficeLayoutLike, campSlug: string): number {
  const prefix = `otel-${campSlug}-ws`;
  let seats = 0;
  for (const f of layout.furniture) {
    if (f.uid.startsWith(prefix) && f.uid.endsWith('-chair')) seats += 1;
  }
  return seats;
}

export function hasOtelFurniture(layout: OfficeLayoutLike, campLabel: string): boolean {
  const prefix = `otel-${slugify(campLabel)}-ws`;
  return layout.furniture.some((f) => f.uid.startsWith(prefix));
}

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
        break;
      }
    }
  }
  if (leaks > 2) return { kind: 'unenclosed', leaks, seats };
  return { kind: 'valid', seats };
}

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

function punchCorridorUp(layout: OfficeLayoutLike, doorCols: number[], doorRow: number): void {
  for (const dc of doorCols) {
    let seenWall = false;
    for (let r = doorRow - 1; r >= 0; r--) {
      const t = tileAt(layout, dc, r);
      if (t === TILE_WALL) {
        const above = r > 0 ? (layout.areaTiles?.[(r - 1) * layout.cols + dc] ?? null) : null;
        if (above !== null) break;
        seenWall = true;
        setTile(layout, dc, r, TILE_FLOOR_1);
      } else if (seenWall) {
        break;
      }
    }
  }
}

function allocateRoom(
  layout: OfficeLayoutLike,
  campLabel: string,
  campSlug: string,
  seats: number,
  pick: FurniturePick,
  footprints: ReadonlyMap<string, { w: number; h: number }>,
): boolean {
  const size = roomSizeForSeats(seats);
  const searchW = size.roomW + 2;
  const searchH = size.roomH + 2;

  let origin = findFreeRegion(layout, searchW, searchH, buildFootprints(layout, footprints));
  let grew = false;
  if (!origin) {
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

function copyInto(target: OfficeLayoutLike, source: OfficeLayoutLike): OfficeLayoutLike {
  target.cols = source.cols;
  target.rows = source.rows;
  target.tiles = source.tiles;
  if (source.tileColors) target.tileColors = source.tileColors;
  if (source.areaTiles) target.areaTiles = source.areaTiles;
  return target;
}

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

function roomCapacity(bbox: { minR: number; maxR: number }): number {
  const interiorH = bbox.maxR - bbox.minR + 1;
  const cellRows = Math.floor((interiorH - 1) / (WORKSTATION_CELL_H + CELL_GAP));
  return Math.max(0, cellRows) * CELLS_PER_ROW;
}


export interface EnsureCampAreaResult {
  layout: OfficeLayoutLike;
  changed: boolean;
  seats: number;
  note?: string;
}

export interface EnsureCampAreaOptions {
  migrate?: boolean;
}

export function ensureCampArea(
  inputLayout: OfficeLayoutLike,
  campLabel: string,
  neededSeats: number,
  catalog: readonly FurnitureAsset[],
  options: EnsureCampAreaOptions = {},
): EnsureCampAreaResult {
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
      for (let n = status.seats; n < neededSeats; n++) {
        placeWorkstations(layout, campSlug, bbox.minC, bbox.minR, n, 1, pick);
      }
      return { layout, changed: true, seats: neededSeats };
    }
    wipeCamp(layout, campLabel, true);
    changed = true;
  }

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
