/**
 * OTel office server — zero runtime deps, node:http + SSE.
 *
 *   GET  /            → static client shell (public/index.html)
 *   GET  /client/*    → compiled browser bundle (dist/client/*)
 *   GET  /state       → JSON office snapshot
 *   GET  /character/<id>/activity → bounded per-character spans/logs/metrics
 *   GET  /events      → SSE stream: snapshot, then per-tick events
 *   POST /v1/traces   → OTLP/JSON trace ingest (feeds the mapper + trace index)
 *   POST /v1/logs     → OTLP/JSON logs ingest (bubbles, stuck attention, activity)
 *   POST /v1/metrics  → OTLP/JSON metrics ingest (health bar + activity)
 *   GET  /layout/<stationId> → the station's office layout as JSON
 *   PUT  /layout/<stationId> → replace a layout (validated; 400 with reasons)
 *
 * Layouts are data (Phase 2 slice 3): part of /state + the SSE snapshot,
 * persisted per station as JSON under OTEL_OFFICE_HOME (default ~/.otel-office),
 * loaded on boot, saved (atomic + debounced) on edit.
 *
 * A server-side TraceIndex lets cross-camp packet pairs resolve even when a
 * collector sends parent and child spans in separate requests.
 *
 * Simulator on by default; OTEL_OFFICE_SIM=0 disables it.
 * Port: --port <n> or PORT env; default 0 (OS-assigned free port).
 */
import { createReadStream, existsSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { applyLayout, validateLayout } from "./layout.js";
import { LayoutStore, defaultOfficeHome } from "./layout-store.js";
import {
	type AgentEvent,
	ActivityLog,
	type OfficeState,
	applyEvent,
} from "./model.js";
import { type OtlpTraceRequest, mapTracePayload } from "./otel.js";
import {
	type OtlpLogsRequest,
	type OtlpMetricsRequest,
	mapLogsPayload,
	mapMetricsPayload,
} from "./otel-signals.js";
import { SIM_TICK_MS, createSimulation } from "./simulator.js";
import { TraceIndex } from "./trace-index.js";
import { cloneAsJson, isJsonString, type JsonValue } from "./json.js";


const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = normalize(join(HERE, "..", "public"));
// tsx runs from src/ (compiled client in dist/client); node runs from dist/ (client beside it).
const CLIENT_DIR = [join(HERE, "client"), join(HERE, "..", "dist", "client")].find((dir) =>
	existsSync(join(dir, "index.js")),
) ?? join(HERE, "..", "dist", "client");

interface StaticMimeTypes {
	".html": string;
	".js": string;
	".css": string;
	".json": string;
	".map": string;
}

const MIME: StaticMimeTypes = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".map": "application/json; charset=utf-8",
};

export interface OfficeServerOptions {
	simulate?: boolean;
	seed?: number;
	tickMs?: number;
	/** Layout persistence home (default: OTEL_OFFICE_HOME or ~/.otel-office). */
	home?: string;
	/** Optional startup/audit log sink (main() passes console.log). */
	log?: (message: string) => void;
}

export interface OfficeServer {
	server: Server;
	port: () => number;
	state: () => OfficeState;
	/** Flush debounced layout writes to disk. */
	flushLayouts: () => void;
	close: () => Promise<void>;
}

function sendJson(res: ServerResponse, status: number, body: JsonValue): void {
	res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
	res.end(JSON.stringify(body));
}

function mimeFor(path: string): string {
	const ext = extname(path);
	switch (ext) {
		case ".html":
		case ".js":
		case ".css":
		case ".json":
		case ".map":
			return MIME[ext];
		default:
			return "application/octet-stream";
	}
}

function serveFile(res: ServerResponse, path: string): void {
	const type = mimeFor(path);
	res.writeHead(200, { "content-type": type });
	createReadStream(path).pipe(res);
}

async function readBody(req: IncomingMessage): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of req) {
		// SAFETY: `chunks.push(chunk as Buffer);` is required at this I/O or test boundary.
		chunks.push(chunk as Buffer);
	}
	return Buffer.concat(chunks).toString("utf8");
}

export function createOfficeServer(options: OfficeServerOptions = {}): OfficeServer {
	const simulate = options.simulate ?? process.env.OTEL_OFFICE_SIM !== "0";
	const tickMs = options.tickMs ?? SIM_TICK_MS;
	const sim = createSimulation(options.seed ?? 1);
	let state = sim.state;
	const activity = new ActivityLog();
	const traceIndex = new TraceIndex();
	const clients = new Set<ServerResponse>();
	const log = options.log ?? ((): void => {});
	const layouts = new LayoutStore(options.home ?? defaultOfficeHome());

	// Boot: a persisted layout wins over the derived default when it validates.
	for (const stationId of Object.keys(state.stations)) {
		const persisted = layouts.load(stationId);
		if (persisted === undefined) {
			log(`layout[${stationId}]: no persisted layout (will save to ${layouts.pathFor(stationId)} on first edit)`);
			continue;
		}
		const { layout, reasons } = validateLayout(persisted, state, stationId);
		if (layout === undefined) {
			log(`layout[${stationId}]: ignoring invalid persisted layout ${layouts.pathFor(stationId)}: ${reasons.join("; ")}`);
			continue;
		}
		applyLayout(state, stationId, layout);
		log(`layout[${stationId}]: loaded ${layouts.pathFor(stationId)}`);
	}

	function broadcast(events: AgentEvent[]): void {
		for (const event of events) {
			const line = `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
			for (const res of clients) res.write(line);
		}
	}

	function dispatch(events: AgentEvent[]): void {
		for (const event of events) {
			state = applyEvent(state, event);
			activity.record(event);
		}
		broadcast(events);
	}

	let timer: NodeJS.Timeout | undefined;
	if (simulate) {
		timer = setInterval(() => dispatch(sim.step()), tickMs);
		timer.unref();
	}

	const server = createServer((req, res) => {
		const url = new URL(req.url ?? "/", "http://localhost");
		const path = url.pathname;
		if (req.method === "GET" && path === "/") {
			const index = join(PUBLIC_DIR, "index.html");
			if (existsSync(index)) {
				serveFile(res, index);
			} else {
				res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
				res.end("<h1>otel-office</h1><p>client not built</p>");
			}
			return;
		}
		if (req.method === "GET" && path.startsWith("/client/")) {
			const rel = normalize(path.slice("/client/".length));
			const file = join(CLIENT_DIR, rel);
			if (!file.startsWith(CLIENT_DIR) || !existsSync(file)) {
				sendJson(res, 404, { error: "not found" });
				return;
			}
			serveFile(res, file);
			return;
		}
		// The client bundle imports shared compiled modules (e.g. ../layout.js);
		// the browser resolves those to /<module>.js, served from the dist root.
		if (req.method === "GET" && /^\/[a-z-]+\.js(\.map)?$/u.test(path)) {
			const distRoot = normalize(join(CLIENT_DIR, ".."));
			const file = join(distRoot, path.slice(1));
			if (file.startsWith(distRoot) && existsSync(file)) {
				serveFile(res, file);
				return;
			}
		}
		if (req.method === "GET" && path === "/state") {
			sendJson(res, 200, cloneAsJson(state));
			return;
		}
		if (req.method === "GET" && path.startsWith("/character/") && path.endsWith("/activity")) {
			const id = decodeURIComponent(path.slice("/character/".length, -"/activity".length));
			const character = state.characters[id];
			if (character === undefined) {
				sendJson(res, 404, { error: "unknown character" });
				return;
			}
			sendJson(res, 200, cloneAsJson({
				character: {
					id: character.id,
					name: character.name,
					kind: character.kind,
					campId: character.campId,
					state: character.state,
					health: character.health,
				},
				activity: activity.for(id),
			}));
			return;
		}
		if (req.method === "GET" && path === "/events") {
			res.writeHead(200, {
				"content-type": "text/event-stream",
				"cache-control": "no-cache",
				connection: "keep-alive",
			});
			res.write(`event: snapshot\ndata: ${JSON.stringify(state)}\n\n`);
			clients.add(res);
			req.on("close", () => clients.delete(res));
			return;
		}
		if (req.method === "GET" && path.startsWith("/layout/")) {
			const stationId = decodeURIComponent(path.slice("/layout/".length));
			const layout = state.layouts[stationId];
			if (layout === undefined) {
				sendJson(res, 404, { error: "unknown station" });
				return;
			}
			sendJson(res, 200, cloneAsJson(layout));
			return;
		}
		if (req.method === "PUT" && path.startsWith("/layout/")) {
			const stationId = decodeURIComponent(path.slice("/layout/".length));
			void (async () => {
				try {
					if (state.stations[stationId] === undefined) {
						sendJson(res, 404, { error: "unknown station" });
						return;
					}
					const raw = await readBody(req);
					const { layout, reasons } = validateLayout(JSON.parse(raw), state, stationId);
					if (layout === undefined) {
						sendJson(res, 400, { error: "invalid layout", reasons });
						return;
					}
					applyLayout(state, stationId, layout);
					layouts.saveDebounced(stationId, layout);
					// No tick may be coming (sim off) — push a fresh snapshot now.
					broadcast([{ type: "layout-changed", at: Date.now(), stationId }]);
					sendJson(res, 200, { applied: true });
				} catch (error) {
					sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
				}
			})();
			return;
		}
		if (req.method === "POST" && path === "/v1/traces") {
			void (async () => {
				try {
					const raw = await readBody(req);
					// SAFETY: `const payload = JSON.parse(raw) as OtlpTraceRequest;` is required at this I/O or test boundary.
					const payload = JSON.parse(raw) as OtlpTraceRequest;
					const events = mapTracePayload(payload, state, Date.now(), traceIndex);
					dispatch(events);
					sendJson(res, 200, { accepted: events.length });
				} catch (error) {
					sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
				}
			})();
			return;
		}
		if (req.method === "POST" && path === "/v1/logs") {
			void (async () => {
				try {
					const raw = await readBody(req);
					// SAFETY: `const payload = JSON.parse(raw) as OtlpLogsRequest;` is required at this I/O or test boundary.
					const payload = JSON.parse(raw) as OtlpLogsRequest;
					const events = mapLogsPayload(payload, state);
					dispatch(events);
					sendJson(res, 200, { accepted: events.length });
				} catch (error) {
					sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
				}
			})();
			return;
		}
		if (req.method === "POST" && path === "/v1/metrics") {
			void (async () => {
				try {
					const raw = await readBody(req);
					// SAFETY: `const payload = JSON.parse(raw) as OtlpMetricsRequest;` is required at this I/O or test boundary.
					const payload = JSON.parse(raw) as OtlpMetricsRequest;
					const events = mapMetricsPayload(payload, state);
					dispatch(events);
					sendJson(res, 200, { accepted: events.length });
				} catch (error) {
					sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
				}
			})();
			return;
		}
		sendJson(res, 404, { error: "not found" });
	});

	return {
		server,
		port: () => {
			const address = server.address();
			return address !== null && !isJsonString(address) ? address.port : 0;
		},
		state: () => state,
		flushLayouts: () => layouts.flush(),
		close: () =>
			new Promise((resolvePromise, rejectPromise) => {
				if (timer !== undefined) clearInterval(timer);
				layouts.flush();
				for (const res of clients) res.end();
				server.close((error) => (error === undefined ? resolvePromise() : rejectPromise(error)));
			}),
	};
}

async function main(): Promise<void> {
	const portArg = process.argv.find((arg) => arg.startsWith("--port="));
	const port = Number(portArg?.slice("--port=".length) ?? process.env.PORT ?? 0);
	const office = createOfficeServer({ log: (msg) => console.log(msg) });
	office.server.listen(port, () => {
		console.log(`otel-office listening on http://localhost:${office.port()}`);
		console.log(`simulator: ${process.env.OTEL_OFFICE_SIM === "0" ? "off" : "on"}`);
		console.log(`layout data dir: ${join(defaultOfficeHome(), "layouts")}`);
	});
}

const isMain = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
	void main();
}
