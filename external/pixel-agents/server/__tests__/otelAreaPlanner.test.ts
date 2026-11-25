import { describe, expect, it } from 'vitest';

import type { FurnitureAsset } from '../src/assetLoader.js';
import type { OfficeLayoutLike } from '../src/providers/otel/areaPlanner.js';
import {
  analyzeCampRoom,
  areaColorForName,
  ensureCampArea,
  findFreeRegion,
  roomSizeForSeats,
  slugify,
} from '../src/providers/otel/areaPlanner.js';
import { TILE_FLOOR_1, TILE_WALL } from '../src/providers/otel/constants.js';

/** Minimal furniture catalog: one desk (3x2, front) + one chair (1x2, back). */
function testCatalog(): FurnitureAsset[] {
  return [
    {
      id: 'DESK_FRONT',
      name: 'Desk',
      label: 'Desk',
      category: 'desks',
      file: 'DESK_FRONT.png',
      width: 48,
      height: 32,
      footprintW: 3,
      footprintH: 2,
      isDesk: true,
      canPlaceOnWalls: false,
      orientation: 'front',
    },
    {
      id: 'WOODEN_CHAIR_BACK',
      name: 'Wooden Chair',
      label: 'Wooden Chair',
      category: 'chairs',
      file: 'WOODEN_CHAIR_BACK.png',
      width: 16,
      height: 32,
      footprintW: 1,
      footprintH: 2,
      isDesk: false,
      canPlaceOnWalls: false,
      orientation: 'back',
      backgroundTiles: 1,
    },
  ];
}

/** Flat empty office: wall border, floor inside, no furniture. */
function emptyLayout(cols: number, rows: number): OfficeLayoutLike {
  const tiles: number[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const border = r === 0 || r === rows - 1 || c === 0 || c === cols - 1;
      tiles.push(border ? TILE_WALL : TILE_FLOOR_1);
    }
  }
  return { version: 1, cols, rows, tiles, furniture: [] };
}

/** All grid indices labeled with `label`. */
function labeledIndices(layout: OfficeLayoutLike, label: string): number[] {
  const out: number[] = [];
  layout.areaTiles?.forEach((t, i) => {
    if (t === label) out.push(i);
  });
  return out;
}

/** 4-connected components over a set of grid indices. */
function components(layout: OfficeLayoutLike, indices: number[]): number {
  const set = new Set(indices);
  const seen = new Set<number>();
  let count = 0;
  for (const start of indices) {
    if (seen.has(start)) continue;
    count += 1;
    const stack = [start];
    seen.add(start);
    while (stack.length > 0) {
      const idx = stack.pop()!;
      const c = idx % layout.cols;
      const r = Math.floor(idx / layout.cols);
      for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const nc = c + dc;
        const nr = r + dr;
        const nIdx = nr * layout.cols + nc;
        if (nc >= 0 && nc < layout.cols && nr >= 0 && nr < layout.rows && set.has(nIdx) && !seen.has(nIdx)) {
          seen.add(nIdx);
          stack.push(nIdx);
        }
      }
    }
  }
  return count;
}

function chairsOf(layout: OfficeLayoutLike, campSlug: string) {
  return layout.furniture.filter((f) => f.uid.startsWith(`otel-${campSlug}-ws`) && f.uid.endsWith('-chair'));
}

describe('areaColorForName / slugify', () => {
  it('is deterministic and produces hex colors', () => {
    expect(areaColorForName('payments')).toBe(areaColorForName('payments'));
    expect(areaColorForName('payments')).toMatch(/^#[0-9a-f]{6}$/);
    expect(areaColorForName('payments')).not.toBe(areaColorForName('search'));
  });

  it('normalizes names for uids/paths', () => {
    expect(slugify('Payments EU')).toBe('payments-eu');
    expect(slugify('---')).toBe('otel');
  });
});

describe('findFreeRegion', () => {
  it('finds the first top-left free rect, avoiding furniture', () => {
    const layout = emptyLayout(12, 12);
    layout.furniture.push({ uid: 'x', type: 'DESK_FRONT', col: 1, row: 1 });
    const origin = findFreeRegion(layout, 4, 5, [{ col: 1, row: 1, w: 3, h: 2 }]);
    expect(origin).toEqual({ col: 4, row: 1 });
  });

  it('returns null when nothing fits', () => {
    expect(findFreeRegion(emptyLayout(4, 4), 10, 10, [])).toBeNull();
  });
});

describe('ensureCampArea — room allocation', () => {
  it('allocates ONE contiguous enclosed room per camp', () => {
    const { layout, seats } = ensureCampArea(emptyLayout(24, 24), 'payments', 3, testCatalog());
    expect(seats).toBe(3);

    const labeled = labeledIndices(layout, 'payments');
    expect(labeled.length).toBeGreaterThan(0);
    // Contiguity: exactly one connected component.
    expect(components(layout, labeled)).toBe(1);
    // Enclosure: analyzer sees a valid room (≤2 leak adjacencies = the door).
    expect(analyzeCampRoom(layout, 'payments').kind).toBe('valid');
  });

  it('encloses the room with walls and exactly one door gap in the top wall', () => {
    const { layout } = ensureCampArea(emptyLayout(24, 24), 'payments', 3, testCatalog());
    const labeled = labeledIndices(layout, 'payments');
    const rows = labeled.map((i) => Math.floor(i / layout.cols));
    const cols = labeled.map((i) => i % layout.cols);
    const minR = Math.min(...rows);
    const maxR = Math.max(...rows);
    const minC = Math.min(...cols);
    const maxC = Math.max(...cols);
    const wallRow = minR - 1;

    // The wall line directly above the labeled interior: all WALL except the door.
    const doorTiles: number[] = [];
    for (let c = minC - 1; c <= maxC + 1; c++) {
      const t = layout.tiles[wallRow * layout.cols + c];
      if (t === TILE_WALL) continue;
      expect(t).toBe(TILE_FLOOR_1);
      // Door tiles are floor but stay unlabeled (editor convention).
      expect(layout.areaTiles?.[wallRow * layout.cols + c] ?? null).toBeNull();
      doorTiles.push(c);
    }
    expect(doorTiles.length).toBeGreaterThanOrEqual(1);
    expect(doorTiles.length).toBeLessThanOrEqual(2);

    // Side + bottom walls fully enclose the interior.
    for (let r = minR; r <= maxR; r++) {
      expect(layout.tiles[r * layout.cols + (minC - 1)]).toBe(TILE_WALL);
      expect(layout.tiles[r * layout.cols + (maxC + 1)]).toBe(TILE_WALL);
    }
    for (let c = minC - 1; c <= maxC + 1; c++) {
      expect(layout.tiles[(maxR + 1) * layout.cols + c]).toBe(TILE_WALL);
    }
  });

  it('seats (chair tiles) sit on labeled floor inside the room', () => {
    const { layout } = ensureCampArea(emptyLayout(24, 24), 'payments', 3, testCatalog());
    const chairs = chairsOf(layout, 'payments');
    expect(chairs).toHaveLength(3);
    for (const chair of chairs) {
      const seatRow = chair.row + 1; // backgroundTiles: 1 → seat on bottom row
      expect(layout.areaTiles?.[seatRow * layout.cols + chair.col]).toBe('payments');
      expect(layout.tiles[seatRow * layout.cols + chair.col]).not.toBe(TILE_WALL);
    }
  });

  it('keeps camps in separate non-overlapping rooms with separation', () => {
    let layout = emptyLayout(48, 30);
    layout = ensureCampArea(layout, 'payments', 3, testCatalog()).layout;
    layout = ensureCampArea(layout, 'search', 3, testCatalog()).layout;

    const payments = new Set(labeledIndices(layout, 'payments'));
    const search = new Set(labeledIndices(layout, 'search'));
    for (const idx of payments) expect(search.has(idx)).toBe(false);
    expect(components(layout, [...payments])).toBe(1);
    expect(components(layout, [...search])).toBe(1);

    // Separation: no labeled tile of one camp is directly adjacent to the other.
    for (const idx of payments) {
      const c = idx % layout.cols;
      const r = Math.floor(idx / layout.cols);
      for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        expect(search.has((r + dr) * layout.cols + (c + dc))).toBe(false);
      }
    }
  });

  it('grows the grid when no interior region fits, keeping the room enclosed', () => {
    const layout = emptyLayout(6, 6);
    const { layout: out, seats } = ensureCampArea(layout, 'payments', 1, testCatalog());
    expect(seats).toBe(1);
    expect(out.rows).toBeGreaterThan(layout.rows);
    expect(analyzeCampRoom(out, 'payments').kind).toBe('valid');
  });

  it('is idempotent for the same seat count', () => {
    const first = ensureCampArea(emptyLayout(24, 24), 'payments', 2, testCatalog());
    const again = ensureCampArea(first.layout, 'payments', 2, testCatalog());
    expect(again.changed).toBe(false);
  });

  it('fills spare capacity in place without moving existing chairs', () => {
    // Room for 1 seat has capacity 2 → the 2nd bindle fills the spare cell.
    const first = ensureCampArea(emptyLayout(24, 24), 'payments', 1, testCatalog());
    const grown = ensureCampArea(first.layout, 'payments', 2, testCatalog());
    expect(grown.seats).toBe(2);
    const before = chairsOf(first.layout, 'payments');
    const after = chairsOf(grown.layout, 'payments');
    expect(after.find((c) => c.uid === before[0].uid)).toMatchObject({
      col: before[0].col,
      row: before[0].row,
    });
    expect(labeledIndices(grown.layout, 'payments')).toEqual(labeledIndices(first.layout, 'payments'));
  });

  it('relocates to a larger single enclosed room when capacity overflows', () => {
    const first = ensureCampArea(emptyLayout(24, 24), 'payments', 2, testCatalog());
    const grown = ensureCampArea(first.layout, 'payments', 4, testCatalog());
    expect(grown.changed).toBe(true);
    expect(grown.seats).toBe(4);

    // Still exactly one contiguous enclosed room, all chairs inside it.
    expect(components(grown.layout, labeledIndices(grown.layout, 'payments'))).toBe(1);
    expect(analyzeCampRoom(grown.layout, 'payments').kind).toBe('valid');
    const chairs = chairsOf(grown.layout, 'payments');
    expect(chairs.map((c) => c.uid).sort()).toEqual([
      'otel-payments-ws0-chair',
      'otel-payments-ws1-chair',
      'otel-payments-ws2-chair',
      'otel-payments-ws3-chair',
    ]);
    for (const chair of chairs) {
      expect(grown.layout.areaTiles?.[(chair.row + 1) * grown.layout.cols + chair.col]).toBe(
        'payments',
      );
    }
    // The old room's wall ring was reverted to floor (no dead walled room left).
    const firstBbox = (() => {
      const idxs = labeledIndices(first.layout, 'payments');
      const rs = idxs.map((i) => Math.floor(i / first.layout.cols));
      return { minR: Math.min(...rs), maxR: Math.max(...rs) };
    })();
    if (!labeledIndices(grown.layout, 'payments').some((i) => Math.floor(i / grown.layout.cols) === firstBbox.minR)) {
      // room moved away entirely: old wall rows must be floor again
      for (let r = firstBbox.minR - 1; r <= firstBbox.maxR + 1; r++) {
        for (let c = 0; c < grown.layout.cols; c++) {
          expect(grown.layout.tiles[r * grown.layout.cols + c]).not.toBe(TILE_WALL);
        }
      }
    }
  });

  it('does not mutate the input layout', () => {
    const layout = emptyLayout(24, 24);
    const snapshot = JSON.stringify(layout);
    ensureCampArea(layout, 'payments', 3, testCatalog());
    expect(JSON.stringify(layout)).toBe(snapshot);
  });
});

describe('ensureCampArea — migration of fragmented/unenclosed rooms', () => {
  /**
   * Mimics the pre-fix persisted layout: the camp's label splattered over two
   * disjoint floor regions, no wall ring, OTel workstations scattered.
   */
  function fragmentedFixture(): OfficeLayoutLike {
    const layout = emptyLayout(21, 34);
    layout.areaTiles = new Array<string | null>(layout.tiles.length).fill(null);
    const paint = (col0: number, row0: number, w: number, h: number) => {
      for (let r = row0; r < row0 + h; r++) {
        for (let c = col0; c < col0 + w; c++) {
          layout.areaTiles![r * layout.cols + c] = 'payments';
        }
      }
    };
    paint(16, 22, 4, 5); // region A (like the bug report's cols 16-19 rows 22-26)
    paint(0, 27, 4, 5); // region B, disjoint
    layout.areas = [{ label: 'payments', color: areaColorForName('payments') }];
    layout.furniture.push(
      { uid: 'otel-payments-ws0-desk', type: 'DESK_FRONT', col: 16, row: 22 },
      { uid: 'otel-payments-ws0-chair', type: 'WOODEN_CHAIR_BACK', col: 17, row: 24 },
      { uid: 'otel-payments-ws1-desk', type: 'DESK_FRONT', col: 0, row: 27 },
      { uid: 'otel-payments-ws1-chair', type: 'WOODEN_CHAIR_BACK', col: 1, row: 29 },
    );
    return layout;
  }

  it('detects fragmentation and unenclosed areas', () => {
    const layout = fragmentedFixture();
    const status = analyzeCampRoom(layout, 'payments');
    expect(status.kind).toBe('fragmented');

    // Single contiguous but wall-less region → unenclosed.
    const flat = emptyLayout(21, 20);
    flat.areaTiles = new Array<string | null>(flat.tiles.length).fill(null);
    for (let r = 5; r < 10; r++) {
      for (let c = 5; c < 10; c++) flat.areaTiles![r * flat.cols + c] = 'payments';
    }
    expect(analyzeCampRoom(flat, 'payments').kind).toBe('unenclosed');
    expect(analyzeCampRoom(flat, 'nonexistent').kind).toBe('absent');
  });

  it('rebuilds a fragmented auto-materialized camp into one enclosed room', () => {
    const fixture = fragmentedFixture();
    const { layout, changed, seats } = ensureCampArea(fixture, 'payments', 2, testCatalog(), {
      migrate: true,
    });
    expect(changed).toBe(true);
    expect(seats).toBe(2); // seat count preserved

    const labeled = labeledIndices(layout, 'payments');
    expect(components(layout, labeled)).toBe(1);
    expect(analyzeCampRoom(layout, 'payments').kind).toBe('valid');

    // Chairs were relocated into the new enclosed room.
    for (const chair of chairsOf(layout, 'payments')) {
      const seatRow = chair.row + 1;
      expect(layout.areaTiles?.[seatRow * layout.cols + chair.col]).toBe('payments');
    }
  });

  it('refuses to migrate without the migrate option', () => {
    const fixture = fragmentedFixture();
    const snapshot = JSON.stringify(fixture);
    const { changed, note } = ensureCampArea(fixture, 'payments', 2, testCatalog());
    expect(changed).toBe(false);
    expect(note).toMatch(/fragmented/);
    expect(JSON.stringify(fixture)).toBe(snapshot);
  });

  it('leaves invalid USER areas (no OTel furniture) untouched', () => {
    const layout = emptyLayout(21, 20);
    layout.areaTiles = new Array<string | null>(layout.tiles.length).fill(null);
    for (let r = 5; r < 10; r++) {
      for (let c = 5; c < 10; c++) layout.areaTiles![r * layout.cols + c] = 'payments';
    }
    layout.areas = [{ label: 'payments', color: areaColorForName('payments') }];
    const { changed, note } = ensureCampArea(layout, 'payments', 2, testCatalog(), {
      migrate: true,
    });
    expect(note).toMatch(/user area/);
    // Labels unchanged (area definition may be re-added, but tiles stay).
    expect(labeledIndices(layout, 'payments').length).toBe(25);
    expect(layout.furniture).toHaveLength(0);
    expect(changed).toBe(false);
  });
});

describe('roomSizeForSeats', () => {
  it('fits the requested seats in a 3-column cell grid', () => {
    expect(roomSizeForSeats(1).capacity).toBe(3);
    expect(roomSizeForSeats(3).capacity).toBe(3);
    expect(roomSizeForSeats(4).capacity).toBe(6);
    expect(roomSizeForSeats(6).capacity).toBe(6);
    expect(roomSizeForSeats(7).capacity).toBe(9);
  });
});
