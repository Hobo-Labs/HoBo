
import { PNG } from 'pngjs';

import { rgbaToHex } from './colorUtils.js';
import {
  CARPET_GRID_COLS,
  CARPET_MARCHING_SQUARES_COUNT,
  CARPET_TILE_SIZE,
  CHAR_FRAME_H,
  CHAR_FRAME_W,
  CHAR_FRAMES_PER_ROW,
  CHARACTER_DIRECTIONS,
  FLOOR_TILE_SIZE,
  PET_FRAME_H,
  PET_FRAME_W_LARGE,
  PET_FRAME_W_SMALL,
  PET_IDLE_FRAMES_VERT,
  PET_IMAGE_HEIGHT,
  PET_IMAGE_WIDTH,
  PET_WALK_FRAMES_HORIZ,
  PET_WALK_FRAMES_VERT,
  WALL_BITMASK_COUNT,
  WALL_GRID_COLS,
  WALL_PIECE_HEIGHT,
  WALL_PIECE_WIDTH,
} from './constants.js';
import type { CharacterDirectionSprites, PetSpriteFrames } from './types.js';


function sanitizePngBuffer(buf: Buffer): Buffer {
  for (let i = buf.length - 8; i >= 8; i--) {
    if (buf[i] === 0x49 && buf[i + 1] === 0x45 && buf[i + 2] === 0x4e && buf[i + 3] === 0x44) {
      const endPos = i + 4 + 4;
      if (buf.length > endPos) {
        return buf.subarray(0, endPos);
      }
      break;
    }
  }
  return buf;
}

export function pngToSpriteData(pngBuffer: Buffer, width: number, height: number): string[][] {
  try {
    const png = PNG.sync.read(sanitizePngBuffer(pngBuffer));

    if (png.width !== width || png.height !== height) {
      console.warn(
        `PNG dimensions mismatch: expected ${width}×${height}, got ${png.width}×${png.height}`,
      );
    }

    const sprite: string[][] = [];
    const data = png.data;

    for (let y = 0; y < height; y++) {
      const row: string[] = [];
      for (let x = 0; x < width; x++) {
        const pixelIndex = (y * png.width + x) * 4;
        const r = data[pixelIndex];
        const g = data[pixelIndex + 1];
        const b = data[pixelIndex + 2];
        const a = data[pixelIndex + 3];
        row.push(rgbaToHex(r, g, b, a));
      }
      sprite.push(row);
    }

    return sprite;
  } catch (err) {
    console.warn(`Failed to parse PNG: ${err instanceof Error ? err.message : err}`);
    const sprite: string[][] = [];
    for (let y = 0; y < height; y++) {
      sprite.push(new Array(width).fill(''));
    }
    return sprite;
  }
}

export function parseWallPng(pngBuffer: Buffer): string[][][] {
  const png = PNG.sync.read(sanitizePngBuffer(pngBuffer));
  const sprites: string[][][] = [];
  for (let mask = 0; mask < WALL_BITMASK_COUNT; mask++) {
    const ox = (mask % WALL_GRID_COLS) * WALL_PIECE_WIDTH;
    const oy = Math.floor(mask / WALL_GRID_COLS) * WALL_PIECE_HEIGHT;
    const sprite: string[][] = [];
    for (let r = 0; r < WALL_PIECE_HEIGHT; r++) {
      const row: string[] = [];
      for (let c = 0; c < WALL_PIECE_WIDTH; c++) {
        const idx = ((oy + r) * png.width + (ox + c)) * 4;
        const rv = png.data[idx];
        const gv = png.data[idx + 1];
        const bv = png.data[idx + 2];
        const av = png.data[idx + 3];
        row.push(rgbaToHex(rv, gv, bv, av));
      }
      sprite.push(row);
    }
    sprites.push(sprite);
  }
  return sprites;
}

export function parseCarpetPng(pngBuffer: Buffer): string[][][] {
  const png = PNG.sync.read(pngBuffer);
  const sprites: string[][][] = [];
  for (let msCase = 0; msCase < CARPET_MARCHING_SQUARES_COUNT; msCase++) {
    const ox = (msCase % CARPET_GRID_COLS) * CARPET_TILE_SIZE;
    const oy = Math.floor(msCase / CARPET_GRID_COLS) * CARPET_TILE_SIZE;
    const sprite: string[][] = [];
    for (let r = 0; r < CARPET_TILE_SIZE; r++) {
      const row: string[] = [];
      for (let c = 0; c < CARPET_TILE_SIZE; c++) {
        const idx = ((oy + r) * png.width + (ox + c)) * 4;
        const rv = png.data[idx];
        const gv = png.data[idx + 1];
        const bv = png.data[idx + 2];
        const av = png.data[idx + 3];
        row.push(rgbaToHex(rv, gv, bv, av));
      }
      sprite.push(row);
    }
    sprites.push(sprite);
  }
  return sprites;
}

export function decodeCharacterPng(pngBuffer: Buffer): CharacterDirectionSprites {
  const png = PNG.sync.read(sanitizePngBuffer(pngBuffer));
  const charData: CharacterDirectionSprites = { down: [], up: [], right: [] };

  for (let dirIdx = 0; dirIdx < CHARACTER_DIRECTIONS.length; dirIdx++) {
    const dir = CHARACTER_DIRECTIONS[dirIdx];
    const rowOffsetY = dirIdx * CHAR_FRAME_H;
    const frames: string[][][] = [];

    for (let f = 0; f < CHAR_FRAMES_PER_ROW; f++) {
      const sprite: string[][] = [];
      const frameOffsetX = f * CHAR_FRAME_W;
      for (let y = 0; y < CHAR_FRAME_H; y++) {
        const row: string[] = [];
        for (let x = 0; x < CHAR_FRAME_W; x++) {
          const idx = ((rowOffsetY + y) * png.width + (frameOffsetX + x)) * 4;
          const r = png.data[idx];
          const g = png.data[idx + 1];
          const b = png.data[idx + 2];
          const a = png.data[idx + 3];
          row.push(rgbaToHex(r, g, b, a));
        }
        sprite.push(row);
      }
      frames.push(sprite);
    }
    charData[dir] = frames;
  }

  return charData;
}

export function decodeFloorPng(pngBuffer: Buffer): string[][] {
  return pngToSpriteData(pngBuffer, FLOOR_TILE_SIZE, FLOOR_TILE_SIZE);
}

export function decodePetPng(pngBuffer: Buffer): PetSpriteFrames {
  try {
    const png = PNG.sync.read(sanitizePngBuffer(pngBuffer));

    if (png.width !== PET_IMAGE_WIDTH || png.height !== PET_IMAGE_HEIGHT) {
      console.warn(
        `[PngDecoder] Pet sprite has unexpected dimensions: ${png.width}×${png.height} (expected ${PET_IMAGE_WIDTH}×${PET_IMAGE_HEIGHT})`,
      );
      throw new Error('Invalid pet sprite dimensions');
    }

    function extractFrame(ox: number, oy: number, w: number, h: number): string[][] {
      const sprite: string[][] = [];
      for (let y = 0; y < h; y++) {
        const row: string[] = [];
        for (let x = 0; x < w; x++) {
          const idx = ((oy + y) * png.width + (ox + x)) * 4;
          row.push(
            rgbaToHex(png.data[idx], png.data[idx + 1], png.data[idx + 2], png.data[idx + 3]),
          );
        }
        sprite.push(row);
      }
      return sprite;
    }

    const walkDown: string[][][] = [];
    for (let f = 0; f < PET_WALK_FRAMES_VERT; f++) {
      walkDown.push(extractFrame(f * PET_FRAME_W_SMALL, 0, PET_FRAME_W_SMALL, PET_FRAME_H));
    }
    const idleDown: string[][][] = [];
    for (let f = 0; f < PET_IDLE_FRAMES_VERT; f++) {
      idleDown.push(
        extractFrame(
          (PET_WALK_FRAMES_VERT + f) * PET_FRAME_W_SMALL,
          0,
          PET_FRAME_W_SMALL,
          PET_FRAME_H,
        ),
      );
    }

    const walkUp: string[][][] = [];
    for (let f = 0; f < PET_WALK_FRAMES_VERT; f++) {
      walkUp.push(extractFrame(f * PET_FRAME_W_SMALL, PET_FRAME_H, PET_FRAME_W_SMALL, PET_FRAME_H));
    }
    const idleUp: string[][][] = [];
    for (let f = 0; f < PET_IDLE_FRAMES_VERT; f++) {
      idleUp.push(
        extractFrame(
          (PET_WALK_FRAMES_VERT + f) * PET_FRAME_W_SMALL,
          PET_FRAME_H,
          PET_FRAME_W_SMALL,
          PET_FRAME_H,
        ),
      );
    }

    const walkRight: string[][][] = [];
    for (let f = 0; f < PET_WALK_FRAMES_HORIZ; f++) {
      walkRight.push(
        extractFrame(f * PET_FRAME_W_LARGE, PET_FRAME_H * 2, PET_FRAME_W_LARGE, PET_FRAME_H),
      );
    }

    return { walkDown, idleDown, walkUp, idleUp, walkRight };
  } catch (err) {
    console.warn(
      `[PngDecoder] Failed to parse pet PNG: ${err instanceof Error ? err.message : err}`,
    );
    const emptySmall = (): string[][] =>
      Array.from({ length: PET_FRAME_H }, () => new Array(PET_FRAME_W_SMALL).fill(''));
    const emptyLarge = (): string[][] =>
      Array.from({ length: PET_FRAME_H }, () => new Array(PET_FRAME_W_LARGE).fill(''));
    return {
      walkDown: [emptySmall(), emptySmall(), emptySmall()],
      idleDown: [emptySmall(), emptySmall(), emptySmall()],
      walkUp: [emptySmall(), emptySmall(), emptySmall()],
      idleUp: [emptySmall(), emptySmall(), emptySmall()],
      walkRight: [emptyLarge(), emptyLarge(), emptyLarge()],
    };
  }
}
