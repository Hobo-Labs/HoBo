
import type { ColorValue } from '../components/ui/types.js';
import { CANVAS_ERROR_TILE_COLOR, FALLBACK_FLOOR_COLOR, TILE_SIZE } from '../constants.js';
import { clearColorizeCache, getColorizedSprite } from './colorize.js';
import type { SpriteData } from './types.js';

const DEFAULT_FLOOR_SPRITE: SpriteData = Array.from(
  { length: TILE_SIZE },
  () => Array(TILE_SIZE).fill(FALLBACK_FLOOR_COLOR) as string[],
);

let floorSprites: SpriteData[] = [];

export { WALL_COLOR } from '../constants.js';

export function setFloorSprites(sprites: SpriteData[]): void {
  floorSprites = sprites;
  clearColorizeCache();
}

function getFloorSprite(patternIndex: number): SpriteData | null {
  const idx = patternIndex - 1;
  if (idx < 0) return null;
  if (idx < floorSprites.length) return floorSprites[idx];
  if (floorSprites.length === 0 && patternIndex >= 1) return DEFAULT_FLOOR_SPRITE;
  return null;
}

export function hasFloorSprites(): boolean {
  return true;
}

export function getFloorPatternCount(): number {
  return floorSprites.length > 0 ? floorSprites.length : 1;
}


export function getColorizedFloorSprite(patternIndex: number, color: ColorValue): SpriteData {
  const key = `floor-${patternIndex}-${color.h}-${color.s}-${color.b}-${color.c}`;

  const base = getFloorSprite(patternIndex);
  if (!base) {
    const err: SpriteData = Array.from({ length: 16 }, () =>
      Array(16).fill(CANVAS_ERROR_TILE_COLOR),
    );
    return err;
  }

  return getColorizedSprite(key, base, { ...color, colorize: true });
}
