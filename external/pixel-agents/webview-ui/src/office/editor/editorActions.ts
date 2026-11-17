import type { ColorValue } from '../../components/ui/types.js';
import { DEFAULT_NEUTRAL_COLOR } from '../../constants.js';
import { getCatalogEntry, getRotatedType, getToggledType } from '../layout/furnitureCatalog.js';
import { getPlacementBlockedTiles } from '../layout/layoutSerializer.js';
import type {
  AreaDefinition,
  CarpetTile,
  OfficeLayout,
  PlacedFurniture,
  TileType as TileTypeVal,
} from '../types.js';
import { MAX_COLS, MAX_ROWS, TileType } from '../types.js';

export function paintTile(
  layout: OfficeLayout,
  col: number,
  row: number,
  tileType: TileTypeVal,
  color?: ColorValue,
): OfficeLayout {
  const idx = row * layout.cols + col;
  if (idx < 0 || idx >= layout.tiles.length) return layout;

  const existingColors = layout.tileColors || new Array(layout.tiles.length).fill(null);
  const newColor =
    color ??
    (tileType === TileType.WALL || tileType === TileType.VOID
      ? null
      : { ...DEFAULT_NEUTRAL_COLOR });

  if (layout.tiles[idx] === tileType) {
    const existingColor = existingColors[idx];
    if (newColor === null && existingColor === null) return layout;
    if (
      newColor &&
      existingColor &&
      newColor.h === existingColor.h &&
      newColor.s === existingColor.s &&
      newColor.b === existingColor.b &&
      newColor.c === existingColor.c &&
      !!newColor.colorize === !!existingColor.colorize
    )
      return layout;
  }

  const tiles = [...layout.tiles];
  tiles[idx] = tileType;
  const tileColors = [...existingColors];
  tileColors[idx] = newColor;
  return { ...layout, tiles, tileColors };
}

export function placeFurniture(layout: OfficeLayout, item: PlacedFurniture): OfficeLayout {
  if (!canPlaceFurniture(layout, item.type, item.col, item.row)) return layout;
  return { ...layout, furniture: [...layout.furniture, item] };
}

export function removeFurniture(layout: OfficeLayout, uid: string): OfficeLayout {
  const filtered = layout.furniture.filter((f) => f.uid !== uid);
  if (filtered.length === layout.furniture.length) return layout;
  return { ...layout, furniture: filtered };
}

export function moveFurniture(
  layout: OfficeLayout,
  uid: string,
  newCol: number,
  newRow: number,
): OfficeLayout {
  const item = layout.furniture.find((f) => f.uid === uid);
  if (!item) return layout;
  if (!canPlaceFurniture(layout, item.type, newCol, newRow, uid)) return layout;
  return {
    ...layout,
    furniture: layout.furniture.map((f) =>
      f.uid === uid ? { ...f, col: newCol, row: newRow } : f,
    ),
  };
}

export function rotateFurniture(
  layout: OfficeLayout,
  uid: string,
  direction: 'cw' | 'ccw',
): OfficeLayout {
  const item = layout.furniture.find((f) => f.uid === uid);
  if (!item) return layout;
  const newType = getRotatedType(item.type, direction);
  if (!newType) return layout;
  return {
    ...layout,
    furniture: layout.furniture.map((f) => (f.uid === uid ? { ...f, type: newType } : f)),
  };
}

export function toggleFurnitureState(layout: OfficeLayout, uid: string): OfficeLayout {
  const item = layout.furniture.find((f) => f.uid === uid);
  if (!item) return layout;
  const newType = getToggledType(item.type);
  if (!newType) return layout;
  return {
    ...layout,
    furniture: layout.furniture.map((f) => (f.uid === uid ? { ...f, type: newType } : f)),
  };
}

export function getWallPlacementRow(type: string, row: number): number {
  const entry = getCatalogEntry(type);
  if (!entry?.canPlaceOnWalls) return row;
  return row - (entry.footprintH - 1);
}

export function canPlaceFurniture(
  layout: OfficeLayout,
  type: string,
  col: number,
  row: number,
  excludeUid?: string,
): boolean {
  const entry = getCatalogEntry(type);
  if (!entry) return false;

  if (entry.canPlaceOnWalls) {
    const bottomRow = row + entry.footprintH - 1;
    if (
      col < 0 ||
      col + entry.footprintW > layout.cols ||
      bottomRow < 0 ||
      bottomRow >= layout.rows
    ) {
      return false;
    }
  } else {
    if (
      col < 0 ||
      row < 0 ||
      col + entry.footprintW > layout.cols ||
      row + entry.footprintH > layout.rows
    ) {
      return false;
    }
  }

  const bgRows = entry.backgroundTiles || 0;
  for (let dr = 0; dr < entry.footprintH; dr++) {
    if (dr < bgRows) continue;
    if (row + dr < 0) continue;
    if (entry.canPlaceOnWalls && dr < entry.footprintH - 1) continue;
    for (let dc = 0; dc < entry.footprintW; dc++) {
      const idx = (row + dr) * layout.cols + (col + dc);
      const tileVal = layout.tiles[idx];
      if (entry.canPlaceOnWalls) {
        if (tileVal !== TileType.WALL) return false;
      } else {
        if (tileVal === TileType.VOID) return false;
        if (tileVal === TileType.WALL) return false;
      }
    }
  }

  const occupied = getPlacementBlockedTiles(layout.furniture, excludeUid);

  let deskTiles: Set<string> | null = null;
  if (entry.canPlaceOnSurfaces) {
    deskTiles = new Set<string>();
    for (const item of layout.furniture) {
      if (item.uid === excludeUid) continue;
      const itemEntry = getCatalogEntry(item.type);
      if (!itemEntry || !itemEntry.isDesk) continue;
      for (let dr = 0; dr < itemEntry.footprintH; dr++) {
        for (let dc = 0; dc < itemEntry.footprintW; dc++) {
          deskTiles.add(`${item.col + dc},${item.row + dr}`);
        }
      }
    }
  }

  const newBgRows = entry.backgroundTiles || 0;
  for (let dr = 0; dr < entry.footprintH; dr++) {
    if (dr < newBgRows) continue;
    if (row + dr < 0) continue;
    for (let dc = 0; dc < entry.footprintW; dc++) {
      const key = `${col + dc},${row + dr}`;
      if (occupied.has(key) && !deskTiles?.has(key)) return false;
    }
  }

  return true;
}

export function paintCarpet(
  layout: OfficeLayout,
  col: number,
  row: number,
  variant: number,
  color?: ColorValue,
  accentColor?: ColorValue,
  order?: number,
): OfficeLayout {
  if (col < 0 || col >= layout.cols || row < 0 || row >= layout.rows) return layout;
  const idx = row * layout.cols + col;
  if (idx < 0 || idx >= layout.tiles.length) return layout;
  const tileVal = layout.tiles[idx];
  if (tileVal === TileType.VOID || tileVal === TileType.WALL) return layout;

  const existing =
    layout.carpetTiles ?? new Array<CarpetTile | null>(layout.tiles.length).fill(null);
  let maxOrder = 0;
  for (const c of existing) {
    if (c && typeof c.order === 'number' && c.order > maxOrder) maxOrder = c.order;
  }
  const nextOrder = order ?? maxOrder + 1;

  const newTile: CarpetTile = { variant, order: nextOrder };
  if (color !== undefined) newTile.color = { ...color };
  if (accentColor !== undefined) newTile.accentColor = { ...accentColor };

  const carpetTiles = [...existing];
  carpetTiles[idx] = newTile;
  return { ...layout, carpetTiles };
}

export function eraseCarpet(layout: OfficeLayout, col: number, row: number): OfficeLayout {
  if (col < 0 || col >= layout.cols || row < 0 || row >= layout.rows) return layout;
  const idx = row * layout.cols + col;
  if (idx < 0 || idx >= layout.tiles.length) return layout;
  if (!layout.carpetTiles || layout.carpetTiles[idx] == null) return layout;
  const carpetTiles = [...layout.carpetTiles];
  carpetTiles[idx] = null;
  return { ...layout, carpetTiles };
}

export function paintArea(
  layout: OfficeLayout,
  col: number,
  row: number,
  areaLabel: string,
): OfficeLayout {
  if (col < 0 || col >= layout.cols || row < 0 || row >= layout.rows) return layout;
  const idx = row * layout.cols + col;
  if (idx < 0 || idx >= layout.tiles.length) return layout;
  const tileVal = layout.tiles[idx];
  if (tileVal === TileType.VOID || tileVal === TileType.WALL) return layout;
  if (!(layout.areas ?? []).some((a) => a.label === areaLabel)) return layout;

  const areaTiles = layout.areaTiles
    ? [...layout.areaTiles]
    : new Array<string | null>(layout.tiles.length).fill(null);
  if (areaTiles[idx] === areaLabel) return layout;
  areaTiles[idx] = areaLabel;
  return { ...layout, areaTiles };
}

export function eraseArea(layout: OfficeLayout, col: number, row: number): OfficeLayout {
  if (col < 0 || col >= layout.cols || row < 0 || row >= layout.rows) return layout;
  const idx = row * layout.cols + col;
  if (idx < 0 || idx >= layout.tiles.length) return layout;
  if (!layout.areaTiles || layout.areaTiles[idx] == null) return layout;
  const areaTiles = [...layout.areaTiles];
  areaTiles[idx] = null;
  return { ...layout, areaTiles };
}

export function addArea(layout: OfficeLayout, label: string, color: string): OfficeLayout {
  const trimmed = label.trim();
  if (!trimmed) return layout;
  const existing = layout.areas ?? [];
  if (existing.some((a) => a.label === trimmed)) return layout;
  const areas: AreaDefinition[] = [...existing, { label: trimmed, color }];
  return { ...layout, areas };
}

export function removeArea(layout: OfficeLayout, label: string): OfficeLayout {
  const existing = layout.areas ?? [];
  if (!existing.some((a) => a.label === label)) return layout;
  const areas = existing.filter((a) => a.label !== label);
  let areaTiles = layout.areaTiles;
  if (areaTiles && areaTiles.some((t) => t === label)) {
    areaTiles = areaTiles.map((t) => (t === label ? null : t));
  }
  return { ...layout, areas, areaTiles };
}

export function renameArea(layout: OfficeLayout, oldLabel: string, newLabel: string): OfficeLayout {
  const trimmed = newLabel.trim();
  if (!trimmed || trimmed === oldLabel) return layout;
  const existing = layout.areas ?? [];
  if (!existing.some((a) => a.label === oldLabel)) return layout;
  if (existing.some((a) => a.label === trimmed)) return layout;
  const areas = existing.map((a) => (a.label === oldLabel ? { ...a, label: trimmed } : a));
  let areaTiles = layout.areaTiles;
  if (areaTiles && areaTiles.some((t) => t === oldLabel)) {
    areaTiles = areaTiles.map((t) => (t === oldLabel ? trimmed : t));
  }
  return { ...layout, areas, areaTiles };
}

export function updateAreaColor(layout: OfficeLayout, label: string, color: string): OfficeLayout {
  const existing = layout.areas ?? [];
  const idx = existing.findIndex((a) => a.label === label);
  if (idx === -1) return layout;
  if (existing[idx].color === color) return layout;
  const areas = existing.map((a, i) => (i === idx ? { ...a, color } : a));
  return { ...layout, areas };
}

export type ExpandDirection = 'left' | 'right' | 'up' | 'down';

export function expandLayout(
  layout: OfficeLayout,
  direction: ExpandDirection,
): { layout: OfficeLayout; shift: { col: number; row: number } } | null {
  const { cols, rows, tiles, furniture, tileColors, carpetTiles, areaTiles } = layout;
  const existingColors = tileColors || new Array(tiles.length).fill(null);

  let newCols = cols;
  let newRows = rows;
  let shiftCol = 0;
  let shiftRow = 0;

  if (direction === 'right') {
    newCols = cols + 1;
  } else if (direction === 'left') {
    newCols = cols + 1;
    shiftCol = 1;
  } else if (direction === 'down') {
    newRows = rows + 1;
  } else if (direction === 'up') {
    newRows = rows + 1;
    shiftRow = 1;
  }

  if (newCols > MAX_COLS || newRows > MAX_ROWS) return null;

  const newSize = newCols * newRows;
  const newTiles: TileTypeVal[] = new Array(newSize).fill(TileType.VOID as TileTypeVal);
  const newColors: Array<ColorValue | null> = new Array(newSize).fill(null);
  const newCarpetTiles: Array<CarpetTile | null> | undefined = carpetTiles
    ? new Array<CarpetTile | null>(newSize).fill(null)
    : undefined;
  const newAreaTiles: Array<string | null> | undefined = areaTiles
    ? new Array<string | null>(newSize).fill(null)
    : undefined;

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const oldIdx = r * cols + c;
      const newIdx = (r + shiftRow) * newCols + (c + shiftCol);
      newTiles[newIdx] = tiles[oldIdx];
      newColors[newIdx] = existingColors[oldIdx];
      if (newCarpetTiles && carpetTiles) {
        newCarpetTiles[newIdx] = carpetTiles[oldIdx] ?? null;
      }
      if (newAreaTiles && areaTiles) {
        newAreaTiles[newIdx] = areaTiles[oldIdx] ?? null;
      }
    }
  }

  const newFurniture: PlacedFurniture[] = furniture.map((f) => ({
    ...f,
    col: f.col + shiftCol,
    row: f.row + shiftRow,
  }));

  return {
    layout: {
      ...layout,
      cols: newCols,
      rows: newRows,
      tiles: newTiles,
      tileColors: newColors,
      furniture: newFurniture,
      ...(newCarpetTiles ? { carpetTiles: newCarpetTiles } : {}),
      ...(newAreaTiles ? { areaTiles: newAreaTiles } : {}),
    },
    shift: { col: shiftCol, row: shiftRow },
  };
}
