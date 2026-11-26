/**
 * Canvas 2D office renderer — programmatic pixel look, no image assets.
 *
 * Talks to the server via GET /state (initial + per-tick refresh) + SSE /events.
 * Rendering is a fixed-timestep-friendly rAF loop decoupled from SSE ticks:
 * characters and packets lerp toward their latest tile position, so movement
 * never teleports. Camera: drag / arrow keys to pan, wheel to zoom (clamped),
 * pixel-crisp (image smoothing off). Click a character (or its bubble) to open
 * the inspect panel fed by GET /character/<id>/activity; click empty floor to
 * close it. Stuck characters get a pulsing flag; an optional WebAudio beep
 * fires on stuck transitions behind a muted-by-default toggle.
 *
 * State colors: working=green, reading=blue, idle=gray, stuck=red.
 */
import { findPath, insideRect, type OfficeLayout } from "../layout.js";
import type {
	AgentEvent,
	AgentState,
	CharacterActivity,
	OfficeState,
	Packet,
	TilePoint,
} from "../model.js";

const TILE = 24;
const MIN_ZOOM = 0.5;
const MAX_ZOOM = 3;
/** Interpolation speed (higher = snappier); movement lerps toward tile targets. */
const LERP_RATE = 8;

interface AgentStateColors {
	working: string;
	reading: string;
	idle: string;
	stuck: string;
}

const STATE_COLORS: AgentStateColors = {
	working: "#4caf50",
	reading: "#42a5f5",
	idle: "#9e9e9e",
	stuck: "#ef5350",
};

interface KindHats {
	bindle: string;
	crew: string;
	actor: string;
}

const KIND_HATS: KindHats = {
	bindle: "#263238",
	crew: "#ffb300",
	actor: "#8e24aa",
};

interface ActivityResponse {
	character: { id: string; name: string; kind: string; campId: string; state: string; health: number };
	activity: CharacterActivity;
}

let office: OfficeState | undefined;
let activeStation: string | undefined;
let selectedCharacter: string | undefined;

/** Render positions (world px, float) keyed by entity id — the interpolation state. */
const renderPos = new Map<string, { x: number; y: number }>();
const prevStates = new Map<string, AgentState>();
const camera = { x: 40, y: 40, zoom: 1 };
let muted = true;
let audio: AudioContext | undefined;

/** Bubble bounds in world px for click hit-testing, rebuilt every frame. */
const bubbleBounds = new Map<string, { x: number; y: number; w: number; h: number }>();

// ---- Layout edit mode (Phase 2 slice 3) ------------------------------------
let editMode = false;
/** Working copy of the active station's layout while editing. */
let draft: OfficeLayout | undefined;
type EditSelection =
	| { kind: "desk"; id: string }
	| { kind: "room"; id: string }
	| { kind: "corridor"; id: string; waypoints: TilePoint[] };
let editSel: EditSelection | undefined;

function currentLayout(): OfficeLayout | undefined {
	if (office === undefined || activeStation === undefined) return undefined;
	return office.layouts[activeStation];
}

function worldToTile(wx: number, wy: number): TilePoint {
	return { x: Math.floor(wx / TILE), y: Math.floor(wy / TILE) };
}

function setEditMode(on: boolean): void {
	editMode = on;
	editSel = undefined;
	draft = on ? structuredClone(currentLayout()) : undefined;
	const button = document.getElementById("edit-toggle");
	if (button !== null) button.textContent = on ? "📐 editing…" : "📐 layout";
}

/** Push the current draft to the server; revert to server state on rejection. */
async function submitDraft(): Promise<void> {
	if (draft === undefined || activeStation === undefined) return;
	const res = await fetch(`/layout/${encodeURIComponent(activeStation)}`, {
		method: "PUT",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(draft),
	});
	if (!res.ok) {
		// SAFETY: `const body = (await res.json()) as { reasons?: string[]; error?: string };` is required at this I/O or test boundary.
		const body = (await res.json()) as { reasons?: string[]; error?: string };
		alert(`layout rejected:\n${(body.reasons ?? [body.error ?? "unknown"]).join("\n")}`);
		draft = structuredClone(currentLayout());
		editSel = undefined;
	}
}

/** Smallest room size that still fits every desk currently in the room. */
interface RoomSize {
	w: number;
	h: number;
}

function minRoomSize(layout: OfficeLayout, campId: string): RoomSize {
	const room = layout.rooms[campId];
	let w = 3;
	let h = 3;
	if (room === undefined || office === undefined) return { w, h };
	for (const ch of Object.values(office.characters)) {
		if (ch.campId !== campId) continue;
		const desk = draft?.desks[ch.id] ?? ch.desk;
		w = Math.max(w, desk.x - room.rect.x + 2);
		h = Math.max(h, desk.y - room.rect.y + 2);
	}
	return { w, h };
}

/** Rebuild the selected junction corridor through the accumulated waypoints. */
function rerouteCorridor(layout: OfficeLayout, junctionId: string, waypoints: TilePoint[]): boolean {
	const existing = layout.corridors[junctionId];
	if (existing === undefined || existing.length === 0) return false;
	const start = existing[0];
	const end = existing[existing.length - 1];
	if (start === undefined || end === undefined) return false;
	const blocked = Object.values(layout.rooms).map((r) => r.rect);
	const anchors = [start, ...waypoints, end];
	const segments: TilePoint[][] = [];
	for (let i = 1; i < anchors.length; i += 1) {
		const from = anchors[i - 1];
		const to = anchors[i];
		if (from === undefined || to === undefined) return false;
		const segment = findPath(layout.grid, blocked, from, to);
		if (segment === undefined) return false;
		segments.push(i === 1 ? segment : segment.slice(1));
	}
	layout.corridors[junctionId] = segments.flat();
	return true;
}

async function bootstrap(): Promise<OfficeState> {
	const res = await fetch("/state");
	// SAFETY: `return (await res.json()) as OfficeState;` is required at this I/O or test boundary.
	return (await res.json()) as OfficeState;
}

function connect(onTick: () => void): void {
	const source = new EventSource("/events");
	source.addEventListener("snapshot", (message) => {
		// SAFETY: `office = JSON.parse((message as MessageEvent<string>).data) as OfficeState;` is required at this I/O or test boundary.
		office = JSON.parse((message as MessageEvent<string>).data) as OfficeState;
		onTick();
	});
	for (const type of [
		"span-started",
		"span-ended",
		"metric-sample",
		"log-record",
		"packet-started",
		"tick",
	]) {
		source.addEventListener(type, (message) => {
			if (office === undefined) return;
			// SAFETY: `const event = JSON.parse((message as MessageEvent<string>).data) as AgentEvent;` is required at this I/O or test boundary.
			const event = JSON.parse((message as MessageEvent<string>).data) as AgentEvent;
			// The server owns state; the client re-pulls cheap snapshots each tick.
			if (event.type === "tick") void refresh(onTick);
		});
	}
}

async function refresh(onTick: () => void): Promise<void> {
	office = await bootstrap();
	onTick();
}

function beep(): void {
	if (muted) return;
	audio ??= new AudioContext();
	const osc = audio.createOscillator();
	const gain = audio.createGain();
	osc.type = "square";
	osc.frequency.value = 660;
	gain.gain.setValueAtTime(0.05, audio.currentTime);
	gain.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + 0.25);
	osc.connect(gain).connect(audio.destination);
	osc.start();
	osc.stop(audio.currentTime + 0.25);
}

/** Lerp every render position toward its latest tile target. */
function interpolate(dt: number): void {
	if (office === undefined) return;
	const seen = new Set<string>();
	const targets: { id: string; tile: TilePoint }[] = [];
	for (const ch of Object.values(office.characters)) {
		if (ch.stationId === activeStation) targets.push({ id: ch.id, tile: ch.position });
	}
	for (const packet of Object.values(office.packets)) {
		targets.push({ id: `packet:${packet.id}`, tile: packet.position });
	}
	const t = 1 - Math.exp(-LERP_RATE * dt);
	for (const { id, tile } of targets) {
		seen.add(id);
		const tx = tile.x * TILE;
		const ty = tile.y * TILE;
		const pos = renderPos.get(id);
		if (pos === undefined) {
			renderPos.set(id, { x: tx, y: ty });
		} else {
			// Snap when far away (new station / teleport) so we never lerp across the map.
			if (Math.abs(pos.x - tx) > TILE * 4 || Math.abs(pos.y - ty) > TILE * 4) {
				pos.x = tx;
				pos.y = ty;
			} else {
				pos.x += (tx - pos.x) * t;
				pos.y += (ty - pos.y) * t;
			}
		}
	}
	for (const id of renderPos.keys()) {
		if (!seen.has(id)) renderPos.delete(id);
	}
}

/** Detect fresh stuck transitions and beep. */
function watchStuck(): void {
	if (office === undefined) return;
	for (const ch of Object.values(office.characters)) {
		const prev = prevStates.get(ch.id);
		if (ch.state === "stuck" && prev !== "stuck") beep();
		prevStates.set(ch.id, ch.state);
	}
}

interface WorldPoint {
	x: number;
	y: number;
}

function toWorld(canvas: HTMLCanvasElement, sx: number, sy: number): WorldPoint {
	const rect = canvas.getBoundingClientRect();
	return {
		x: (sx - rect.left) / camera.zoom + camera.x,
		y: (sy - rect.top) / camera.zoom + camera.y,
	};
}

function render(canvas: HTMLCanvasElement, stationBar: HTMLElement): void {
	if (office === undefined) return;
	const ctx = canvas.getContext("2d");
	if (ctx === null) return;

	const stations = Object.values(office.stations);
	activeStation ??= stations[0]?.id;
	stationBar.replaceChildren(
		...stations.map((station) => {
			const button = document.createElement("button");
			button.textContent = station.name;
			button.disabled = station.id === activeStation;
			button.onclick = () => {
				activeStation = station.id;
				selectedCharacter = undefined;
				closePanel();
			};
			return button;
		}),
	);

	ctx.setTransform(1, 0, 0, 1, 0, 0);
	ctx.fillStyle = "#111";
	ctx.fillRect(0, 0, canvas.width, canvas.height);
	ctx.setTransform(camera.zoom, 0, 0, camera.zoom, -camera.x * camera.zoom, -camera.y * camera.zoom);
	ctx.imageSmoothingEnabled = false;
	const frame = Math.floor(performance.now() / 250) % 2;

	// Station banner — isolation is explicit: only this station's entities below.
	const stationName = office.stations[activeStation ?? ""]?.name ?? "";
	ctx.fillStyle = "#eceff1";
	ctx.font = "16px monospace";
	ctx.fillText(`station: ${stationName} (isolated — ADR-0131)`, 0, -8);

	const yardsInStation = new Set(
		Object.values(office.yards)
			.filter((y) => y.stationId === activeStation)
			.map((y) => y.id),
	);
	const camps = Object.values(office.camps).filter((c) => yardsInStation.has(c.yardId));
	const campIds = new Set(camps.map((c) => c.id));

	// Corridors (junctions between visible camps).
	for (const junction of Object.values(office.junctions)) {
		if (!campIds.has(junction.fromCampId) || !campIds.has(junction.toCampId)) continue;
		ctx.fillStyle = "#37474f";
		for (const tile of junction.corridor) {
			ctx.fillRect(tile.x * TILE, tile.y * TILE, TILE, TILE);
		}
	}

	// Camp rooms + desks.
	for (const camp of camps) {
		ctx.fillStyle = "#1e272e";
		ctx.fillRect(camp.rect.x * TILE, camp.rect.y * TILE, camp.rect.w * TILE, camp.rect.h * TILE);
		ctx.strokeStyle = "#576574";
		ctx.strokeRect(camp.rect.x * TILE, camp.rect.y * TILE, camp.rect.w * TILE, camp.rect.h * TILE);
		ctx.fillStyle = "#d2dae2";
		ctx.font = "12px monospace";
		ctx.fillText(camp.name, camp.rect.x * TILE + 4, camp.rect.y * TILE + 14);
		for (const ch of Object.values(office.characters)) {
			if (ch.campId !== camp.id) continue;
			ctx.fillStyle = "#4b3f2f";
			ctx.fillRect(ch.desk.x * TILE + 4, ch.desk.y * TILE + 4, TILE - 8, TILE - 8);
		}
	}

	// Trace packets walking junction corridors.
	// SAFETY: `for (const packet of Object.values(office.packets) as Packet[]) {` is required at this I/O or test boundary.
	for (const packet of Object.values(office.packets) as Packet[]) {
		if (!campIds.has(packet.fromCampId) || !campIds.has(packet.toCampId)) continue;
		const pos = renderPos.get(`packet:${packet.id}`) ?? {
			x: packet.position.x * TILE,
			y: packet.position.y * TILE,
		};
		ctx.fillStyle = "#ffd54f";
		ctx.fillRect(pos.x + 8, pos.y + 8, TILE - 16, TILE - 16);
		ctx.strokeStyle = "#ff8f00";
		ctx.strokeRect(pos.x + 8, pos.y + 8, TILE - 16, TILE - 16);
	}

	// Characters.
	bubbleBounds.clear();
	for (const ch of Object.values(office.characters)) {
		if (ch.stationId !== activeStation) continue;
		const pos = renderPos.get(ch.id) ?? { x: ch.position.x * TILE, y: ch.position.y * TILE };
		const bob = ch.state === "working" || ch.path.length > 0 ? frame * 2 : 0;
		if (ch.id === selectedCharacter) {
			ctx.strokeStyle = "#eceff1";
			ctx.strokeRect(pos.x + 1, pos.y + 1, TILE - 2, TILE - 2);
		}
		ctx.fillStyle = STATE_COLORS[ch.state];
		ctx.fillRect(pos.x + 5, pos.y + 8 - bob, TILE - 10, TILE - 10);
		ctx.fillStyle = KIND_HATS[ch.kind];
		ctx.fillRect(pos.x + 5, pos.y + 3 - bob, TILE - 10, 5);
		// Stuck: pulsing attention flag.
		if (ch.state === "stuck") {
			const pulse = 0.5 + 0.5 * Math.sin(performance.now() / 200);
			ctx.globalAlpha = 0.4 + 0.6 * pulse;
			ctx.fillStyle = "#ff1744";
			ctx.fillRect(pos.x + TILE - 4, pos.y - 12, 2, 10);
			ctx.beginPath();
			ctx.moveTo(pos.x + TILE - 2, pos.y - 12);
			ctx.lineTo(pos.x + TILE + 6, pos.y - 9);
			ctx.lineTo(pos.x + TILE - 2, pos.y - 6);
			ctx.fill();
			ctx.globalAlpha = 1;
		}
		// Health bar over the desk.
		ctx.fillStyle = "#333";
		ctx.fillRect(pos.x + 2, pos.y - 4, TILE - 4, 3);
		ctx.fillStyle = ch.health > 0.4 ? "#4caf50" : "#ef5350";
		ctx.fillRect(pos.x + 2, pos.y - 4, (TILE - 4) * ch.health, 3);
		// Speech bubble.
		if (ch.bubble !== undefined) {
			ctx.font = "10px monospace";
			const width = ctx.measureText(ch.bubble).width + 8;
			ctx.fillStyle = "#fff8e1";
			ctx.fillRect(pos.x + TILE, pos.y - 18, width, 14);
			ctx.fillStyle = "#5d4037";
			ctx.fillText(ch.bubble, pos.x + TILE + 4, pos.y - 8);
			bubbleBounds.set(ch.id, { x: pos.x + TILE, y: pos.y - 18, w: width, h: 14 });
		}
		ctx.fillStyle = "#eceff1";
		ctx.font = "9px monospace";
		ctx.fillText(ch.name, pos.x - 2, pos.y + TILE + 8);
	}
}

function closePanel(): void {
	selectedCharacter = undefined;
	const panel = document.getElementById("panel");
	if (panel !== null) panel.style.display = "none";
}

async function openPanel(characterId: string): Promise<void> {
	selectedCharacter = characterId;
	await refreshPanel();
}

function escapeHtml(text: string): string {
	return text
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;");
}

/** Group flat span activity into per-traceId journeys with timing bars. */
function renderJourneys(activity: CharacterActivity): string {
	const byTrace = new Map<string, typeof activity.spans>();
	for (const span of activity.spans) {
		const list = byTrace.get(span.traceId) ?? [];
		list.push(span);
		byTrace.set(span.traceId, list);
	}
	// Newest journey first (activity arrives newest-first already).
	const journeys = [...byTrace.entries()].slice(0, 5);
	if (journeys.length === 0) return "<p><small>no spans yet</small></p>";
	return journeys
		.map(([traceId, spans]) => {
			const ordered = [...spans].sort((a, b) => a.startedAt - b.startedAt);
			const min = ordered[0]?.startedAt ?? 0;
			const maxEnd = Math.max(
				...ordered.map((s) => s.startedAt + (s.durationMs ?? 1)),
				min + 1,
			);
			const spanMs = maxEnd - min;
			const rows = ordered
				.map((s) => {
					const left = (((s.startedAt - min) / spanMs) * 100).toFixed(1);
					const width = Math.max(3, (((s.durationMs ?? Math.max(1, spanMs * 0.05)) / spanMs) * 100)).toFixed(1);
					const status =
						s.status === "error" ? "✖" : s.status === "open" ? "…" : "✓";
					return `<div class="journey-row" title="${escapeHtml(s.name)} ${s.durationMs ?? "?"}ms ${s.status}">
						<span class="journey-name">${status} ${escapeHtml(s.name)}</span>
						<span class="journey-track"><span class="journey-bar ${s.status}" style="left:${left}%;width:${width}%"></span></span>
					</div>`;
				})
				.join("");
			return `<div class="journey"><small>trace ${escapeHtml(traceId.slice(0, 16))} · ${spanMs}ms</small>${rows}</div>`;
		})
		.join("");
}

async function refreshPanel(): Promise<void> {
	const panel = document.getElementById("panel");
	if (panel === null || selectedCharacter === undefined) return;
	const res = await fetch(`/character/${encodeURIComponent(selectedCharacter)}/activity`);
	if (!res.ok) {
		closePanel();
		return;
	}
	// SAFETY: `const data = (await res.json()) as ActivityResponse;` is required at this I/O or test boundary.
	const data = (await res.json()) as ActivityResponse;
	const { character, activity } = data;
	const logRows = activity.logs
		.slice(0, 8)
		.map(
			(l) =>
				`<li class="log-${l.severity.toLowerCase()}">[${l.severity}] ${escapeHtml(l.message)}${
					l.traceId === undefined ? "" : ` <small>trace ${escapeHtml(l.traceId.slice(0, 8))}</small>`
				}</li>`,
		)
		.join("");
	const metricRows = activity.metrics
		.slice(0, 8)
		.map((m) => `<li>${escapeHtml(m.metric)} = ${m.value.toFixed(3)}</li>`)
		.join("");
	panel.innerHTML = `
		<strong>${escapeHtml(character.name)}</strong> <small>${character.kind} · ${escapeHtml(character.campId)}</small>
		<button id="panel-close" style="float:right">×</button>
		<div>state: ${character.state} · health: ${(character.health * 100).toFixed(0)}%</div>
		<h4>Journeys</h4>
		${renderJourneys(activity)}
		<h4>Logs</h4>
		<ul>${logRows || "<li><small>none</small></li>"}</ul>
		<h4>Metrics</h4>
		<ul>${metricRows || "<li><small>none</small></li>"}</ul>`;
	panel.style.display = "block";
	panel.querySelector("#panel-close")?.addEventListener("click", closePanel);
}

function handleClick(canvas: HTMLCanvasElement, event: MouseEvent): void {
	if (office === undefined) return;
	const world = toWorld(canvas, event.clientX, event.clientY);
	// Bubble click opens the panel (attention affordance).
	for (const [id, b] of bubbleBounds) {
		if (world.x >= b.x && world.x <= b.x + b.w && world.y >= b.y && world.y <= b.y + b.h) {
			void openPanel(id);
			return;
		}
	}
	for (const ch of Object.values(office.characters)) {
		if (ch.stationId !== activeStation) continue;
		const pos = renderPos.get(ch.id) ?? { x: ch.position.x * TILE, y: ch.position.y * TILE };
		if (world.x >= pos.x && world.x <= pos.x + TILE && world.y >= pos.y && world.y <= pos.y + TILE) {
			void openPanel(ch.id);
			return;
		}
	}
	closePanel();
}

function attachCamera(canvas: HTMLCanvasElement): void {
	let dragging = false;
	let moved = false;
	let lastX = 0;
	let lastY = 0;
	canvas.addEventListener("pointerdown", (event) => {
		dragging = true;
		moved = false;
		lastX = event.clientX;
		lastY = event.clientY;
		canvas.setPointerCapture(event.pointerId);
	});
	canvas.addEventListener("pointermove", (event) => {
		if (!dragging) return;
		const dx = event.clientX - lastX;
		const dy = event.clientY - lastY;
		if (Math.abs(dx) + Math.abs(dy) > 3) moved = true;
		camera.x -= dx / camera.zoom;
		camera.y -= dy / camera.zoom;
		lastX = event.clientX;
		lastY = event.clientY;
	});
	canvas.addEventListener("pointerup", (event) => {
		dragging = false;
		if (!moved) handleClick(canvas, event);
	});
	canvas.addEventListener(
		"wheel",
		(event) => {
			event.preventDefault();
			const before = toWorld(canvas, event.clientX, event.clientY);
			camera.zoom = Math.min(
				MAX_ZOOM,
				Math.max(MIN_ZOOM, camera.zoom * (event.deltaY < 0 ? 1.1 : 1 / 1.1)),
			);
			const after = toWorld(canvas, event.clientX, event.clientY);
			camera.x += before.x - after.x;
			camera.y += before.y - after.y;
		},
		{ passive: false },
	);
	window.addEventListener("keydown", (event) => {
		const step = TILE * 2;
		if (event.key === "ArrowLeft") camera.x -= step;
		else if (event.key === "ArrowRight") camera.x += step;
		else if (event.key === "ArrowUp") camera.y -= step;
		else if (event.key === "ArrowDown") camera.y += step;
		else return;
		event.preventDefault();
	});
}

async function start(): Promise<void> {
	// SAFETY: `const canvas = document.getElementById("office") as HTMLCanvasElement | null;` is required at this I/O or test boundary.
	const canvas = document.getElementById("office") as HTMLCanvasElement | null;
	const stationBar = document.getElementById("stations");
	const muteToggle = document.getElementById("mute");
	if (canvas === null || stationBar === null) return;
	office = await bootstrap();
	connect(() => {
		watchStuck();
		void refreshPanel();
	});
	attachCamera(canvas);
	if (muteToggle !== null) {
		muteToggle.addEventListener("click", () => {
			muted = !muted;
			muteToggle.textContent = muted ? "🔇 sound off" : "🔊 sound on";
		});
	}
	let last = performance.now();
	const loop = (now: number): void => {
		const dt = Math.min(0.1, (now - last) / 1000);
		last = now;
		interpolate(dt);
		render(canvas, stationBar);
		requestAnimationFrame(loop);
	};
	requestAnimationFrame(loop);
}

void start();
void [
	insideRect,
	editMode,
	editSel,
	worldToTile,
	setEditMode,
	submitDraft,
	minRoomSize,
	rerouteCorridor,
];
