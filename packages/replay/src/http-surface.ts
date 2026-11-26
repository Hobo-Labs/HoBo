/**
 * HTTP-shaped accessibility surface for Session Replay boundaries (ADR-0137).
 *
 * Every internal integration boundary is reachable here so PACT consumer/provider
 * verification can drive real package code without a live network stack.
 *
 * Path taxonomy (all under /replay/...):
 * - /replay/sessions/:id/chunks          tracker → ingest
 * - /replay/sessions/:id                 player → index get
 * - /replay/sessions                     player/CLI → index list
 * - /replay/sessions/:id/open            player → store open
 * - /replay/sessions/:id/summarize       CLI → service summarize
 * - /replay/privacy/mask                 tracker → privacy
 * - /replay/policy/evaluate              tracker → policy/harness
 * - /replay/access/evaluate              player → PAM access
 * - /replay/retention/apply              service → retention/trails
 * - /replay/metering/record              service → finops metering
 * - /replay/evidence/pack                evidence → service
 * - /replay/correlation/build            tracker → correlation
 * - /replay/events/emit                  service → lifecycle events
 * - /replay/blobs                        ingest → blob store
 * - /replay/bindle/wrap-html             bindle host → bootstrap inject
 * - /replay/doctor                       CLI → doctor
 */
import { evaluateReplayAccess } from "./access.js";
import { SESSION_REPLAY_PATH_PREFIX } from "./bindle-integration.js";
import { injectSessionReplayBootstrap } from "./browser-bootstrap.js";
import { buildCorrelation } from "./correlation.js";
import { createReplayEvent, REPLAY_EVENTS } from "./events.js";
import { buildEvidencePack } from "./evidence.js";
import {
	createMemoryMeterSink,
	meterIngest,
	meterPlayerAccess,
} from "./metering.js";
import { loadPlayerPayload, summarizeSession } from "./player.js";
import { evaluateRecordingPolicy, REPLAY_ENV_KILL } from "./policy.js";
import {
	assertNoSensitivePlaintext,
	defaultPrivacyPolicy,
	maskRrwebEvents,
} from "./privacy.js";
import { applyRetention } from "./retention.js";
import { createReplayService } from "./service.js";
import { createMemoryDualFixtures, type DualFixtureStore } from "./storage.js";
import {
	parseSessionRecord,
	REPLAY_SCHEMA_VERSION,
	type RrwebEvent,
	type SessionRecord,
} from "./types.js";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export type ReplayHttpRequest = Readonly<{
	method: HttpMethod;
	path: string;
	headers?: Readonly<Record<string, string>>;
	body?: unknown;
}>;

export type ReplayHttpResponse = Readonly<{
	status: number;
	headers?: Readonly<Record<string, string>>;
	body?: unknown;
}>;

export type ReplayHttpSurface = Readonly<{
	/** Provider identity for PACT verification. */
	name: string;
	handle: (request: ReplayHttpRequest) => Promise<ReplayHttpResponse>;
	store: DualFixtureStore;
	/** Enumerate every boundary route for doctor/docs. */
	listBoundaries: () => readonly ReplayBoundaryDescriptor[];
}>;

export type ReplayBoundaryDescriptor = Readonly<{
	id: string;
	consumer: string;
	provider: string;
	path: string;
	method: HttpMethod;
	internal: boolean;
}>;

// public-contract: catalog of Session Replay integration boundaries.
export const REPLAY_BOUNDARIES: readonly ReplayBoundaryDescriptor[] =
	Object.freeze([
		Object.freeze({
			id: "tracker-ingest",
			consumer: "ReplayTracker",
			provider: "ReplayIngest",
			path: "/replay/sessions/:id/chunks",
			method: "POST" as const,
			internal: true,
		}),
		Object.freeze({
			id: "player-store-get",
			consumer: "ReplayPlayer",
			provider: "ReplaySessionIndex",
			path: "/replay/sessions/:id",
			method: "GET" as const,
			internal: true,
		}),
		Object.freeze({
			id: "player-store-list",
			consumer: "ReplayPlayer",
			provider: "ReplaySessionIndex",
			path: "/replay/sessions",
			method: "GET" as const,
			internal: true,
		}),
		Object.freeze({
			id: "player-open",
			consumer: "ReplayPlayer",
			provider: "ReplaySessionIndex",
			path: "/replay/sessions/:id/open",
			method: "GET" as const,
			internal: true,
		}),
		Object.freeze({
			id: "cli-summarize",
			consumer: "HoboReplayCli",
			provider: "ReplayService",
			path: "/replay/sessions/:id/summarize",
			method: "GET" as const,
			internal: false,
		}),
		Object.freeze({
			id: "privacy-mask",
			consumer: "ReplayTracker",
			provider: "ReplayPrivacy",
			path: "/replay/privacy/mask",
			method: "POST" as const,
			internal: true,
		}),
		Object.freeze({
			id: "policy-evaluate",
			consumer: "ReplayTracker",
			provider: "ReplayPolicy",
			path: "/replay/policy/evaluate",
			method: "POST" as const,
			internal: true,
		}),
		Object.freeze({
			id: "access-evaluate",
			consumer: "ReplayPlayer",
			provider: "ReplayAccess",
			path: "/replay/access/evaluate",
			method: "POST" as const,
			internal: true,
		}),
		Object.freeze({
			id: "retention-apply",
			consumer: "ReplayService",
			provider: "ReplayRetention",
			path: "/replay/retention/apply",
			method: "POST" as const,
			internal: true,
		}),
		Object.freeze({
			id: "metering-record",
			consumer: "ReplayService",
			provider: "ReplayMetering",
			path: "/replay/metering/record",
			method: "POST" as const,
			internal: true,
		}),
		Object.freeze({
			id: "evidence-pack",
			consumer: "ReplayEvidence",
			provider: "ReplayService",
			path: "/replay/evidence/pack",
			method: "POST" as const,
			internal: true,
		}),
		Object.freeze({
			id: "correlation-build",
			consumer: "ReplayTracker",
			provider: "ReplayCorrelation",
			path: "/replay/correlation/build",
			method: "POST" as const,
			internal: true,
		}),
		Object.freeze({
			id: "events-emit",
			consumer: "ReplayService",
			provider: "ReplayEventLog",
			path: "/replay/events/emit",
			method: "POST" as const,
			internal: true,
		}),
		Object.freeze({
			id: "blob-put",
			consumer: "ReplayIngest",
			provider: "ReplayBlobStore",
			path: "/replay/blobs",
			method: "POST" as const,
			internal: true,
		}),
		Object.freeze({
			id: "bindle-wrap-html",
			consumer: "BindleWebHost",
			provider: "ReplayHttpSurface",
			path: "/replay/bindle/wrap-html",
			method: "POST" as const,
			internal: true,
		}),
		Object.freeze({
			id: "doctor",
			consumer: "HoboReplayCli",
			provider: "ReplayService",
			path: "/replay/doctor",
			method: "GET" as const,
			internal: false,
		}),
	]);

export function createReplayHttpSurface(input?: {
	readonly stationId?: string;
	readonly store?: DualFixtureStore;
	/** Provider name presented to PACT verification (default ReplayHttpSurface). */
	readonly name?: string;
}): ReplayHttpSurface {
	const stationId = input?.stationId ?? "station:local";
	const store = input?.store ?? createMemoryDualFixtures();
	const service = createReplayService({ stationId, memory: true });
	// Share the dual-fixture store with the service by overwriting via direct use.
	const sharedStore = store;
	const meter = createMemoryMeterSink();
	const providerName = input?.name ?? "ReplayHttpSurface";

	const handle = async (
		request: ReplayHttpRequest,
	): Promise<ReplayHttpResponse> => {
		const headers = normalizeHeaders(request.headers);
		const path = request.path.split("?")[0] ?? request.path;
		const query = new URL(request.path, "http://replay.local").searchParams;

		// Kill switch for ingest-like routes.
		const kill =
			headers["x-hobo-replay"] === "0" || headers["x-hobo-replay"] === "false";

		if (request.method === "POST" && matchChunks(path)) {
			if (kill) {
				return json(204, { ok: true, disabled: true });
			}
			const sessionId = path.split("/")[3] ?? "sess-unknown";
			const body = (request.body ?? {}) as {
				seq?: number;
				events?: RrwebEvent[];
			};
			const events = maskRrwebEvents(
				Array.isArray(body.events) ? body.events : [],
			);
			assertNoSensitivePlaintext(JSON.stringify(events));
			const chunk = await sharedStore.blobs.put(
				sessionId,
				body.seq ?? 0,
				events,
			);
			const existing = await sharedStore.index.get(sessionId);
			const record = parseSessionRecord({
				id: sessionId,
				status: "recording",
				startedAt: existing?.startedAt ?? new Date().toISOString(),
				correlation: {
					stationId: headers["x-hobo-station"] ?? stationId,
					tenant: "local",
					env: "local-dev",
					isolationClass: "local-dev",
					harnessFlagKeys: ["hobo.session-replay"],
				},
				privacy: defaultPrivacyPolicy(),
				chunkCount: (existing?.chunkCount ?? 0) + 1,
				totalBytes: (existing?.totalBytes ?? 0) + chunk.byteSize,
			});
			await sharedStore.index.upsert(record);
			return json(202, {
				ok: true,
				sessionId,
				chunkSeq: chunk.seq,
				blobRef: chunk.blobRef,
				contentHash: chunk.contentHash,
			});
		}

		if (request.method === "GET" && path === "/replay/sessions") {
			const errorId = query.get("errorId") ?? undefined;
			const trailId = query.get("trailId") ?? undefined;
			const sessions = await sharedStore.index.list({
				stationId: headers["x-hobo-station"] ?? stationId,
				...(errorId !== undefined ? { errorId } : {}),
				...(trailId !== undefined ? { trailId } : {}),
			});
			return json(200, {
				sessions: sessions.map((s) => ({
					id: s.id,
					errorId: s.correlation.errorId,
					summary: s.summary,
					status: s.status,
					stationId: s.correlation.stationId,
					chunkCount: s.chunkCount,
				})),
			});
		}

		if (request.method === "GET" && matchSessionGet(path)) {
			const sessionId = path.split("/")[3] ?? "";
			const session = await sharedStore.index.get(sessionId);
			if (!session) {
				return json(404, { ok: false, code: "REPLAY_NOT_FOUND" });
			}
			const viewer = headers["x-hobo-station"] ?? stationId;
			if (session.correlation.stationId !== viewer) {
				return json(403, { ok: false, code: "REPLAY_STATION_BOUNDARY" });
			}
			return json(200, {
				id: session.id,
				status: session.status,
				stationId: session.correlation.stationId,
				chunkCount: session.chunkCount,
			});
		}

		if (request.method === "GET" && matchOpen(path)) {
			const sessionId = path.split("/")[3] ?? "";
			const session = await sharedStore.index.get(sessionId);
			if (!session) {
				return json(404, { ok: false, code: "REPLAY_NOT_FOUND" });
			}
			const viewer = headers["x-hobo-station"] ?? stationId;
			const access = evaluateReplayAccess({
				session,
				viewerStationId: viewer,
			});
			if (!access.allowed) {
				return json(403, {
					ok: false,
					code: "REPLAY_ACCESS_DENIED",
					reason: access.reason,
				});
			}
			const payload = await loadPlayerPayload({
				sessionId,
				index: sharedStore.index,
				blobs: sharedStore.blobs,
				stationId: viewer,
				blobRefs: [],
			});
			return json(200, {
				ok: true,
				sessionId,
				deepLink: payload.deepLink,
				openUi: payload.openUi,
				summary: summarizeSession(session),
			});
		}

		if (request.method === "GET" && matchSummarize(path)) {
			const sessionId = path.split("/")[3] ?? "";
			const session = await sharedStore.index.get(sessionId);
			if (!session) {
				return json(404, { ok: false, code: "REPLAY_NOT_FOUND" });
			}
			return json(200, {
				ok: true,
				sessionId,
				summary: summarizeSession(session),
			});
		}

		if (request.method === "POST" && path === "/replay/privacy/mask") {
			const body = (request.body ?? {}) as {
				events?: RrwebEvent[];
			};
			const masked = maskRrwebEvents(body.events ?? []);
			const blob = JSON.stringify(masked);
			assertNoSensitivePlaintext(blob);
			return json(200, {
				ok: true,
				eventCount: masked.length,
				containsSensitivePlaintext: false,
			});
		}

		if (request.method === "POST" && path === "/replay/policy/evaluate") {
			const body = (request.body ?? {}) as {
				env?: Record<string, string>;
				isolationClass?: string;
				flagEnabled?: boolean;
			};
			const decision = evaluateRecordingPolicy({
				env: body.env ?? {},
				...(body.isolationClass !== undefined
					? { isolationClass: body.isolationClass }
					: {}),
				...(body.flagEnabled !== undefined
					? { flagEnabled: body.flagEnabled }
					: {}),
			});
			return json(200, {
				enabled: decision.enabled,
				reason: decision.reason,
				sampleRate: decision.sampleRate,
				killEnv: REPLAY_ENV_KILL,
			});
		}

		if (request.method === "POST" && path === "/replay/access/evaluate") {
			const body = (request.body ?? {}) as {
				session?: SessionRecord;
				viewerStationId?: string;
				elevated?: boolean;
			};
			const session =
				body.session ??
				parseSessionRecord({
					id: "sess-1",
					status: "ended",
					startedAt: "2026-01-01T00:00:00.000Z",
					correlation: {
						stationId: stationId,
						tenant: "local",
						env: "local-dev",
						isolationClass: "local-dev",
						harnessFlagKeys: [],
					},
					privacy: defaultPrivacyPolicy(),
					chunkCount: 0,
					totalBytes: 0,
				});
			const access = evaluateReplayAccess({
				session,
				viewerStationId: body.viewerStationId ?? stationId,
				...(body.elevated
					? {
							elevatedCapability: {
								scope: "replay.view" as const,
								stationId: body.viewerStationId ?? stationId,
								expiresAt: "2099-01-01T00:00:00.000Z",
							},
						}
					: {}),
			});
			return json(200, {
				allowed: access.allowed,
				reason: access.reason,
				elevated: access.audit.elevated,
			});
		}

		if (request.method === "POST" && path === "/replay/retention/apply") {
			const result = await applyRetention({
				index: sharedStore.index,
				stationId,
				policy: { maxAgeDays: 30, eraseOnRequest: true },
				now: new Date("2026-01-01T00:00:00.000Z"),
			});
			return json(200, {
				ok: true,
				scanned: result.scanned,
				erased: result.erased,
				retained: result.retained,
				recipe: "replay.retention",
			});
		}

		if (request.method === "POST" && path === "/replay/metering/record") {
			const body = (request.body ?? {}) as {
				kind?: "ingest-bytes" | "player-access";
				sessionId?: string;
				bytes?: number;
			};
			if (body.kind === "player-access") {
				meterPlayerAccess(meter, {
					sessionId: body.sessionId ?? "sess-1",
					stationId,
					tenant: "local",
				});
			} else {
				meterIngest(meter, {
					sessionId: body.sessionId ?? "sess-1",
					stationId,
					tenant: "local",
					bytes: body.bytes ?? 0,
				});
			}
			return json(200, {
				ok: true,
				recorded: meter.events.length,
				lastKind: meter.events[meter.events.length - 1]?.kind,
			});
		}

		if (request.method === "POST" && path === "/replay/evidence/pack") {
			const body = (request.body ?? {}) as {
				sessionId?: string;
				events?: RrwebEvent[];
				playwrightRefs?: string[];
			};
			const session =
				(body.sessionId
					? await sharedStore.index.get(body.sessionId)
					: undefined) ??
				parseSessionRecord({
					id: body.sessionId ?? "sess-evidence-1",
					status: "ended",
					startedAt: "2026-01-01T00:00:00.000Z",
					endedAt: "2026-01-01T00:01:00.000Z",
					correlation: {
						stationId,
						tenant: "local",
						env: "local-dev",
						isolationClass: "local-dev",
						harnessFlagKeys: [],
					},
					privacy: defaultPrivacyPolicy(),
					chunkCount: 1,
					totalBytes: 10,
				});
			const pack = buildEvidencePack({
				session,
				recording: body.events ?? [],
				playwrightRefs: body.playwrightRefs ?? ["trace.zip"],
			});
			return json(200, {
				ok: true,
				schemaVersion: pack.schemaVersion,
				sessionId: pack.session.id,
				playwrightRefs: pack.playwrightRefs,
				assertionCount: pack.assertionLog.length,
			});
		}

		if (request.method === "POST" && path === "/replay/correlation/build") {
			const body = (request.body ?? {}) as {
				stationId?: string;
				principalRef?: string;
				errorId?: string;
				trailId?: string;
				harnessFlagKeys?: string[];
			};
			const corr = buildCorrelation({
				stationId: body.stationId ?? stationId,
				...(body.principalRef !== undefined
					? { principalRef: body.principalRef }
					: {}),
				...(body.errorId !== undefined ? { errorId: body.errorId } : {}),
				...(body.trailId !== undefined ? { trailId: body.trailId } : {}),
				harnessFlagKeys: body.harnessFlagKeys ?? [],
			});
			return json(200, {
				ok: true,
				stationId: corr.stationId,
				principalRef: corr.principalRef,
				errorId: corr.errorId,
				trailId: corr.trailId,
				harnessFlagKeys: corr.harnessFlagKeys,
				schemaVersion: corr.schemaVersion,
			});
		}

		if (request.method === "POST" && path === "/replay/events/emit") {
			const body = (request.body ?? {}) as {
				type?: string;
				sessionId?: string;
				blobRef?: string;
				bytes?: number;
			};
			const type =
				body.type === "replay.Ended"
					? REPLAY_EVENTS.Ended
					: body.type === "replay.ErrorLinked"
						? REPLAY_EVENTS.ErrorLinked
						: REPLAY_EVENTS.ChunkIngested;
			const evt = createReplayEvent(type, {
				sessionId: body.sessionId ?? "sess-1",
				stationId,
				seq: 0,
				data: {
					...(body.blobRef !== undefined ? { blobRef: body.blobRef } : {}),
					...(body.bytes !== undefined ? { bytes: body.bytes } : {}),
				},
			});
			return json(200, {
				ok: true,
				id: evt.id,
				type: evt.type,
				sessionId: evt.sessionId,
				schemaVersion: evt.schemaVersion,
			});
		}

		if (request.method === "POST" && path === "/replay/blobs") {
			const body = (request.body ?? {}) as {
				sessionId?: string;
				seq?: number;
				events?: RrwebEvent[];
			};
			const chunk = await sharedStore.blobs.put(
				body.sessionId ?? "sess-1",
				body.seq ?? 0,
				body.events ?? [],
			);
			return json(201, {
				ok: true,
				blobRef: chunk.blobRef,
				contentHash: chunk.contentHash,
				byteSize: chunk.byteSize,
				schemaVersion: REPLAY_SCHEMA_VERSION,
			});
		}

		if (request.method === "POST" && path === "/replay/bindle/wrap-html") {
			const body = (request.body ?? {}) as {
				html?: string;
				bindleName?: string;
				resourceName?: string;
			};
			const html = body.html ?? "<html><body>app</body></html>";
			const injected = injectSessionReplayBootstrap(html, {
				sessionId: "sess-wrap-1",
				stationId,
				bindleName: body.bindleName ?? "app",
				resourceName: body.resourceName ?? "web",
				ingestPath: `${SESSION_REPLAY_PATH_PREFIX}/ingest`,
				enabled: true,
			});
			return json(200, {
				ok: true,
				injected: injected.includes('data-hobo-replay="1"'),
				pathPrefix: SESSION_REPLAY_PATH_PREFIX,
			});
		}

		if (request.method === "GET" && path === "/replay/doctor") {
			const doc = service.doctor();
			return json(200, {
				ok: true,
				package: doc.package,
				stationId: doc.stationId,
				defaultLocalOn: doc.defaultLocalOn,
				killEnv: doc.killEnv,
				boundaries: REPLAY_BOUNDARIES.map((b) => b.id),
				honestScope: doc.honestScope,
			});
		}

		return json(404, { ok: false, code: "REPLAY_ROUTE_NOT_FOUND", path });
	};

	return Object.freeze({
		name: providerName,
		handle,
		store: sharedStore,
		listBoundaries: () => REPLAY_BOUNDARIES,
	});
}

/**
 * Seed a dual-fixture store with a known session for provider verification.
 */
export async function seedReplayFixture(
	store: DualFixtureStore,
	input?: {
		readonly sessionId?: string;
		readonly stationId?: string;
		readonly errorId?: string;
	},
): Promise<SessionRecord> {
	const sessionId = input?.sessionId ?? "sess-local-1";
	const stationId = input?.stationId ?? "station:local";
	const chunk = await store.blobs.put(sessionId, 0, [
		{ type: 2, timestamp: 1, data: { tagName: "div" } },
	]);
	const record = parseSessionRecord({
		id: sessionId,
		status: "ended",
		startedAt: "2026-01-01T00:00:00.000Z",
		endedAt: "2026-01-01T00:01:00.000Z",
		correlation: {
			stationId,
			tenant: "local",
			env: "local-dev",
			isolationClass: "local-dev",
			harnessFlagKeys: ["hobo.session-replay"],
			...(input?.errorId !== undefined ? { errorId: input.errorId } : {}),
		},
		privacy: defaultPrivacyPolicy(),
		chunkCount: 1,
		totalBytes: chunk.byteSize,
		summary: "checkout failed",
	});
	await store.index.upsert(record);
	return record;
}

function matchChunks(path: string): boolean {
	return /^\/replay\/sessions\/[^/]+\/chunks$/.test(path);
}
function matchSessionGet(path: string): boolean {
	return (
		/^\/replay\/sessions\/[^/]+$/.test(path) &&
		!path.endsWith("/open") &&
		!path.endsWith("/summarize") &&
		!path.endsWith("/chunks")
	);
}
function matchOpen(path: string): boolean {
	return /^\/replay\/sessions\/[^/]+\/open$/.test(path);
}
function matchSummarize(path: string): boolean {
	return /^\/replay\/sessions\/[^/]+\/summarize$/.test(path);
}

function normalizeHeaders(
	headers?: Readonly<Record<string, string>>,
): Record<string, string> {
	const out: Record<string, string> = {};
	if (!headers) return out;
	for (const [k, v] of Object.entries(headers)) {
		out[k.toLowerCase()] = v;
	}
	return out;
}

function json(status: number, body: unknown): ReplayHttpResponse {
	return Object.freeze({
		status,
		headers: Object.freeze({ "content-type": "application/json" }),
		body,
	});
}
