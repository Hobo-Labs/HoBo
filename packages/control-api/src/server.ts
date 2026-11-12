import {
	createServer,
	type IncomingMessage,
	type Server,
	type ServerResponse,
} from "node:http";
import { URL } from "node:url";

import {
	brokerStatus,
	connectionAuthorize,
	connectionCreate,
	connectionGet,
	connectionList,
	connectionRevoke,
	connectionRotate,
	createManagementContext,
	doctorSnapshot,
	type ManagementContext,
	type ManagementResult,
	projectCredentialAudit,
	projectDeploymentView,
	projectYardSnapshot,
	stationDown,
	stationInit,
	stationRailsActivate,
	stationRailsApprove,
	stationRailsList,
	stationRailsPublish,
	stationStatus,
	stationUp,
} from "@hobo/management";
import {
	type AgentEvent,
	applyEvent,
	createSimulation,
	emptyWorld,
	mapLogsPayload,
	mapMetricsPayload,
	mapTracePayload,
	type OtlpLogsRequest,
	type OtlpMetricsRequest,
	type OtlpTraceRequest,
	type Simulation,
	TraceIndex,
	type WorldState,
} from "@hobo/yard-world";

/**
 * A `/v1/cd/` request as the CD handler sees it (structurally identical to
 * `FeedRequest` in `@hobo/cd`): header names lower-cased, path with query.
 */
export type CdHttpRequest = Readonly<{
	method: string;
	path: string;
	headers: Readonly<Record<string, string>>;
	body: Uint8Array;
}>;

/** A `/v1/cd/` response (structurally identical to `FeedResponse` in `@hobo/cd`). */
export type CdHttpResponse = Readonly<{
	status: number;
	headers: Readonly<Record<string, string>>;
	body: Uint8Array | AsyncIterable<Uint8Array>;
}>;

/**
 * The CD surface the control API mounts under `/v1/cd/` (plan 0024 WP12):
 * `createCdControlApi` from `@hobo/cd/service` (read API + SSE stream, falling
 * through to the delivery feed). Typed structurally so the control API needs
 * no build-time dependency on `@hobo/cd`; composition (WP18) passes it in.
 */
export interface CdHttpMount {
	readonly pathPrefix: string;
	handle(request: CdHttpRequest, signal: AbortSignal): Promise<CdHttpResponse>;
	/** OpenAPI document of the mounted routes; its paths and schemas are merged into `/v1/openapi.json`. */
	openapi?(): Readonly<Record<string, unknown>>;
}

export type ControlApiServerOptions = Readonly<{
	hoboHome: string;
	/** Mount the CD read API, SSE stream and delivery feed under `/v1/cd/`. */
	cd?: CdHttpMount;
	host?: string;
	port?: number;
	/** SSE poll interval ms (default 500). */
	streamIntervalMs?: number;
	/** Injectable context for tests. */
	context?: ManagementContext;
	/**
	 * Demo mode: run the deterministic @hobo/yard-world simulator so the world
	 * read model is alive without a real OTLP exporter. Defaults to
	 * `HOBO_CONTROL_DEMO=1`.
	 */
	demo?: boolean;
	/** Simulator seed (default 42; env HOBO_CONTROL_DEMO_SEED). */
	demoSeed?: number;
	/**
	 * Demo tick interval ms (default 1000). Set 0 to disable the timer and
	 * drive ticks via `tickDemo()` (tests).
	 */
	demoIntervalMs?: number;
}>;

export type ControlApiServer = Readonly<{
	server: Server;
	url: string;
	port: number;
	host: string;
	close: () => Promise<void>;
	context: ManagementContext;
	/** True when the world read model is fed by the simulator. */
	demo: boolean;
	/** Simulator seed when demo mode is on; null otherwise. */
	demoSeed: number | null;
	/** Advance the demo simulator one tick; returns applied event count (0 when demo off). */
	tickDemo: () => number;
	/** Current world read-model snapshot (JSON-serializable). */
	worldSnapshot: () => WorldState;
}>;

type WorldDelta = Readonly<{
	events: readonly AgentEvent[];
	tick: number;
	demo: boolean;
}>;

type JsonValue =
	| undefined
	| null
	| boolean
	| number
	| string
	| JsonValue[]
	| { [key: string]: JsonValue };
type JsonObject = { [key: string]: JsonValue };
type JsonBody =
	| ManagementResult
	| JsonObject
	| {
			ok: boolean;
			data: { world: WorldState; demo: boolean; seed: number | null };
	  };

/** Refuse bodies larger than this rather than buffering them into the heap. */
const MAX_BODY_BYTES = 8 * 1024 * 1024;

export class PayloadTooLargeError extends Error {
	constructor() {
		super(`request body exceeds ${MAX_BODY_BYTES} bytes`);
		this.name = "PayloadTooLargeError";
	}
}

/**
 * First capture of a route match. The routes below all have exactly one group,
 * so a successful match always has it — this makes that explicit rather than
 * asserting it away.
 */
function pathParam(match: RegExpMatchArray): string {
	const value = match[1];
	if (value === undefined) {
		throw new Error(`route matched without its parameter: ${match[0]}`);
	}
	return value;
}

async function readJson(req: IncomingMessage): Promise<JsonObject> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of req) {
		const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		size += buf.length;
		// An unauthenticated ingest route must not let a single request
		// exhaust the control plane's heap.
		if (size > MAX_BODY_BYTES) {
			req.destroy();
			throw new PayloadTooLargeError();
		}
		chunks.push(buf);
	}
	if (chunks.length === 0) return {};
	const raw = Buffer.concat(chunks).toString("utf8");
	if (!raw.trim()) return {};
	// SAFETY: the HTTP JSON parser is the single boundary for request bodies.
	return JSON.parse(raw) as JsonObject;
}

function sendJson(res: ServerResponse, status: number, body: JsonBody): void {
	const payload = JSON.stringify(body);
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"cache-control": "no-store",
		"access-control-allow-origin": "*",
		"access-control-allow-headers":
			"content-type, x-hobo-principal, x-hobo-tenant",
		"access-control-allow-methods": "GET, POST, OPTIONS",
	});
	res.end(payload);
}

function queryOf(url: URL) {
	return Object.fromEntries(url.searchParams.entries());
}

export async function createControlApiServer(
	options: ControlApiServerOptions,
): Promise<ControlApiServer> {
	const host = options.host ?? "127.0.0.1";
	const port = options.port ?? 0;
	const streamIntervalMs = options.streamIntervalMs ?? 500;
	const context =
		options.context ?? createManagementContext({ hoboHome: options.hoboHome });

	// World read model (ADR: yard-world is the projection, control-api the host).
	const demo = options.demo ?? process.env.HOBO_CONTROL_DEMO === "1";
	const envSeed = Number(process.env.HOBO_CONTROL_DEMO_SEED);
	const demoSeed = demo
		? (options.demoSeed ?? (Number.isFinite(envSeed) ? envSeed : 42))
		: null;
	const demoIntervalMs = options.demoIntervalMs ?? 1000;
	const traceIndex = new TraceIndex();
	const worldSubscribers = new Set<(delta: WorldDelta) => void>();
	let world: WorldState = emptyWorld();
	let simulation: Simulation | null = null;
	if (demo) {
		simulation = createSimulation(demoSeed ?? 42);
		// The simulator pre-builds its topology (stations/yards/camps/characters)
		// in its own state; seed the read model from a clone so the reducer folds
		// events onto known characters.
		world = structuredClone(simulation.state);
	}

	function applyWorldEvents(events: readonly AgentEvent[]): void {
		if (events.length === 0) return;
		for (const event of events) world = applyEvent(world, event);
		const delta: WorldDelta = { events, tick: world.tick, demo };
		for (const notify of worldSubscribers) notify(delta);
	}

	function tickDemo(): number {
		if (simulation === null) return 0;
		const events = simulation.step();
		applyWorldEvents(events);
		return events.length;
	}

	const demoTimer =
		demo && demoIntervalMs > 0 ? setInterval(tickDemo, demoIntervalMs) : null;
	demoTimer?.unref();

	function worldEnvelope() {
		return { ok: true, data: { world, demo, seed: demoSeed } };
	}

	async function handleOtlpIngest(
		signal: "traces" | "logs" | "metrics",
		req: IncomingMessage,
		res: ServerResponse,
	): Promise<void> {
		// Ingest WRITES control-plane state that renders as real, unbadged
		// telemetry. A browser can issue a cross-origin POST without preflight
		// when the content type is "simple", so require the OTLP content type
		// and refuse any request carrying a browser Origin.
		const contentType = String(req.headers["content-type"] ?? "");
		if (!contentType.toLowerCase().includes("application/json")) {
			sendJson(res, 415, {
				ok: false,
				code: "unsupported-media-type",
				message: "OTLP/JSON ingest requires content-type: application/json",
			});
			return;
		}
		const origin = req.headers.origin;
		// oxlint-disable-next-line anti-slop/no-runtime-typeof -- SAFETY: Node's header union is normalized before the origin guard.
		if (typeof origin === "string" && origin.length > 0) {
			sendJson(res, 403, {
				ok: false,
				code: "cross-origin-write-refused",
				message:
					"OTLP ingest does not accept cross-origin requests; point your exporter at this endpoint directly",
			});
			return;
		}

		let body: JsonObject;
		try {
			body = await readJson(req);
		} catch (err) {
			const tooLarge = err instanceof PayloadTooLargeError;
			sendJson(res, tooLarge ? 413 : 400, {
				ok: false,
				code: tooLarge ? "payload-too-large" : "bad-request",
				message: tooLarge
					? `OTLP ${signal} payload exceeds ${MAX_BODY_BYTES} bytes`
					: `malformed OTLP/JSON ${signal} payload`,
			});
			return;
		}
		const now = Date.now();
		let events: ReturnType<typeof mapTracePayload>;
		try {
			// SAFETY: the route signal selects the matching OTLP request schema.
			events =
				signal === "traces"
					? mapTracePayload(body as OtlpTraceRequest, world, now, traceIndex)
					: signal === "logs"
						? mapLogsPayload(body as OtlpLogsRequest, world, now)
						: mapMetricsPayload(body as OtlpMetricsRequest, world, now);
		} catch (err) {
			// A shape the mapper did not expect is the caller's problem, not a
			// control-plane crash that silently drops the batch.
			sendJson(res, 400, {
				ok: false,
				code: "bad-request",
				// SAFETY: mapper failures are thrown Error instances by the yard-world adapters.
				message: `unmappable OTLP/JSON ${signal} payload: ${(err as Error).message}`,
			});
			return;
		}
		applyWorldEvents(events);
		sendJson(res, 200, { ok: true, data: { accepted: events.length, demo } });
	}

	function handleWorldSse(res: ServerResponse, intervalMs: number): void {
		res.writeHead(200, {
			"content-type": "text/event-stream; charset=utf-8",
			"cache-control": "no-cache, no-transform",
			connection: "keep-alive",
			"access-control-allow-origin": "*",
		});
		res.write(": control-api world stream\n\n");
		res.write(
			`event: world-snapshot\ndata: ${JSON.stringify({ world, demo, seed: demoSeed })}\n\n`,
		);
		const notify = (delta: WorldDelta) => {
			res.write(`event: world\ndata: ${JSON.stringify(delta)}\n\n`);
		};
		worldSubscribers.add(notify);
		const heartbeat = setInterval(() => {
			res.write(
				`event: heartbeat\ndata: ${JSON.stringify({ tick: world.tick, demo })}\n\n`,
			);
		}, intervalMs);
		res.on("close", () => {
			worldSubscribers.delete(notify);
			clearInterval(heartbeat);
		});
	}

	const server = createServer(async (req, res) => {
		try {
			if (!req.url || !req.method) {
				sendJson(res, 400, {
					ok: false,
					code: "bad-request",
					message: "missing url",
				});
				return;
			}
			if (req.method === "OPTIONS") {
				res.writeHead(204, {
					"access-control-allow-origin": "*",
					"access-control-allow-headers":
						"content-type, x-hobo-principal, x-hobo-tenant",
					"access-control-allow-methods": "GET, POST, OPTIONS",
				});
				res.end();
				return;
			}

			const url = new URL(req.url, `http://${host}`);
			const path = url.pathname;
			const q = queryOf(url);

			// Health
			if (req.method === "GET" && path === "/health") {
				sendJson(res, 200, { ok: true, service: "@hobo/control-api" });
				return;
			}

			// OpenAPI-ish surface description (plus the mounted CD routes).
			if (req.method === "GET" && path === "/v1/openapi.json") {
				sendJson(
					res,
					200,
					// SAFETY: both OpenAPI documents are JSON literals (no functions, no bigints).
					mergeOpenApi(
						controlApiOpenApi(),
						options.cd?.openapi?.(),
					) as JsonObject,
				);
				return;
			}

			// CD read API, SSE stream and delivery feed (plan 0024 WP12).
			if (options.cd && path.startsWith(options.cd.pathPrefix)) {
				await handleCd(options.cd, req, res);
				return;
			}

			if (req.method === "GET" && path === "/v1/yard/stream") {
				handleYardSse(res, context, q, streamIntervalMs);
				return;
			}

			// World read model (fed by OTLP ingest and/or the demo simulator).
			if (req.method === "GET" && path === "/v1/world/snapshot") {
				sendJson(res, 200, worldEnvelope());
				return;
			}
			if (req.method === "GET" && path === "/v1/world/stream") {
				handleWorldSse(res, streamIntervalMs);
				return;
			}
			const otlp = path.match(/^\/v1\/otlp\/v1\/(traces|logs|metrics)$/);
			if (req.method === "POST" && otlp) {
				await handleOtlpIngest(
					// SAFETY: the route regexp contains exactly the three OTLP signal literals.
					otlp[1] as "traces" | "logs" | "metrics",
					req,
					res,
				);
				return;
			}

			const result = await dispatch(req.method, path, q, req, context);
			if (result === null) {
				sendJson(res, 404, {
					ok: false,
					code: "not-found",
					message: `no route ${req.method} ${path}`,
				});
				return;
			}
			sendJson(res, result.ok ? 200 : 400, result);
		} catch (err) {
			sendJson(res, 500, {
				ok: false,
				code: "internal",
				message: err instanceof Error ? err.message : String(err),
			});
		}
	});

	await new Promise<void>((resolve) => {
		server.listen(port, host, () => resolve());
	});
	const address = server.address();
	// oxlint-disable-next-line anti-slop/no-runtime-typeof -- SAFETY: Node returns a string for pipe servers and an AddressInfo for TCP servers.
	if (!address || typeof address === "string") {
		throw new Error("control-api failed to bind");
	}

	return {
		server,
		host,
		port: address.port,
		url: `http://${host}:${address.port}`,
		context,
		demo,
		demoSeed,
		tickDemo,
		worldSnapshot: () => world,
		close: () => {
			if (demoTimer !== null) clearInterval(demoTimer);
			return new Promise((resolve, reject) => {
				server.close((err) => (err ? reject(err) : resolve()));
			});
		},
	};
}

async function dispatch(
	method: string,
	path: string,
	q: Record<string, string>,
	req: IncomingMessage,
	ctx: ManagementContext,
): Promise<ManagementResult | null> {
	const body = method === "POST" || method === "PUT" ? await readJson(req) : {};

	if (method === "POST" && path === "/v1/station/init") {
		return stationInit(
			ctx,
			opt({
				name: str(body.name),
				id: str(body.id),
				tenant: str(body.tenant),
			}),
		);
	}
	if (method === "POST" && path === "/v1/station/up") {
		return stationUp(ctx, str(body.stationId) ?? q.stationId);
	}
	if (method === "POST" && path === "/v1/station/down") {
		return stationDown(ctx, str(body.stationId) ?? q.stationId);
	}
	if (method === "GET" && path === "/v1/station/status") {
		return stationStatus(ctx, q.stationId);
	}
	if (method === "GET" && path === "/v1/station/rails") {
		return stationRailsList(ctx, q.stationId);
	}
	if (method === "POST" && path === "/v1/station/rails/publish") {
		return stationRailsPublish(
			ctx,
			opt({
				stationId: str(body.stationId),
				id: str(body.id),
				name: str(body.name),
				version: str(body.version),
				docPath: str(body.docPath),
				// SAFETY: the management adapter accepts the JSON object from the request body.
				raw: body.raw as JsonObject | undefined,
			}),
		);
	}
	if (method === "POST" && path === "/v1/station/rails/approve") {
		return stationRailsApprove(
			ctx,
			opt({
				stationId: str(body.stationId),
				hashOrId: String(body.hashOrId ?? ""),
			}),
		);
	}
	if (method === "POST" && path === "/v1/station/rails/activate") {
		return stationRailsActivate(
			ctx,
			opt({
				stationId: str(body.stationId),
				hashOrId: String(body.hashOrId ?? ""),
			}),
		);
	}
	if (method === "POST" && path === "/v1/connection/create") {
		const scopesRaw = body.scopes;
		// oxlint-disable-next-line anti-slop/no-runtime-typeof -- SAFETY: parsed JSON is normalized to a string or string array here.
		const scopes = Array.isArray(scopesRaw)
			? scopesRaw.map(String)
			: isStringValue(scopesRaw)
				? scopesRaw
						.split(",")
						.map((s) => s.trim())
						.filter(Boolean)
				: undefined;
		return connectionCreate(
			ctx,
			// SAFETY: opt removes undefined keys and this route supplies the create contract.
			opt({
				provider: String(body.provider ?? ""),
				stationId: str(body.stationId),
				alias: str(body.alias),
				scopes,
				flow: str(body.flow),
				tenant: str(body.tenant),
			}) as Parameters<typeof connectionCreate>[1],
		);
	}
	if (method === "POST" && path === "/v1/connection/authorize") {
		return connectionAuthorize(
			ctx,
			// SAFETY: opt removes undefined keys and this route supplies the authorize contract.
			opt({
				idOrAlias: String(body.idOrAlias ?? body.id ?? ""),
				tenant: str(body.tenant),
				grantedScopes: Array.isArray(body.grantedScopes)
					? body.grantedScopes.map(String)
					: undefined,
				installationId: str(body.installationId),
			}) as Parameters<typeof connectionAuthorize>[1],
		);
	}
	if (method === "GET" && path === "/v1/connection") {
		return connectionList(
			ctx,
			opt({
				tenant: q.tenant,
				provider: q.provider,
				status: q.status,
				subjectId: q.subjectId,
			}),
		);
	}
	const connGet = path.match(/^\/v1\/connection\/([^/]+)$/);
	if (method === "GET" && connGet) {
		return connectionGet(
			ctx,
			// SAFETY: the route parameter and query are parsed at the HTTP boundary.
			opt({
				idOrAlias: decodeURIComponent(pathParam(connGet)),
				tenant: q.tenant,
			}) as Parameters<typeof connectionGet>[1],
		);
	}
	const connRevoke = path.match(/^\/v1\/connection\/([^/]+)\/revoke$/);
	if (method === "POST" && connRevoke) {
		return connectionRevoke(
			ctx,
			// SAFETY: the route parameter and request body are parsed at the HTTP boundary.
			opt({
				idOrAlias: decodeURIComponent(pathParam(connRevoke)),
				tenant: str(body.tenant) ?? q.tenant,
				reason: str(body.reason),
			}) as Parameters<typeof connectionRevoke>[1],
		);
	}
	const connRotate = path.match(/^\/v1\/connection\/([^/]+)\/rotate$/);
	if (method === "POST" && connRotate) {
		return connectionRotate(
			ctx,
			// SAFETY: the route parameter and request body are parsed at the HTTP boundary.
			opt({
				idOrAlias: decodeURIComponent(pathParam(connRotate)),
				tenant: str(body.tenant) ?? q.tenant,
			}) as Parameters<typeof connectionRotate>[1],
		);
	}
	if (method === "GET" && path === "/v1/broker/status") {
		return brokerStatus(ctx, opt({ stationId: q.stationId }));
	}
	if (method === "GET" && path === "/v1/doctor") {
		return doctorSnapshot(ctx, opt({ stationId: q.stationId }));
	}
	if (method === "GET" && path === "/v1/yard/snapshot") {
		return projectYardSnapshot(
			ctx,
			opt({
				stationId: q.stationId,
				tenant: q.tenant,
			}),
		);
	}
	// Deployment saga view (@hobo/cloud DeploymentView projection folded from
	// the local yard event store; honest empty view when no source exists).
	if (method === "GET" && path === "/v1/deployments/view") {
		return projectDeploymentView(ctx, opt({ yard: q.yard }));
	}
	// Credential audit (grant -> use -> revoke per correlation, folded from the
	// local connection store + yard event stores).
	if (method === "GET" && path === "/v1/audit/credentials") {
		return projectCredentialAudit(ctx, opt({ tenant: q.tenant, yard: q.yard }));
	}
	return null;
}

function handleYardSse(
	res: ServerResponse,
	ctx: ManagementContext,
	q: Record<string, string>,
	intervalMs: number,
): void {
	res.writeHead(200, {
		"content-type": "text/event-stream; charset=utf-8",
		"cache-control": "no-cache, no-transform",
		connection: "keep-alive",
		"access-control-allow-origin": "*",
	});
	res.write(": control-api yard stream\n\n");

	let lastSeq = -1;
	const tick = () => {
		const snap = projectYardSnapshot(
			ctx,
			opt({
				stationId: q.stationId,
				tenant: q.tenant,
			}),
		);
		if (!snap.ok || !snap.data) {
			res.write(
				`event: error\ndata: ${JSON.stringify({ message: snap.message, code: snap.code })}\n\n`,
			);
			return;
		}
		if (snap.data.seq !== lastSeq) {
			lastSeq = snap.data.seq;
			res.write(`event: yard\ndata: ${JSON.stringify(snap.data)}\n\n`);
		} else {
			res.write(
				`event: heartbeat\ndata: ${JSON.stringify({ seq: lastSeq })}\n\n`,
			);
		}
	};
	tick();
	const timer = setInterval(tick, intervalMs);
	res.on("close", () => clearInterval(timer));
}

function isStringValue(v: JsonValue | undefined): v is string {
	return Object.prototype.toString.call(v) === "[object String]";
}

function str(v: JsonValue | undefined): string | undefined {
	return isStringValue(v) && v.length > 0 ? v : undefined;
}

/** exactOptionalPropertyTypes-safe: drop undefined values. */
function opt<T extends object>(
	obj: T,
): {
	[K in keyof T as T[K] extends undefined ? never : K]: Exclude<
		T[K],
		undefined
	>;
} {
	// SAFETY: undefined-valued keys are removed before the mapped return type is exposed.
	return Object.fromEntries(
		Object.entries(obj).filter(([, value]) => value !== undefined),
	) as never;
}

/** Read a request body as raw bytes; undefined when it exceeds MAX_BODY_BYTES (the rest is drained, not buffered). */
async function readRaw(req: IncomingMessage): Promise<Uint8Array | undefined> {
	const chunks: Buffer[] = [];
	let size = 0;
	let tooLarge = false;
	for await (const chunk of req) {
		const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		size += buf.length;
		if (size > MAX_BODY_BYTES) tooLarge = true;
		if (!tooLarge) chunks.push(buf);
	}
	return tooLarge ? undefined : new Uint8Array(Buffer.concat(chunks));
}

function lowerHeaders(req: IncomingMessage): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [name, value] of Object.entries(req.headers)) {
		if (value === undefined) continue;
		out[name.toLowerCase()] = Array.isArray(value) ? value.join(", ") : value;
	}
	return out;
}

function isBytes(body: CdHttpResponse["body"]): body is Uint8Array {
	return body instanceof Uint8Array;
}

/** Adapt one Node request to the mounted CD handler and stream its response back. */
async function handleCd(
	mount: CdHttpMount,
	req: IncomingMessage,
	res: ServerResponse,
): Promise<void> {
	const body = await readRaw(req);
	if (body === undefined) {
		sendJson(res, 413, {
			ok: false,
			code: "payload-too-large",
			message: `request body exceeds ${MAX_BODY_BYTES} bytes`,
		});
		return;
	}
	// A client that goes away aborts the handler (long-polls, SSE streams).
	const controller = new AbortController();
	res.on("close", () => controller.abort());
	const response = await mount.handle(
		{
			method: req.method ?? "GET",
			path: req.url ?? "/",
			headers: lowerHeaders(req),
			body,
		},
		controller.signal,
	);
	res.writeHead(response.status, {
		"access-control-allow-origin": "*",
		...response.headers,
	});
	if (isBytes(response.body)) {
		res.end(Buffer.from(response.body));
		return;
	}
	res.flushHeaders();
	try {
		for await (const chunk of response.body) {
			if (controller.signal.aborted) break;
			res.write(Buffer.from(chunk));
		}
	} catch {
		// Headers are already sent, so a producer failure can only end the
		// stream; the client resumes with Last-Event-ID.
	} finally {
		res.end();
	}
}

type OpenApiDoc = Readonly<Record<string, unknown>>;

function objectAt(
	doc: OpenApiDoc | undefined,
	key: string,
): Record<string, unknown> {
	const value = doc?.[key];
	return value !== null &&
		Object.prototype.toString.call(value) === "[object Object]"
		? // SAFETY: the guard above proves the value is a plain JSON object.
			(value as Record<string, unknown>)
		: {};
}

/** Merge a mounted surface's paths and component schemas into the control API document. */
function mergeOpenApi(
	base: OpenApiDoc,
	mounted: OpenApiDoc | undefined,
): OpenApiDoc {
	if (!mounted) return base;
	const schemas = objectAt(objectAt(mounted, "components"), "schemas");
	return {
		...base,
		paths: { ...objectAt(base, "paths"), ...objectAt(mounted, "paths") },
		components: {
			...objectAt(base, "components"),
			schemas: {
				...objectAt(objectAt(base, "components"), "schemas"),
				...schemas,
			},
		},
	};
}

function controlApiOpenApi() {
	return {
		openapi: "3.0.3",
		info: {
			title: "HoBo Control API",
			version: "0.1.0",
			description:
				"Local-first control-plane HTTP+SSE surface over @hobo/management (ADR-0135).",
		},
		paths: {
			"/v1/station/init": { post: { summary: "station init" } },
			"/v1/station/up": { post: { summary: "station up" } },
			"/v1/station/down": { post: { summary: "station down" } },
			"/v1/station/status": { get: { summary: "station status" } },
			"/v1/station/rails": { get: { summary: "rails list" } },
			"/v1/station/rails/publish": { post: { summary: "rails publish" } },
			"/v1/station/rails/approve": { post: { summary: "rails approve" } },
			"/v1/station/rails/activate": { post: { summary: "rails activate" } },
			"/v1/connection/create": { post: { summary: "connection create" } },
			"/v1/connection/authorize": { post: { summary: "connection authorize" } },
			"/v1/connection": { get: { summary: "connection list" } },
			"/v1/broker/status": { get: { summary: "broker status" } },
			"/v1/doctor": { get: { summary: "doctor" } },
			"/v1/yard/snapshot": { get: { summary: "yard projection snapshot" } },
			"/v1/yard/stream": { get: { summary: "yard projection SSE" } },
			"/v1/deployments/view": {
				get: { summary: "deployment saga view (DeploymentView projection)" },
			},
			"/v1/audit/credentials": {
				get: { summary: "credential audit projection (grant/use/revoke)" },
			},
			"/v1/world/snapshot": {
				get: { summary: "yard-world read-model snapshot (demo-labeled)" },
			},
			"/v1/world/stream": {
				get: { summary: "yard-world SSE (world-snapshot, then world deltas)" },
			},
			"/v1/otlp/v1/traces": {
				post: { summary: "OTLP/HTTP JSON trace ingest" },
			},
			"/v1/otlp/v1/logs": { post: { summary: "OTLP/HTTP JSON logs ingest" } },
			"/v1/otlp/v1/metrics": {
				post: { summary: "OTLP/HTTP JSON metrics ingest" },
			},
		},
	};
}
