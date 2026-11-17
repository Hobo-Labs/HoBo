
import type { ColorValue } from '../../components/ui/types.js';
import { CARPET_DEFAULT_ACCENT_COLOR, CARPET_DEFAULT_COLOR } from '../../constants.js';
import { flatColorizeSprite } from '../colorize.js';
import type { CarpetTile, SpriteData } from '../types.js';


let carpetSets: SpriteData[][] = [];

let carpetVariantPalettes: Array<{ mainRgb: string | null; accentRgb: string | null }> = [];

const carpetCache: Map<string, SpriteData> = new Map();


/**
 * Register carpet sprite sheets. Invalidates the dual-color cache.
 *
 * @param sets `sets[variant][msCase]` — 16×16 SpriteData per marching-squares case.
 *             Expected 16 msCase entries per variant; missing entries are tolerated
 *             via tileHasVariant() and getCarpetJunctionSprite() guards.
 */
export function setCarpetSprites(sets: SpriteData[][]): void {
  carpetSets = sets;
  carpetCache.clear();
  carpetVariantPalettes = sets.map((variantSprites) => classifyCarpetPalette(variantSprites));
}

export function hasCarpetSprites(): boolean {
  return carpetSets.length > 0;
}

export function getCarpetSetCount(): number {
  return carpetSets.length;
}

/** Return the raw sprite sheet for a variant (or undefined). Used by editor previews.
 *
 * @public
 */
export function getCarpetVariantSprites(variant: number): SpriteData[] | undefined {
  if (variant < 0 || variant >= carpetSets.length) return undefined;
  return carpetSets[variant];
}

export function getCarpetColorKey(color: ColorValue): string {
  return `${color.h}|${color.s}|${color.b}|${color.c}|${color.colorize ? 1 : 0}`;
}

export function getCarpetPaletteKey(color: ColorValue, accentColor: ColorValue): string {
  return `${getCarpetColorKey(color)}#${getCarpetColorKey(accentColor)}`;
}

/**
 * Resolve and return the merged, colorized SpriteData for a single junction.
 *
 * @param jx Junction column (0..cols). Junctions sit at corners.
 * @param jy Junction row (0..rows).
 * @returns null if the variant is unloaded, the junction's msCase is missing,
 *          or the variant's palette classification yielded no main color.
 */
export function getCarpetJunctionSprite(
  jx: number,
  jy: number,
  variant: number,
  carpetTiles: Array<CarpetTile | null>,
  cols: number,
  rows: number,
  color: ColorValue = CARPET_DEFAULT_COLOR,
  accentColor: ColorValue = CARPET_DEFAULT_ACCENT_COLOR,
  paletteKey: string = getCarpetPaletteKey(color, accentColor),
): SpriteData | null {
  if (variant < 0 || variant >= carpetSets.length) return null;

  const msCase = carpetJunctionCase(jx, jy, variant, carpetTiles, cols, rows, paletteKey);

  if (msCase === 0) return null;

  const variantSet = carpetSets[variant];
  const baseSprite = variantSet?.[msCase];
  if (!baseSprite) return null;

  const palette = carpetVariantPalettes[variant];
  if (!palette || !palette.mainRgb) return null;

  const cacheKey = `${variant}:${msCase}:${paletteKey}`;
  return getDualColorizedCarpetSprite(cacheKey, baseSprite, palette, color, accentColor);
}

export function carpetJunctionCase(
  jx: number,
  jy: number,
  variant: number,
  carpetTiles: Array<CarpetTile | null>,
  cols: number,
  rows: number,
  paletteKey?: string,
): number {
  let msCase = 0;
  if (tileHasVariant(jx - 1, jy - 1, variant, carpetTiles, cols, rows, paletteKey)) msCase |= 1;
  if (tileHasVariant(jx, jy - 1, variant, carpetTiles, cols, rows, paletteKey)) msCase |= 2;
  if (tileHasVariant(jx, jy, variant, carpetTiles, cols, rows, paletteKey)) msCase |= 4;
  if (tileHasVariant(jx - 1, jy, variant, carpetTiles, cols, rows, paletteKey)) msCase |= 8;
  return msCase;
}


function tileHasVariant(
  col: number,
  row: number,
  variant: number,
  carpetTiles: Array<CarpetTile | null>,
  cols: number,
  rows: number,
  paletteKey?: string,
): boolean {
  if (col < 0 || row < 0 || col >= cols || row >= rows) return false;
  const tile = carpetTiles[row * cols + col];
  if (!tile || tile.variant !== variant) return false;
  if (paletteKey !== undefined) {
    const tileColor = tile.color ?? CARPET_DEFAULT_COLOR;
    const tileAccent = tile.accentColor ?? CARPET_DEFAULT_ACCENT_COLOR;
    if (getCarpetPaletteKey(tileColor, tileAccent) !== paletteKey) return false;
  }
  return true;
}


function classifyCarpetPalette(variantSprites: SpriteData[]): {
  mainRgb: string | null;
  accentRgb: string | null;
} {
  const unique = new Set<string>();
  for (const sprite of variantSprites) {
    if (!sprite) continue;
    for (const row of sprite) {
      for (const pixel of row) {
        if (pixel === '') continue;
        const rgb = pixel.length === 9 ? pixel.slice(0, 7) : pixel;
        unique.add(rgb);
      }
    }
  }

  if (unique.size === 0) {
    return { mainRgb: null, accentRgb: null };
  }

  const sorted = [...unique].sort((a, b) => luminanceFromRgb(a) - luminanceFromRgb(b));

  if (sorted.length === 1) {
    return { mainRgb: sorted[0], accentRgb: sorted[0] };
  }

  return {
    mainRgb: sorted[0],
    accentRgb: sorted[sorted.length - 1],
  };
}

function luminanceFromRgb(rgb: string): number {
  const r = parseInt(rgb.slice(1, 3), 16);
  const g = parseInt(rgb.slice(3, 5), 16);
  const b = parseInt(rgb.slice(5, 7), 16);
  return 0.299 * r + 0.587 * g + 0.114 * b;
}


function getDualColorizedCarpetSprite(
  cacheKey: string,
  baseSprite: SpriteData,
  palette: { mainRgb: string | null; accentRgb: string | null },
  color: ColorValue,
  accentColor: ColorValue,
): SpriteData | null {
  const cached = carpetCache.get(cacheKey);
  if (cached) return cached;

  if (!palette.mainRgb) return null;

  const accentRgb = palette.accentRgb ?? palette.mainRgb;

  const mainMask = maskCarpetSprite(baseSprite, palette.mainRgb);
  const accentMask = maskCarpetSprite(baseSprite, accentRgb);

  const mainLayer = flatColorizeSprite(mainMask, color);
  const accentLayer = flatColorizeSprite(accentMask, accentColor);

  const merged = mergeCarpetLayers(mainLayer, accentLayer);
  carpetCache.set(cacheKey, merged);
  return merged;
}

function maskCarpetSprite(sprite: SpriteData, rgb: string): SpriteData {
  return sprite.map((row) =>
    row.map((pixel) => {
      if (pixel === '') return '';
      const pixelRgb = pixel.length === 9 ? pixel.slice(0, 7) : pixel;
      return pixelRgb === rgb ? pixel : '';
    }),
  );
}

function mergeCarpetLayers(base: SpriteData, accent: SpriteData): SpriteData {
  const rows = base.length;
  const result: SpriteData = new Array(rows);
  for (let r = 0; r < rows; r++) {
    const baseRow = base[r];
    const accentRow = accent[r];
    const cols = baseRow.length;
    const out: string[] = new Array(cols);
    for (let c = 0; c < cols; c++) {
      const accentPixel = accentRow[c];
      out[c] = accentPixel !== '' ? accentPixel : baseRow[c];
    }
    result[r] = out;
  }
  return result;
}
