/**
 * Layout-as-data for the OTel office (Phase 2 slice 3).
 *
 * The spatial arrangement of a station's office — grid size, camp room rects +
 * colors, character desks, junction corridor paths — is a serializable
 * `OfficeLayout`, stored on `OfficeState.layouts[stationId]`. The simulator and
 * the OTLP auto-materialization derive a default layout from topology; the
 * client editor replaces it wholesale via PUT /layout/<stationId>; the server
 * validates (rooms non-overlapping, desks inside their room, corridors
 * walkable) and persists it per station as JSON.
 */
import type { OfficeState, TilePoint, TileRect } from "./model.js";
import {
	isJsonString,
	isJsonNumber,
	isJsonObject,
	type JsonObject,
	type JsonValue,
} from "./json.js";


export interface LayoutRoom {
	rect: TileRect;
	/** Accent color (room border + name tag). */
	color: string;
}

export interface OfficeLayout {
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
const ROOM_PALETTE = ["#7c4dff", "#00acc1", "#43a047", "#fb8c00", "#e53935", "#8e24aa"];

export const MIN_ROOM_W = 3;
export const MIN_ROOM_H = 3;
export const MAX_GRID = 512;

export function rectsOverlap(a: TileRect, b: TileRect): boolean {
	return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

export function insideRect(p: TilePoint, r: TileRect): boolean {
	return p.x >= r.x && p.x < r.x + r.w && p.y >= r.y && p.y < r.y + r.h;
}

/** Camp ids that belong to a station (camps hang off yards, yards off stations). */
export function stationCampIds(state: OfficeState, stationId: string): string[] {
	const yardIds = new Set(
		Object.values(state.yards)
			.filter((y) => y.stationId === stationId)
			.map((y) => y.id),
	);
	return Object.values(state.camps)
		.filter((c) => yardIds.has(c.yardId))
		.map((c) => c.id);
}

function stationJunctionIds(state: OfficeState, campIds: Set<string>): string[] {
	return Object.values(state.junctions)
		.filter((j) => campIds.has(j.fromCampId) && campIds.has(j.toCampId))
		.map((j) => j.id);
}

/**
 * Derive the default layout for a station from current topology: rooms from
 * camp rects, desks from characters, corridors from junctions, grid sized to
 * content plus a margin. Deterministic — same topology, same layout.
 */
export function deriveLayout(state: OfficeState, stationId: string): OfficeLayout {
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
export function syncLayout(state: OfficeState, stationId: string): OfficeLayout {
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
export function applyLayout(state: OfficeState, stationId: string, layout: OfficeLayout): void {
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

function intField(obj: JsonObject, key: string): number | undefined {
	const value: JsonValue | undefined = obj[key];
	return value !== undefined && isJsonNumber(value) && Number.isInteger(value)
		? value
		: undefined;
}

function parsePoint(p: JsonValue): TilePoint | undefined {
	if (!isJsonObject(p)) return undefined;
	const x = intField(p, "x");
	const y = intField(p, "y");
	return x === undefined || y === undefined ? undefined : { x, y };
}

function parseRect(r: JsonValue): TileRect | undefined {
	if (!isJsonObject(r)) return undefined;
	const x = intField(r, "x");
	const y = intField(r, "y");
	const w = intField(r, "w");
	const h = intField(r, "h");
	return x === undefined || y === undefined || w === undefined || h === undefined
		? undefined
		: { x, y, w, h };
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
	layout: OfficeLayout | undefined;
	reasons: string[];
}

/**
 * Structural + semantic validation of an untrusted layout payload against the
 * live topology of one station. Every rule violation is reported (no early
 * exit) so the editor can show all problems at once.
 */
export function validateLayout(
	raw: JsonValue,
	state: OfficeState,
	stationId: string,
): LayoutValidation {
	const reasons: string[] = [];
	if (!isJsonObject(raw)) {
		return { layout: undefined, reasons: ["layout must be a JSON object"] };
	}
	if (raw["version"] !== 1) reasons.push("version must be 1");
	const gridRaw: JsonValue | undefined = raw["grid"];
	const gridW =
		gridRaw !== undefined && isJsonObject(gridRaw) ? intField(gridRaw, "w") : undefined;
	const gridH =
		gridRaw !== undefined && isJsonObject(gridRaw) ? intField(gridRaw, "h") : undefined;
	const grid =
		gridW !== undefined && gridH !== undefined ? { w: gridW, h: gridH } : undefined;
	if (
		grid === undefined ||
		grid.w < 8 ||
		grid.h < 8 ||
		grid.w > MAX_GRID ||
		grid.h > MAX_GRID
	) {
		reasons.push(`grid must be integer w/h within 8..${MAX_GRID}`);
	}
	const roomsRaw: JsonValue | undefined = raw["rooms"];
	const desksRaw: JsonValue | undefined = raw["desks"];
	const corridorsRaw: JsonValue | undefined = raw["corridors"];
	if (roomsRaw === undefined || !isJsonObject(roomsRaw)) {
		reasons.push("rooms must be an object keyed by campId");
	}
	if (desksRaw === undefined || !isJsonObject(desksRaw)) {
		reasons.push("desks must be an object keyed by characterId");
	}
	if (corridorsRaw === undefined || !isJsonObject(corridorsRaw)) {
		reasons.push("corridors must be an object keyed by junctionId");
	}
	if (
		reasons.length > 0 ||
		grid === undefined ||
		roomsRaw === undefined ||
		!isJsonObject(roomsRaw) ||
		desksRaw === undefined ||
		!isJsonObject(desksRaw) ||
		corridorsRaw === undefined ||
		!isJsonObject(corridorsRaw)
	) {
		return { layout: undefined, reasons };
	}
	// Parse (never cast) each entry into fresh domain values. Entries that
	// fail to parse keep contributing every applicable reason below; they are
	// simply absent from the parsed records used for cross-checks.
	const rooms: Record<string, LayoutRoom> = {};
	for (const [campId, roomRaw] of Object.entries(roomsRaw)) {
		if (!isJsonObject(roomRaw)) continue;
		const rectRaw: JsonValue | undefined = roomRaw["rect"];
		const colorRaw: JsonValue | undefined = roomRaw["color"];
		const rect = rectRaw === undefined ? undefined : parseRect(rectRaw);
		if (rect === undefined) continue;
		rooms[campId] = {
			rect,
			color: colorRaw !== undefined && isJsonString(colorRaw) ? colorRaw : "",
		};
	}
	const desks: Record<string, TilePoint> = {};
	for (const [charId, deskRaw] of Object.entries(desksRaw)) {
		const desk = parsePoint(deskRaw);
		if (desk !== undefined) desks[charId] = desk;
	}
	const corridors: Record<string, TilePoint[]> = {};
	for (const [jnId, corridorRaw] of Object.entries(corridorsRaw)) {
		if (!Array.isArray(corridorRaw)) continue;
		const tiles = corridorRaw.map((tile) => parsePoint(tile));
		if (tiles.every((tile) => tile !== undefined)) {
			corridors[jnId] = tiles.filter((tile) => tile !== undefined);
		}
	}

	const campIds = stationCampIds(state, stationId);
	const campSet = new Set(campIds);
	const characters = Object.values(state.characters).filter((c) => c.stationId === stationId);
	const junctionIds = new Set(
		stationJunctionIds(
			state,
			campSet,
		),
	);

	// Rooms: complete, well-formed, inside grid, pairwise non-overlapping.
	for (const campId of campIds) {
		const present: JsonValue | undefined = roomsRaw[campId];
		if (present === undefined) reasons.push(`missing room for camp ${campId}`);
	}
	for (const [campId, roomRaw] of Object.entries(roomsRaw)) {
		if (!campSet.has(campId)) {
			reasons.push(`room for unknown camp ${campId}`);
			continue;
		}
		const rectRaw: JsonValue | undefined =
			isJsonObject(roomRaw) ? roomRaw["rect"] : undefined;
		const rect = rectRaw === undefined ? undefined : parseRect(rectRaw);
		if (rect === undefined) {
			reasons.push(`room ${campId}: rect must be integer x/y/w/h`);
			continue;
		}
		if (rect.w < MIN_ROOM_W || rect.h < MIN_ROOM_H) {
			reasons.push(`room ${campId}: smaller than ${MIN_ROOM_W}x${MIN_ROOM_H}`);
		}
		if (
			rect.x < 0 ||
			rect.y < 0 ||
			rect.x + rect.w > grid.w ||
			rect.y + rect.h > grid.h
		) {
			reasons.push(`room ${campId}: outside the grid`);
		}
		const colorRaw: JsonValue | undefined =
			isJsonObject(roomRaw) ? roomRaw["color"] : undefined;
		if (colorRaw === undefined || !isJsonString(colorRaw) || colorRaw.length === 0) {
			reasons.push(`room ${campId}: color must be a non-empty string`);
		}
	}
	const roomEntries = Object.entries(rooms).filter(([id]) => campSet.has(id));
	for (let i = 0; i < roomEntries.length; i += 1) {
		for (let j = i + 1; j < roomEntries.length; j += 1) {
			const a = roomEntries[i];
			const b = roomEntries[j];
			if (a !== undefined && b !== undefined && rectsOverlap(a[1].rect, b[1].rect)) {
				reasons.push(`rooms overlap: ${a[0]} and ${b[0]}`);
			}
		}
	}

	// Desks: complete, well-formed, inside their character's camp room, unique.
	for (const ch of characters) {
		const present: JsonValue | undefined = desksRaw[ch.id];
		if (present === undefined) reasons.push(`missing desk for character ${ch.id}`);
	}
	const seenDesks = new Map<string, string>();
	for (const [charId, deskRaw] of Object.entries(desksRaw)) {
		const ch = state.characters[charId];
		if (ch === undefined || ch.stationId !== stationId) {
			reasons.push(`desk for unknown character ${charId}`);
			continue;
		}
		const desk = parsePoint(deskRaw);
		if (desk === undefined) {
			reasons.push(`desk ${charId}: must be integer x/y`);
			continue;
		}
		const room = rooms[ch.campId];
		if (room !== undefined && !insideRect(desk, room.rect)) {
			reasons.push(`desk ${charId}: outside room ${ch.campId}`);
		}
		const key = `${desk.x},${desk.y}`;
		const other = seenDesks.get(key);
		if (other !== undefined) reasons.push(`desks coincide: ${other} and ${charId}`);
		seenDesks.set(key, charId);
	}

	// Corridors: complete, non-empty, in-grid, contiguous, and walkable (no
	// tile inside any room of the station).
	for (const jnId of junctionIds) {
		const present: JsonValue | undefined = corridorsRaw[jnId];
		if (present === undefined) reasons.push(`missing corridor for junction ${jnId}`);
	}
	for (const [jnId, corridorRaw] of Object.entries(corridorsRaw)) {
		if (!junctionIds.has(jnId)) {
			reasons.push(`corridor for unknown junction ${jnId}`);
			continue;
		}
		const corridor = corridors[jnId];
		if (!Array.isArray(corridorRaw) || corridorRaw.length === 0 || corridor === undefined) {
			reasons.push(`corridor ${jnId}: must be a non-empty array of integer tiles`);
			continue;
		}
		if (!isContiguous(corridor)) {
			reasons.push(`corridor ${jnId}: tiles are not contiguous`);
		}
		for (const tile of corridor) {
			if (tile.x < 0 || tile.y < 0 || tile.x >= grid.w || tile.y >= grid.h) {
				reasons.push(`corridor ${jnId}: tile ${tile.x},${tile.y} outside the grid`);
				break;
			}
		}
		for (const tile of corridor) {
			const blocking = roomEntries.find(([, room]) => insideRect(tile, room.rect));
			if (blocking !== undefined) {
				reasons.push(`corridor ${jnId}: tile ${tile.x},${tile.y} inside room ${blocking[0]}`);
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
		return !blocked.some((r) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h);
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
		for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
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
