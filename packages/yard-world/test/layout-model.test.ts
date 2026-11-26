/**
 * Tests for layout-as-data: derivation, sync, application, validation and
 * pathfinding.
 *
 * This module was 26.9% covered while being the thing that decides whether an
 * *untrusted* layout payload is allowed to mutate live topology. `validateLayout`
 * is an admission boundary — an editor PUT arrives as `unknown` and everything
 * downstream trusts what comes back — and almost none of its rules were pinned.
 *
 * The rules are asserted one at a time on purpose. `validateLayout` reports
 * every violation rather than exiting early, so a test that feeds one bad
 * layout and asserts "rejected" would pass no matter which rule fired.
 */
import { describe, expect, it } from "vitest";

import {
	applyLayout,
	deriveLayout,
	findPath,
	insideRect,
	isContiguous,
	MAX_GRID,
	MIN_ROOM_H,
	MIN_ROOM_W,
	rectsOverlap,
	stationCampIds,
	syncLayout,
	validateLayout,
	type WorldLayout,
} from "../src/layout-model.js";
import type { WorldState } from "../src/model.js";

function world(): WorldState {
	return {
		tick: 0,
		stations: { st1: { id: "st1", name: "Station One" } },
		layouts: {},
		yards: {
			y1: { id: "y1", stationId: "st1", name: "Yard One" },
			y2: { id: "y2", stationId: "st1", name: "Yard Two" },
			yOther: { id: "yOther", stationId: "st2", name: "Elsewhere" },
		},
		camps: {
			c1: {
				id: "c1",
				yardId: "y1",
				name: "Camp One",
				rect: { x: 2, y: 2, w: 6, h: 5 },
			},
			c2: {
				id: "c2",
				yardId: "y2",
				name: "Camp Two",
				rect: { x: 12, y: 2, w: 6, h: 5 },
			},
			cOther: {
				id: "cOther",
				yardId: "yOther",
				name: "Other",
				rect: { x: 0, y: 0, w: 4, h: 4 },
			},
		},
		junctions: {
			j1: {
				id: "j1",
				name: "One to Two",
				fromCampId: "c1",
				toCampId: "c2",
				corridor: [
					{ x: 8, y: 4 },
					{ x: 9, y: 4 },
					{ x: 10, y: 4 },
					{ x: 11, y: 4 },
				],
			},
			jOther: {
				id: "jOther",
				name: "Unrelated",
				fromCampId: "cOther",
				toCampId: "cOther",
				corridor: [{ x: 0, y: 0 }],
			},
		},
		characters: {
			ch1: {
				id: "ch1",
				name: "Alice",
				kind: "service",
				stationId: "st1",
				campId: "c1",
				desk: { x: 3, y: 3 },
				position: { x: 3, y: 3 },
				state: "idle",
				stateSince: 0,
				health: 1,
			},
			chOther: {
				id: "chOther",
				name: "Bob",
				kind: "service",
				stationId: "st2",
				campId: "cOther",
				desk: { x: 1, y: 1 },
				position: { x: 1, y: 1 },
				state: "idle",
				stateSince: 0,
				health: 1,
			},
		},
		packets: {},
	} as unknown as WorldState;
}

function validLayout(state: WorldState): WorldLayout {
	return deriveLayout(state, "st1");
}

describe("geometry helpers", () => {
	it("rectsOverlap is false for rectangles that merely touch", () => {
		const a = { x: 0, y: 0, w: 4, h: 4 };
		expect(rectsOverlap(a, { x: 4, y: 0, w: 4, h: 4 })).toBe(false);
		expect(rectsOverlap(a, { x: 0, y: 4, w: 4, h: 4 })).toBe(false);
		expect(rectsOverlap(a, { x: 3, y: 3, w: 4, h: 4 })).toBe(true);
		expect(rectsOverlap(a, a)).toBe(true);
	});

	it("insideRect excludes the far edge and includes the near one", () => {
		const r = { x: 2, y: 2, w: 3, h: 3 };
		expect(insideRect({ x: 2, y: 2 }, r)).toBe(true);
		expect(insideRect({ x: 4, y: 4 }, r)).toBe(true);
		expect(insideRect({ x: 5, y: 4 }, r)).toBe(false);
		expect(insideRect({ x: 1, y: 2 }, r)).toBe(false);
	});

	it("isContiguous requires 4-connected steps", () => {
		expect(isContiguous([])).toBe(true);
		expect(isContiguous([{ x: 0, y: 0 }])).toBe(true);
		expect(
			isContiguous([
				{ x: 0, y: 0 },
				{ x: 1, y: 0 },
				{ x: 1, y: 1 },
			]),
		).toBe(true);
		// Diagonal: manhattan distance 2.
		expect(
			isContiguous([
				{ x: 0, y: 0 },
				{ x: 1, y: 1 },
			]),
		).toBe(false);
		// Repeated tile: distance 0.
		expect(
			isContiguous([
				{ x: 0, y: 0 },
				{ x: 0, y: 0 },
			]),
		).toBe(false);
		// Jump.
		expect(
			isContiguous([
				{ x: 0, y: 0 },
				{ x: 3, y: 0 },
			]),
		).toBe(false);
	});
});

describe("stationCampIds", () => {
	it("returns only camps whose yard belongs to the station", () => {
		expect(stationCampIds(world(), "st1").sort()).toEqual(["c1", "c2"]);
		expect(stationCampIds(world(), "st2")).toEqual(["cOther"]);
		expect(stationCampIds(world(), "nope")).toEqual([]);
	});
});

describe("deriveLayout", () => {
	it("is deterministic for the same topology", () => {
		const state = world();
		expect(deriveLayout(state, "st1")).toEqual(deriveLayout(state, "st1"));
	});

	it("includes only this station's camps, desks and junctions", () => {
		const layout = deriveLayout(world(), "st1");
		expect(Object.keys(layout.rooms).sort()).toEqual(["c1", "c2"]);
		expect(Object.keys(layout.desks)).toEqual(["ch1"]);
		expect(Object.keys(layout.corridors)).toEqual(["j1"]);
	});

	it("sizes the grid to content plus a margin", () => {
		const layout = deriveLayout(world(), "st1");
		// Widest camp ends at x=18, so w = 18 + 10. The tallest ends at y=7,
		// which is below the built-in floor of 8, so h = 8 + 8 rather than 7 + 8.
		expect(layout.grid).toEqual({ w: 28, h: 16 });
	});

	it("keeps a minimum grid when the station is empty", () => {
		const layout = deriveLayout(world(), "empty");
		expect(layout.grid).toEqual({ w: 18, h: 16 });
		expect(layout.rooms).toEqual({});
	});

	it("gives camps in different yards different accent colors", () => {
		const layout = deriveLayout(world(), "st1");
		expect(layout.rooms.c1?.color).not.toBe(layout.rooms.c2?.color);
	});

	it("copies rects rather than aliasing live topology", () => {
		const state = world();
		const layout = deriveLayout(state, "st1");
		const room = layout.rooms.c1;
		if (room === undefined) throw new Error("expected room");
		room.rect.x = 99;
		expect(state.camps.c1?.rect.x).toBe(2);
	});
});

describe("syncLayout", () => {
	it("derives and stores a layout when none exists", () => {
		const state = world();
		const layout = syncLayout(state, "st1");
		expect(state.layouts.st1).toBe(layout);
	});

	it("preserves existing edits and only fills in what is new", () => {
		const state = world();
		const first = syncLayout(state, "st1");
		const room = first.rooms.c1;
		if (room === undefined) throw new Error("expected room");
		room.color = "#000000";
		room.rect = { x: 1, y: 1, w: 4, h: 4 };

		// New topology arrives after the first sync.
		state.camps.c3 = {
			id: "c3",
			yardId: "y1",
			name: "Camp Three",
			rect: { x: 30, y: 20, w: 5, h: 4 },
		};
		const second = syncLayout(state, "st1");

		expect(second.rooms.c1?.color).toBe("#000000");
		expect(second.rooms.c1?.rect).toEqual({ x: 1, y: 1, w: 4, h: 4 });
		expect(second.rooms.c3).toBeDefined();
		// The grid grows to contain the newcomer.
		expect(second.grid.w).toBeGreaterThanOrEqual(45);
		expect(second.grid.h).toBeGreaterThanOrEqual(32);
	});

	it("adds desks and corridors for newly-materialized entities", () => {
		const state = world();
		syncLayout(state, "st1");
		state.characters.ch2 = {
			...(state.characters.ch1 as (typeof state.characters)["ch1"]),
			id: "ch2",
			desk: { x: 13, y: 3 },
		};
		state.junctions.j2 = {
			id: "j2",
			name: "Two to One",
			fromCampId: "c2",
			toCampId: "c1",
			corridor: [{ x: 9, y: 5 }],
		};
		const synced = syncLayout(state, "st1");
		expect(synced.desks.ch2).toEqual({ x: 13, y: 3 });
		expect(synced.corridors.j2).toEqual([{ x: 9, y: 5 }]);
	});
});

describe("applyLayout", () => {
	it("writes rects, desks and corridors back into live state", () => {
		const state = world();
		const layout = validLayout(state);
		const room = layout.rooms.c1;
		if (room === undefined) throw new Error("expected room");
		room.rect = { x: 20, y: 20, w: 4, h: 4 };
		layout.desks.ch1 = { x: 21, y: 21 };
		layout.corridors.j1 = [{ x: 1, y: 1 }];

		applyLayout(state, "st1", layout);

		expect(state.camps.c1?.rect).toEqual({ x: 20, y: 20, w: 4, h: 4 });
		expect(state.characters.ch1?.desk).toEqual({ x: 21, y: 21 });
		// The character snaps to the new desk and any in-flight path is dropped.
		expect(state.characters.ch1?.position).toEqual({ x: 21, y: 21 });
		expect(state.characters.ch1?.path).toEqual([]);
		expect(state.junctions.j1?.corridor).toEqual([{ x: 1, y: 1 }]);
	});

	it("ignores entries for entities that no longer exist", () => {
		const state = world();
		const layout = validLayout(state);
		layout.rooms.ghost = { rect: { x: 0, y: 0, w: 3, h: 3 }, color: "#fff" };
		layout.desks.ghost = { x: 0, y: 0 };
		layout.corridors.ghost = [{ x: 0, y: 0 }];
		expect(() => applyLayout(state, "st1", layout)).not.toThrow();
		expect(state.camps.ghost).toBeUndefined();
	});

	it("stores a clone, so later edits to the argument do not leak into state", () => {
		const state = world();
		const layout = validLayout(state);
		applyLayout(state, "st1", layout);
		const stored = state.layouts.st1;
		layout.grid.w = 999;
		expect(stored?.grid.w).not.toBe(999);
	});
});

describe("validateLayout", () => {
	const reasonsFor = (mutate: (layout: WorldLayout) => unknown) => {
		const state = world();
		const layout = validLayout(state);
		const candidate = mutate(layout) ?? layout;
		return validateLayout(candidate, state, "st1").reasons;
	};

	it("accepts a derived layout unchanged", () => {
		const state = world();
		const result = validateLayout(validLayout(state), state, "st1");
		expect(result.reasons).toEqual([]);
		expect(result.layout).toBeDefined();
	});

	it.each([
		null,
		42,
		"layout",
		undefined,
		[],
	] as const)("rejects a non-object payload (%p)", (raw) => {
		const state = world();
		const result = validateLayout(raw, state, "st1");
		expect(result.layout).toBeUndefined();
		expect(result.reasons.length).toBeGreaterThan(0);
	});

	it("requires version 1", () => {
		expect(reasonsFor((l) => ({ ...l, version: 2 }))).toContain(
			"version must be 1",
		);
	});

	it("rejects a grid outside the allowed range", () => {
		for (const grid of [
			{ w: 7, h: 20 },
			{ w: 20, h: 7 },
			{ w: MAX_GRID + 1, h: 20 },
			{ w: 20, h: MAX_GRID + 1 },
			{ w: 20.5, h: 20 },
		]) {
			const reasons = reasonsFor((l) => ({ ...l, grid }));
			expect(
				reasons.some((r) => r.startsWith("grid must be")),
				String(grid.w),
			).toBe(true);
		}
	});

	it("reports a missing room for a camp that exists", () => {
		expect(
			reasonsFor((l) => {
				delete l.rooms.c2;
			}),
		).toContain("missing room for camp c2");
	});

	it("reports a room for a camp that does not exist", () => {
		expect(
			reasonsFor((l) => {
				l.rooms.ghost = { rect: { x: 0, y: 0, w: 4, h: 4 }, color: "#fff" };
			}),
		).toContain("room for unknown camp ghost");
	});

	it("rejects a room smaller than the minimum", () => {
		const reasons = reasonsFor((l) => {
			const room = l.rooms.c1;
			if (room !== undefined)
				room.rect = { x: 2, y: 2, w: MIN_ROOM_W - 1, h: MIN_ROOM_H };
		});
		expect(reasons.some((r) => r.includes("smaller than"))).toBe(true);
	});

	it("rejects overlapping rooms", () => {
		const reasons = reasonsFor((l) => {
			const a = l.rooms.c1;
			const b = l.rooms.c2;
			if (a !== undefined && b !== undefined) b.rect = { ...a.rect };
		});
		expect(reasons.some((r) => r.toLowerCase().includes("overlap"))).toBe(true);
	});

	it("rejects a malformed rect", () => {
		const reasons = reasonsFor((l) => {
			const room = l.rooms.c1;
			if (room !== undefined)
				(room as { rect: unknown }).rect = { x: "a", y: 2, w: 4, h: 4 };
		});
		expect(reasons.some((r) => r.includes("integer x/y/w/h"))).toBe(true);
	});

	it("collects every violation instead of stopping at the first", () => {
		const reasons = reasonsFor((l) => ({
			...l,
			version: 99,
			grid: { w: 2, h: 2 },
		}));
		expect(reasons.length).toBeGreaterThan(1);
	});
});

describe("findPath", () => {
	const grid = { w: 10, h: 10 };

	it("finds a straight path when nothing blocks", () => {
		const path = findPath(grid, [], { x: 0, y: 0 }, { x: 3, y: 0 });
		expect(path).toEqual([
			{ x: 0, y: 0 },
			{ x: 1, y: 0 },
			{ x: 2, y: 0 },
			{ x: 3, y: 0 },
		]);
	});

	it("returns a single tile when start equals goal", () => {
		expect(findPath(grid, [], { x: 4, y: 4 }, { x: 4, y: 4 })).toEqual([
			{ x: 4, y: 4 },
		]);
	});

	it("routes around a blocked rect", () => {
		const blocked = [{ x: 1, y: 0, w: 1, h: 9 }];
		const path = findPath(grid, blocked, { x: 0, y: 0 }, { x: 2, y: 0 });
		expect(path).toBeDefined();
		// Every intermediate tile avoids the wall.
		for (const tile of (path ?? []).slice(1, -1))
			expect(tile.x === 1 && tile.y < 9).toBe(false);
	});

	it("returns undefined when the goal is walled off", () => {
		const blocked = [{ x: 1, y: 0, w: 1, h: 10 }];
		expect(
			findPath(grid, blocked, { x: 0, y: 0 }, { x: 5, y: 5 }),
		).toBeUndefined();
	});

	it("returns undefined when the goal is outside the grid", () => {
		expect(findPath(grid, [], { x: 0, y: 0 }, { x: 99, y: 0 })).toBeUndefined();
	});

	it("reaches a goal that sits inside a blocked rect", () => {
		// The goal tile is always walkable — a corridor may end at a room door.
		const blocked = [{ x: 5, y: 5, w: 3, h: 3 }];
		const path = findPath(grid, blocked, { x: 0, y: 0 }, { x: 5, y: 5 });
		expect(path?.at(-1)).toEqual({ x: 5, y: 5 });
	});

	it("produces a contiguous path", () => {
		const blocked = [{ x: 3, y: 0, w: 1, h: 7 }];
		const path = findPath(grid, blocked, { x: 0, y: 0 }, { x: 8, y: 8 });
		expect(path).toBeDefined();
		expect(isContiguous(path ?? [])).toBe(true);
	});
});
