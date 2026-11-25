/**
 * Station-local Session Replay service: start/stop, list, open, summarize, retention.
 */
import { evaluateReplayAccess } from "./access.js";
import { buildCorrelation } from "./correlation.js";
import { REPLAY_BOUNDARIES } from "./http-surface.js";
import { loadPlayerPayload, summarizeSession } from "./player.js";
import {
	applyRetention,
	eraseSessionById,
	type RetentionPolicy,
} from "./retention.js";
import {
	createFilesystemDualFixtures,
	createMemoryDualFixtures,
	type DualFixtureStore,
	type SessionListQuery,
} from "./storage.js";
import {
	createDefaultLocalTracker,
	createFixtureRecordEngine,
	createTracker,
	type TrackerHandle,
} from "./tracker.js";
import type { RrwebEvent, SessionRecord } from "./types.js";

export type ReplayService = Readonly<{
	store: DualFixtureStore;
	stationId: string;
	startRecording: (input?: {
		readonly principalRef?: string;
		readonly seedEvents?: readonly RrwebEvent[];
		readonly env?: Readonly<Record<string, string | undefined>>;
		readonly sessionId?: string;
	}) => TrackerHandle;
	list: (query?: SessionListQuery) => Promise<readonly SessionRecord[]>;
	get: (sessionId: string) => Promise<SessionRecord | undefined>;
	open: (
		sessionId: string,
		blobRefs?: readonly string[],
	) => Promise<
		| {
				ok: true;
				payload: Awaited<ReturnType<typeof loadPlayerPayload>>;
				summary: string;
		  }
		| { ok: false; code: string; message: string }
	>;
	summarize: (sessionId: string) => Promise<string | undefined>;
	retention: (
		policy?: RetentionPolicy,
	) => Promise<Awaited<ReturnType<typeof applyRetention>>>;
	erase: (sessionId: string) => Promise<SessionRecord | undefined>;
	doctor: () => Readonly<{
		package: string;
		stationId: string;
		defaultLocalOn: boolean;
		killEnv: string;
		honestScope: readonly string[];
		/** Integration boundary ids (PACT inventory). */
		boundaries: readonly string[];
	}>;
}>;

export function createReplayService(input: {
	readonly stationId?: string;
	readonly rootDir?: string;
	readonly memory?: boolean;
}): ReplayService {
	const stationId = input.stationId ?? "station:local";
	const store =
		input.memory || !input.rootDir
			? createMemoryDualFixtures()
			: createFilesystemDualFixtures(input.rootDir);

	return Object.freeze({
		store,
		stationId,
		startRecording(opts = {}) {
			if (opts.seedEvents) {
				return createTracker({
					...(opts.sessionId !== undefined
						? { sessionId: opts.sessionId }
						: {}),
					correlation: buildCorrelation({
						stationId,
						...(opts.principalRef !== undefined
							? { principalRef: opts.principalRef }
							: {}),
					}),
					store: store.blobs,
					index: store.index,
					engine: createFixtureRecordEngine(opts.seedEvents),
					policy: {
						...(opts.env !== undefined ? { env: opts.env } : {}),
						isolationClass: "local-dev",
					},
				});
			}
			return createDefaultLocalTracker({
				stationId,
				store: store.blobs,
				index: store.index,
				...(opts.env !== undefined ? { env: opts.env } : {}),
			});
		},
		list(query = {}) {
			return store.index.list({ ...query, stationId });
		},
		get(sessionId) {
			return store.index.get(sessionId);
		},
		async open(sessionId, blobRefs) {
			const session = await store.index.get(sessionId);
			if (!session) {
				return {
					ok: false as const,
					code: "REPLAY_NOT_FOUND",
					message: `session not found: ${sessionId}`,
				};
			}
			const access = evaluateReplayAccess({
				session,
				viewerStationId: stationId,
			});
			if (!access.allowed) {
				return {
					ok: false as const,
					code: "REPLAY_ACCESS_DENIED",
					message: `access denied: ${access.reason}`,
				};
			}
			try {
				const payload = await loadPlayerPayload({
					sessionId,
					index: store.index,
					blobs: store.blobs,
					stationId,
					...(blobRefs !== undefined ? { blobRefs } : {}),
				});
				return {
					ok: true as const,
					payload,
					summary: summarizeSession(session),
				};
			} catch (e) {
				const err = e as { code?: string; message?: string };
				return {
					ok: false as const,
					code: err.code ?? "REPLAY_OPEN_FAILED",
					message: err.message ?? "open failed",
				};
			}
		},
		async summarize(sessionId) {
			const session = await store.index.get(sessionId);
			return session ? summarizeSession(session) : undefined;
		},
		retention(policy) {
			return applyRetention({
				index: store.index,
				stationId,
				...(policy !== undefined ? { policy } : {}),
			});
		},
		erase(sessionId) {
			return eraseSessionById({
				index: store.index,
				sessionId,
				stationId,
			});
		},
		doctor() {
			return Object.freeze({
				package: "@hobo/replay",
				stationId,
				defaultLocalOn: true,
				killEnv: "HOBO_REPLAY=0",
				boundaries: Object.freeze(REPLAY_BOUNDARIES.map((b) => b.id)),
				honestScope: Object.freeze([
					"Live multi-cloud object storage is port-based; dual fixtures are the default proof path",
					"Full OpenReplay Assist / Helm stack is optional Station template, not required",
					"High-volume ClickHouse analytics are residual",
					"Every integration boundary (including internal) is PACT-verified via createReplayHttpSurface",
				]),
			});
		},
	});
}

/** Offline contract-asserted fixtures for agents (schemaOnlyView). */
export function createContractAssertedReplayFixtures(input?: {
	readonly stationId?: string;
	readonly tenant?: string;
}): DualFixtureStore & {
	readonly service: ReplayService;
	readonly sampleSessionId: string;
} {
	const stationId = input?.stationId ?? "station:local";
	const service = createReplayService({ stationId, memory: true });
	return Object.freeze({
		...service.store,
		service,
		sampleSessionId: "sess-fixture-1",
		label: "contract-asserted-replay-fixtures" as const,
		fidelity: "simulated" as const,
	});
}
