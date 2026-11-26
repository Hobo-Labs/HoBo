/**
 * Deep Bindle integration: every **App Kit** is Session-Replay capable by
 * default (ADR-0137). App Kits (api, web, service, ui, websocket, job,
 * wasm-component) are the Bindle authoring term for entrypoint-bearing surfaces
 * — prefer this over "membrane types". Hosts wrap HTTP App Kit fetch handlers
 * so HTML responses get a privacy-first tracker bootstrap and
 * `/__hobo/replay/*` serves ingest.
 */
import {
	type BrowserBootstrapConfig,
	injectSessionReplayBootstrap,
} from "./browser-bootstrap.js";
import { createReplayEvent, REPLAY_EVENTS } from "./events.js";
import {
	evaluateRecordingPolicy,
	REPLAY_ENV_KILL,
	REPLAY_FLAG_KEY,
} from "./policy.js";
import { assertNoSensitivePlaintext, maskRrwebEvents } from "./privacy.js";
import { createMemoryDualFixtures, type DualFixtureStore } from "./storage.js";
import {
	defaultPrivacyPolicy,
	parseSessionRecord,
	type RrwebEvent,
	type SessionRecord,
} from "./types.js";

// public-contract: annotation option auto-attached to Bindle `web` resources.
export const SESSION_REPLAY_OPTION = "session-replay" as const;
// public-contract: HTTP path prefix for ingest/list/open on Bindle hosts.
export const SESSION_REPLAY_PATH_PREFIX = "/__hobo/replay" as const;

/** App Kit kinds that receive Session Replay by default (mirrors @hobo/bindles). */
export const REPLAYABLE_APP_KIT_KINDS = Object.freeze([
	"api",
	"web",
	"service",
	"ui",
	"websocket",
	"job",
	"wasm-component",
] as const);

export type ReplayableAppKitKind = (typeof REPLAYABLE_APP_KIT_KINDS)[number];

export type SessionReplayAnnotationConfig = Readonly<{
	/** Default true for App Kits. Explicit false opts out. */
	enabled?: boolean;
	/** Production sampling 0..1 when progressive. */
	sampleRate?: number;
}>;

export type BindleAnnotationLike = Readonly<{
	provider: string;
	option: string;
	config: Readonly<Record<string, unknown>>;
}>;

export type BindleResourceLike = Readonly<{
	kind: string;
	name: string;
	annotations: readonly BindleAnnotationLike[];
}>;

export type BindleDefinitionLike = Readonly<{
	name: string;
	resources: Readonly<Record<string, BindleResourceLike>>;
}>;

export type BindleSessionReplayPlan = Readonly<{
	bindleName: string;
	/** True when at least one replayable surface exists and policy allows. */
	enabled: boolean;
	reason:
		| "bindle-kit-default-on"
		| "bindle-web-default-on"
		| "no-replayable-app-kit"
		| "no-replayable-web-surface"
		| "local-default-on"
		| "env-kill"
		| "flag-off"
		| "flag-on"
		| "production-default-off"
		| "sampled-in"
		| "sampled-out"
		| "effect-isolated";
	flagKey: typeof REPLAY_FLAG_KEY;
	killEnv: typeof REPLAY_ENV_KILL;
	/** Resource names that should wrap handlers (web by default). */
	resourceNames: readonly string[];
	pathPrefix: typeof SESSION_REPLAY_PATH_PREFIX;
}>;

/**
 * Annotation factories for Bindle `.with(sessionReplayAnnotation(...))`.
 * Prefer auto-default; use `{ enabled: false }` to opt a web resource out.
 */
export function sessionReplayAnnotation(
	config: SessionReplayAnnotationConfig = {},
): BindleAnnotationLike {
	return Object.freeze({
		provider: "hobo",
		option: SESSION_REPLAY_OPTION,
		config: Object.freeze({
			enabled: config.enabled !== false,
			...(config.sampleRate !== undefined
				? { sampleRate: config.sampleRate }
				: {}),
		}),
	});
}

export function readSessionReplayAnnotation(
	annotations: readonly BindleAnnotationLike[],
): SessionReplayAnnotationConfig | undefined {
	for (const a of annotations) {
		if (a.option !== SESSION_REPLAY_OPTION) continue;
		const enabled =
			a.config.enabled === undefined ? true : a.config.enabled !== false;
		const sampleRate =
			typeof a.config.sampleRate === "number" ? a.config.sampleRate : undefined;
		return Object.freeze({
			enabled,
			...(sampleRate !== undefined ? { sampleRate } : {}),
		});
	}
	return undefined;
}

export function isReplayableAppKitKind(
	kind: string,
): kind is ReplayableAppKitKind {
	return (REPLAYABLE_APP_KIT_KINDS as readonly string[]).includes(kind);
}

/**
 * Every App Kit is replayable by default. Explicit annotation can disable.
 * Infra Kits (kv, bucket, queue, …) are not entrypoint hosts — not replayable
 * unless explicitly annotated on.
 */
export function isResourceReplayable(record: BindleResourceLike): boolean {
	const ann = readSessionReplayAnnotation(record.annotations);
	if (ann !== undefined && ann.enabled === false) return false;
	if (isReplayableAppKitKind(record.kind)) {
		// Default-on for all App Kits unless opted out.
		return true;
	}
	// Infra Kits: only when explicitly annotated on.
	return ann?.enabled === true;
}

export function listReplayableResources(
	definition: BindleDefinitionLike,
): readonly string[] {
	return Object.freeze(
		Object.values(definition.resources)
			.filter(isResourceReplayable)
			.map((r) => r.name),
	);
}

export function deriveBindleSessionReplayPlan(
	definition: BindleDefinitionLike,
	env: Readonly<Record<string, string | undefined>> = {},
): BindleSessionReplayPlan {
	const resourceNames = listReplayableResources(definition);
	const policy = evaluateRecordingPolicy({
		env,
		isolationClass: env.HOBO_ENV ?? "local-dev",
	});
	const hasSurface = resourceNames.length > 0;
	const enabled = hasSurface && policy.enabled;
	const reason: BindleSessionReplayPlan["reason"] = !hasSurface
		? "no-replayable-app-kit"
		: !policy.enabled
			? policy.reason
			: "bindle-kit-default-on";

	return Object.freeze({
		bindleName: definition.name,
		enabled,
		reason,
		flagKey: REPLAY_FLAG_KEY,
		killEnv: REPLAY_ENV_KILL,
		resourceNames,
		pathPrefix: SESSION_REPLAY_PATH_PREFIX,
	});
}

export type FetchHandler = (request: Request) => Response | Promise<Response>;

export type WrapBindleWebHandlerOptions = Readonly<{
	bindleName: string;
	resourceName: string;
	stationId?: string;
	env?: Readonly<Record<string, string | undefined>>;
	/** Shared store across resources of one serve process. */
	store?: DualFixtureStore;
	isolationClass?: string;
	/** Force enable/disable regardless of env (tests). */
	enabled?: boolean;
}>;

export type SessionReplayHostSurface = Readonly<{
	handler: FetchHandler;
	store: DualFixtureStore;
	planEnabled: boolean;
	pathPrefix: typeof SESSION_REPLAY_PATH_PREFIX;
	listSessions: () => Promise<readonly SessionRecord[]>;
}>;

/**
 * Wrap a Bindle HTTP entrypoint so that:
 * 1. `/__hobo/replay/*` handles ingest/list/get
 * 2. HTML responses receive the Session Replay bootstrap script
 *
 * Non-HTML JSON APIs pass through unchanged (except the reserved path prefix).
 */
export function wrapBindleWebHandler(
	inner: FetchHandler,
	options: WrapBindleWebHandlerOptions,
): SessionReplayHostSurface {
	const env = options.env ?? {};
	const policy = evaluateRecordingPolicy({
		env,
		isolationClass: options.isolationClass ?? env.HOBO_ENV ?? "local-dev",
		...(options.enabled !== undefined ? { flagEnabled: options.enabled } : {}),
	});
	const enabled = options.enabled ?? policy.enabled;
	const store = options.store ?? createMemoryDualFixtures();
	const stationId = options.stationId ?? "station:local";
	const pathPrefix = SESSION_REPLAY_PATH_PREFIX;
	const privacy = defaultPrivacyPolicy();

	const handler: FetchHandler = async (request) => {
		const url = new URL(request.url);
		if (
			url.pathname === pathPrefix ||
			url.pathname.startsWith(`${pathPrefix}/`)
		) {
			return handleReplayControlPlane(request, url, {
				store,
				stationId,
				bindleName: options.bindleName,
				resourceName: options.resourceName,
				enabled,
				privacy,
			});
		}

		const response = await inner(request);
		if (!enabled) return response;

		const contentType = response.headers.get("content-type") ?? "";
		if (!contentType.includes("text/html")) return response;

		const html = await response.text();
		const sessionId = `sess-${options.bindleName}-${options.resourceName}-${Date.now().toString(36)}`;
		const bootstrap: BrowserBootstrapConfig = {
			sessionId,
			stationId,
			bindleName: options.bindleName,
			resourceName: options.resourceName,
			ingestPath: `${pathPrefix}/ingest`,
			enabled: true,
			isolationClass: options.isolationClass ?? "local-dev",
		};
		const injected = injectSessionReplayBootstrap(html, bootstrap);
		const headers = new Headers(response.headers);
		headers.delete("content-length");
		headers.set("x-hobo-session-replay", "1");
		headers.set("x-hobo-session-replay-id", sessionId);
		return new Response(injected, {
			status: response.status,
			statusText: response.statusText,
			headers,
		});
	};

	return Object.freeze({
		handler,
		store,
		planEnabled: enabled,
		pathPrefix,
		listSessions: () => store.index.list({ stationId }),
	});
}

/**
 * Apply Session Replay wrap to every replayable resource in a Bindle serve set.
 */
export function applySessionReplayToEntrypoints<
	T extends {
		readonly name: string;
		readonly kind: string;
		readonly handler: FetchHandler;
	},
>(
	entrypoints: readonly T[],
	definition: BindleDefinitionLike,
	options: {
		readonly stationId?: string;
		readonly env?: Readonly<Record<string, string | undefined>>;
		readonly store?: DualFixtureStore;
	} = {},
): {
	readonly entrypoints: readonly T[];
	readonly plan: BindleSessionReplayPlan;
	readonly store: DualFixtureStore;
} {
	const plan = deriveBindleSessionReplayPlan(definition, options.env ?? {});
	const store = options.store ?? createMemoryDualFixtures();
	const replayable = new Set(plan.resourceNames);
	const wrapped = entrypoints.map((entry) => {
		if (!replayable.has(entry.name)) return entry;
		const surface = wrapBindleWebHandler(entry.handler, {
			bindleName: definition.name,
			resourceName: entry.name,
			...(options.stationId !== undefined
				? { stationId: options.stationId }
				: {}),
			...(options.env !== undefined ? { env: options.env } : {}),
			store,
			enabled: plan.enabled,
		});
		return Object.freeze({
			...entry,
			handler: surface.handler,
		}) as T;
	});
	return Object.freeze({
		entrypoints: Object.freeze(wrapped),
		plan,
		store,
	});
}

async function handleReplayControlPlane(
	request: Request,
	url: URL,
	ctx: {
		store: DualFixtureStore;
		stationId: string;
		bindleName: string;
		resourceName: string;
		enabled: boolean;
		privacy: ReturnType<typeof defaultPrivacyPolicy>;
	},
): Promise<Response> {
	const sub = url.pathname.slice(SESSION_REPLAY_PATH_PREFIX.length) || "/";
	const json = (status: number, body: unknown) =>
		new Response(JSON.stringify(body), {
			status,
			headers: { "content-type": "application/json" },
		});

	if (request.method === "GET" && (sub === "/" || sub === "/sessions")) {
		const sessions = await ctx.store.index.list({ stationId: ctx.stationId });
		return json(200, {
			ok: true,
			bindleName: ctx.bindleName,
			sessions,
		});
	}

	if (request.method === "GET" && sub.startsWith("/sessions/")) {
		const id = decodeURIComponent(sub.slice("/sessions/".length));
		const session = await ctx.store.index.get(id);
		if (!session) return json(404, { ok: false, code: "REPLAY_NOT_FOUND" });
		return json(200, { ok: true, session });
	}

	if (request.method === "POST" && sub === "/ingest") {
		if (!ctx.enabled) {
			return json(204, { ok: true, disabled: true });
		}
		let body: {
			sessionId?: string;
			seq?: number;
			events?: RrwebEvent[];
			stationId?: string;
			bindleName?: string;
			resourceName?: string;
			isolationClass?: string;
		};
		try {
			body = (await request.json()) as typeof body;
		} catch {
			return json(400, { ok: false, code: "REPLAY_BAD_JSON" });
		}
		const sessionId =
			typeof body.sessionId === "string" && body.sessionId.length > 0
				? body.sessionId
				: `sess-${ctx.bindleName}-auto`;
		const seq = typeof body.seq === "number" ? body.seq : 0;
		const events = maskRrwebEvents(
			Array.isArray(body.events) ? body.events : [],
			ctx.privacy,
		);
		const serialized = JSON.stringify(events);
		try {
			assertNoSensitivePlaintext(serialized);
		} catch {
			return json(422, { ok: false, code: "REPLAY_PRIVACY_LEAK" });
		}
		const chunk = await ctx.store.blobs.put(sessionId, seq, events);
		const existing = await ctx.store.index.get(sessionId);
		const record: SessionRecord = parseSessionRecord({
			id: sessionId,
			status: "recording",
			startedAt: existing?.startedAt ?? new Date().toISOString(),
			correlation: {
				stationId: body.stationId ?? ctx.stationId,
				tenant: "local",
				env: "local-dev",
				isolationClass: body.isolationClass ?? "local-dev",
				harnessFlagKeys: [REPLAY_FLAG_KEY],
			},
			privacy: ctx.privacy,
			chunkCount: (existing?.chunkCount ?? 0) + 1,
			totalBytes: (existing?.totalBytes ?? 0) + chunk.byteSize,
			summary: `bindle=${ctx.bindleName} resource=${ctx.resourceName}`,
		});
		await ctx.store.index.upsert(record);
		// Lifecycle metadata only — blob ref, not events stream.
		createReplayEvent(REPLAY_EVENTS.ChunkIngested, {
			sessionId,
			stationId: ctx.stationId,
			seq,
			data: {
				blobRef: chunk.blobRef,
				bytes: chunk.byteSize,
				bindleName: ctx.bindleName,
				resourceName: ctx.resourceName,
			},
		});
		return json(202, {
			ok: true,
			sessionId,
			chunkSeq: chunk.seq,
			blobRef: chunk.blobRef,
		});
	}

	if (request.method === "POST" && sub === "/end") {
		let body: { sessionId?: string };
		try {
			body = (await request.json()) as typeof body;
		} catch {
			return json(400, { ok: false, code: "REPLAY_BAD_JSON" });
		}
		if (!body.sessionId) {
			return json(400, { ok: false, code: "REPLAY_SESSION_REQUIRED" });
		}
		const existing = await ctx.store.index.get(body.sessionId);
		if (!existing) return json(404, { ok: false, code: "REPLAY_NOT_FOUND" });
		const ended = parseSessionRecord({
			...existing,
			status: "ended",
			endedAt: new Date().toISOString(),
		});
		await ctx.store.index.upsert(ended);
		return json(200, { ok: true, session: ended });
	}

	return json(404, { ok: false, code: "REPLAY_UNKNOWN_ROUTE" });
}

/** Default annotation attached to every Bindle web resource. */
export function defaultWebSessionReplayAnnotation(): BindleAnnotationLike {
	return sessionReplayAnnotation({ enabled: true });
}
