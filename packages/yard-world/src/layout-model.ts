/**
 * Layout-as-data for the yard world.
 *
 * The spatial arrangement of a station's floor — grid size, camp room rects +
 * colors, character desks, junction corridor paths — is a serializable
 * `WorldLayout`, stored on `WorldState.layouts[stationId]`. The simulator and
 * the OTLP auto-materialization derive a default layout from topology; the
 * hosting service may replace it wholesale (e.g. an editor PUT); `validateLayout`
 * checks an untrusted replacement (rooms non-overlapping, desks inside their
 * room, corridors walkable). Persistence lives in the node-only
 * `layout-store.ts` entry — this module is pure.
 */
import type { TilePoint, TileRect, WorldState } from "./model.js";

export interface LayoutRoom {
	rect: TileRect;
	/** Accent color (room border + name tag). */
	color: string;
}

export interface WorldLayout {
	version: 1;
	/** Tile grid extents for the station's floor. */
	grid: { w: number; h: number };
	/** campId → room. */
	rooms: Record<string, LayoutRoom>;
	/** characterId → desk tile. */
	desks: Record<string, TilePoint>;
	/** junctionId → corridor path (contiguous, walkable tiles). */
	corridors: Record<string, TilePoint[]>;
}

/** Room accent palette, assigned per-yard so a floor reads as one zone. */
const ROOM_PALETTE = [
	"#7c4dff",
	"#00acc1",
	"#43a047",
	"#fb8c00",
	"#e53935",
	"#8e24aa",
];

export const MIN_ROOM_W = 3;
export const MIN_ROOM_H = 3;
export const MAX_GRID = 512;

export function rectsOverlap(a: TileRect, b: TileRect): boolean {
	return (
		a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
	);
}

export function insideRect(p: TilePoint, r: TileRect): boolean {
	return p.x >= r.x && p.x < r.x + r.w && p.y >= r.y && p.y < r.y + r.h;
}

/** Camp ids that belong to a station (camps hang off yards, yards off stations). */
export function stationCampIds(state: WorldState, stationId: string): string[] {
	const yardIds = new Set(
		Object.values(state.yards)
			.filter((y) => y.stationId === stationId)
			.map((y) => y.id),
	);
	return Object.values(state.camps)
		.filter((c) => yardIds.has(c.yardId))
		.map((c) => c.id);
}

function stationJunctionIds(state: WorldState, campIds: Set<string>): string[] {
	return Object.values(state.junctions)
		.filter((j) => campIds.has(j.fromCampId) && campIds.has(j.toCampId))
		.map((j) => j.id);
}

/**
 * Derive the default layout for a station from current topology: rooms from
 * camp rects, desks from characters, corridors from junctions, grid sized to
 * content plus a margin. Deterministic — same topology, same layout.
 */
export function deriveLayout(
	state: WorldState,
	stationId: string,
): WorldLayout {
	const campIds = stationCampIds(state, stationId);
	const yardOrder = Object.values(state.yards)
		.filter((y) => y.stationId === stationId)
		.map((y) => y.id);
	const rooms: Record<string, LayoutRoom> = {};
	let maxX = 8;
	let maxY = 8;
	for (const campId of campIds) {
		const camp = state.camps[campId];
		if (camp === undefined) continue;
		const colorIdx = Math.max(0, yardOrder.indexOf(camp.yardId));
		rooms[campId] = {
			rect: { ...camp.rect },
			color: ROOM_PALETTE[colorIdx % ROOM_PALETTE.length] ?? "#7c4dff",
		};
		maxX = Math.max(maxX, camp.rect.x + camp.rect.w);
		maxY = Math.max(maxY, camp.rect.y + camp.rect.h);
	}
	const desks: Record<string, TilePoint> = {};
	for (const ch of Object.values(state.characters)) {
		if (ch.stationId !== stationId) continue;
		desks[ch.id] = { ...ch.desk };
	}
	const corridors: Record<string, TilePoint[]> = {};
	for (const jnId of stationJunctionIds(state, new Set(campIds))) {
		const jn = state.junctions[jnId];
		if (jn !== undefined) corridors[jnId] = jn.corridor.map((t) => ({ ...t }));
	}
	return {
		version: 1,
		grid: { w: maxX + 10, h: maxY + 8 },
		rooms,
		desks,
		corridors,
	};
}

/**
 * Keep a station's layout in sync as OTLP auto-materialization adds topology:
 * derive when absent, otherwise fill in entries for new camps/characters/
 * junctions (existing edits are preserved).
 */
export function syncLayout(state: WorldState, stationId: string): WorldLayout {
	const existing = state.layouts[stationId];
	if (existing === undefined) {
		const derived = deriveLayout(state, stationId);
		state.layouts[stationId] = derived;
		return derived;
	}
	const campIds = stationCampIds(state, stationId);
	const yardOrder = Object.values(state.yards)
		.filter((y) => y.stationId === stationId)
		.map((y) => y.id);
	for (const campId of campIds) {
		const camp = state.camps[campId];
		if (camp === undefined || existing.rooms[campId] !== undefined) continue;
		const colorIdx = Math.max(0, yardOrder.indexOf(camp.yardId));
		existing.rooms[campId] = {
			rect: { ...camp.rect },
			color: ROOM_PALETTE[colorIdx % ROOM_PALETTE.length] ?? "#7c4dff",
		};
		existing.grid.w = Math.max(existing.grid.w, camp.rect.x + camp.rect.w + 10);
		existing.grid.h = Math.max(existing.grid.h, camp.rect.y + camp.rect.h + 8);
	}
	for (const ch of Object.values(state.characters)) {
		if (ch.stationId === stationId && existing.desks[ch.id] === undefined) {
			existing.desks[ch.id] = { ...ch.desk };
		}
	}
	for (const jnId of stationJunctionIds(state, new Set(campIds))) {
		const jn = state.junctions[jnId];
		if (jn !== undefined && existing.corridors[jnId] === undefined) {
			existing.corridors[jnId] = jn.corridor.map((t) => ({ ...t }));
		}
	}
	return existing;
}

/**
 * Apply a validated layout to the live state: camp rects, character desks
 * (positions snap to the new desk), junction corridors. Mutates `state`.
 */
export function applyLayout(
	state: WorldState,
	stationId: string,
	layout: WorldLayout,
): void {
	for (const [campId, room] of Object.entries(layout.rooms)) {
		const camp = state.camps[campId];
		if (camp !== undefined) camp.rect = { ...room.rect };
	}
	for (const [charId, desk] of Object.entries(layout.desks)) {
		const ch = state.characters[charId];
		if (ch !== undefined) {
			ch.desk = { ...desk };
			ch.position = { ...desk };
			ch.path = [];
		}
	}
	for (const [jnId, corridor] of Object.entries(layout.corridors)) {
		const jn = state.junctions[jnId];
		if (jn !== undefined) jn.corridor = corridor.map((t) => ({ ...t }));
	}
	state.layouts[stationId] = structuredClone(layout);
}

function isInt(n: unknown): n is number {
	return typeof n === "number" && Number.isInteger(n);
}

function isPoint(p: unknown): p is TilePoint {
	return (
		typeof p === "object" &&
		p !== null &&
		isInt((p as TilePoint).x) &&
		isInt((p as TilePoint).y)
	);
}

function isRect(r: unknown): r is TileRect {
	return (
		typeof r === "object" &&
		r !== null &&
		isInt((r as TileRect).x) &&
		isInt((r as TileRect).y) &&
		isInt((r as TileRect).w) &&
		isInt((r as TileRect).h)
	);
}

/** Consecutive tiles are 4-connected. */
export function isContiguous(path: TilePoint[]): boolean {
	for (let i = 1; i < path.length; i += 1) {
		const a = path[i - 1];
		const b = path[i];
		if (a === undefined || b === undefined) return false;
		if (Math.abs(a.x - b.x) + Math.abs(a.y - b.y) !== 1) return false;
	}
	return true;
}

export interface LayoutValidation {
	layout: WorldLayout | undefined;
	reasons: string[];
}

/**
 * Structural + semantic validation of an untrusted layout payload against the
 * live topology of one station. Every rule violation is reported (no early
 * exit) so the editor can show all problems at once.
 */
export function validateLayout(
	raw: unknown,
	state: WorldState,
	stationId: string,
): LayoutValidation {
	const reasons: string[] = [];
	if (typeof raw !== "object" || raw === null) {
		return { layout: undefined, reasons: ["layout must be a JSON object"] };
	}
	const candidate = raw as Partial<WorldLayout>;
	if (candidate.version !== 1) reasons.push("version must be 1");
	const grid = candidate.grid;
	if (
		typeof grid !== "object" ||
		grid === null ||
		!isInt(grid.w) ||
		!isInt(grid.h) ||
		grid.w < 8 ||
		grid.h < 8 ||
		grid.w > MAX_GRID ||
		grid.h > MAX_GRID
	) {
		reasons.push(`grid must be integer w/h within 8..${MAX_GRID}`);
	}
	if (typeof candidate.rooms !== "object" || candidate.rooms === null) {
		reasons.push("rooms must be an object keyed by campId");
	}
	if (typeof candidate.desks !== "object" || candidate.desks === null) {
		reasons.push("desks must be an object keyed by characterId");
	}
	if (typeof candidate.corridors !== "object" || candidate.corridors === null) {
		reasons.push("corridors must be an object keyed by junctionId");
	}
	if (reasons.length > 0 || grid === undefined || grid === null) {
		return { layout: undefined, reasons };
	}
	const rooms = candidate.rooms as Record<string, LayoutRoom>;
	const desks = candidate.desks as Record<string, TilePoint>;
	const corridors = candidate.corridors as Record<string, TilePoint[]>;

	const campIds = stationCampIds(state, stationId);
	const campSet = new Set(campIds);
	const characters = Object.values(state.characters).filter(
		(c) => c.stationId === stationId,
	);
	const junctionIds = new Set(stationJunctionIds(state, campSet));

	// Rooms: complete, well-formed, inside grid, pairwise non-overlapping.
	for (const campId of campIds) {
		if (rooms[campId] === undefined)
			reasons.push(`missing room for camp ${campId}`);
	}
	for (const [campId, room] of Object.entries(rooms)) {
		if (!campSet.has(campId)) {
			reasons.push(`room for unknown camp ${campId}`);
			continue;
		}
		if (!isRect(room?.rect)) {
			reasons.push(`room ${campId}: rect must be integer x/y/w/h`);
			continue;
		}
		if (room.rect.w < MIN_ROOM_W || room.rect.h < MIN_ROOM_H) {
			reasons.push(`room ${campId}: smaller than ${MIN_ROOM_W}x${MIN_ROOM_H}`);
		}
		if (
			room.rect.x < 0 ||
			room.rect.y < 0 ||
			room.rect.x + room.rect.w > grid.w ||
			room.rect.y + room.rect.h > grid.h
		) {
			reasons.push(`room ${campId}: outside the grid`);
		}
		if (typeof room.color !== "string" || room.color.length === 0) {
			reasons.push(`room ${campId}: color must be a non-empty string`);
		}
	}
	const roomEntries = Object.entries(rooms).filter(
		([id, room]) => campSet.has(id) && isRect(room?.rect),
	);
	for (let i = 0; i < roomEntries.length; i += 1) {
		for (let j = i + 1; j < roomEntries.length; j += 1) {
			const a = roomEntries[i];
			const b = roomEntries[j];
			if (
				a !== undefined &&
				b !== undefined &&
				rectsOverlap(a[1].rect, b[1].rect)
			) {
				reasons.push(`rooms overlap: ${a[0]} and ${b[0]}`);
			}
		}
	}

	// Desks: complete, well-formed, inside their character's camp room, unique.
	for (const ch of characters) {
		if (desks[ch.id] === undefined)
			reasons.push(`missing desk for character ${ch.id}`);
	}
	const seenDesks = new Map<string, string>();
	for (const [charId, desk] of Object.entries(desks)) {
		const ch = state.characters[charId];
		if (ch === undefined || ch.stationId !== stationId) {
			reasons.push(`desk for unknown character ${charId}`);
			continue;
		}
		if (!isPoint(desk)) {
			reasons.push(`desk ${charId}: must be integer x/y`);
			continue;
		}
		const room = rooms[ch.campId];
		if (
			room !== undefined &&
			isRect(room.rect) &&
			!insideRect(desk, room.rect)
		) {
			reasons.push(`desk ${charId}: outside room ${ch.campId}`);
		}
		const key = `${desk.x},${desk.y}`;
		const other = seenDesks.get(key);
		if (other !== undefined)
			reasons.push(`desks coincide: ${other} and ${charId}`);
		seenDesks.set(key, charId);
	}

	// Corridors: complete, non-empty, in-grid, contiguous, and walkable (no
	// tile inside any room of the station).
	for (const jnId of junctionIds) {
		if (corridors[jnId] === undefined)
			reasons.push(`missing corridor for junction ${jnId}`);
	}
	for (const [jnId, corridor] of Object.entries(corridors)) {
		if (!junctionIds.has(jnId)) {
			reasons.push(`corridor for unknown junction ${jnId}`);
			continue;
		}
		if (
			!Array.isArray(corridor) ||
			corridor.length === 0 ||
			!corridor.every(isPoint)
		) {
			reasons.push(
				`corridor ${jnId}: must be a non-empty array of integer tiles`,
			);
			continue;
		}
		if (!isContiguous(corridor)) {
			reasons.push(`corridor ${jnId}: tiles are not contiguous`);
		}
		for (const tile of corridor) {
			if (tile.x < 0 || tile.y < 0 || tile.x >= grid.w || tile.y >= grid.h) {
				reasons.push(
					`corridor ${jnId}: tile ${tile.x},${tile.y} outside the grid`,
				);
				break;
			}
		}
		for (const tile of corridor) {
			const blocking = roomEntries.find(([, room]) =>
				insideRect(tile, room.rect),
			);
			if (blocking !== undefined) {
				reasons.push(
					`corridor ${jnId}: tile ${tile.x},${tile.y} inside room ${blocking[0]}`,
				);
				break;
			}
		}
	}

	if (reasons.length > 0) return { layout: undefined, reasons };
	return {
		layout: {
			version: 1,
			grid: { w: grid.w, h: grid.h },
			rooms: structuredClone(rooms),
			desks: structuredClone(desks),
			corridors: structuredClone(corridors),
		},
		reasons: [],
	};
}

/**
 * Breadth-first path between two tiles through free tiles (in-grid, not inside
 * a blocked rect). Used by the editor to reroute junction corridors. Returns
 * the path including both endpoints, or undefined when unreachable.
 */
export function findPath(
	grid: { w: number; h: number },
	blocked: TileRect[],
	start: TilePoint,
	goal: TilePoint,
): TilePoint[] | undefined {
	const key = (x: number, y: number) => `${x},${y}`;
	const free = (x: number, y: number): boolean => {
		if (x < 0 || y < 0 || x >= grid.w || y >= grid.h) return false;
		if (x === goal.x && y === goal.y) return true;
		return !blocked.some(
			(r) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h,
		);
	};
	const prev = new Map<string, string>();
	const queue: TilePoint[] = [start];
	const seenSet = new Set([key(start.x, start.y)]);
	while (queue.length > 0) {
		const cur = queue.shift();
		if (cur === undefined) break;
		if (cur.x === goal.x && cur.y === goal.y) {
			const path: TilePoint[] = [{ ...cur }];
			let k = key(cur.x, cur.y);
			while (prev.has(k)) {
				const p = prev.get(k) ?? "";
				const [px, py] = p.split(",").map(Number);
				path.push({ x: px ?? 0, y: py ?? 0 });
				k = p;
			}
			return path.reverse();
		}
		for (const [dx, dy] of [
			[1, 0],
			[-1, 0],
			[0, 1],
			[0, -1],
		] as const) {
			const nx = cur.x + dx;
			const ny = cur.y + dy;
			const nk = key(nx, ny);
			if (seenSet.has(nk) || !free(nx, ny)) continue;
			seenSet.add(nk);
			prev.set(nk, key(cur.x, cur.y));
			queue.push({ x: nx, y: ny });
		}
	}
	return undefined;
}
