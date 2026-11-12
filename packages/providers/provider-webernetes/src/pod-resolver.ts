/**
 * Webernetes pod resolver (plan 0024 WP13, I14; D6).
 *
 * The local yard's hosting product is a station: one pod-shaped endpoint the
 * injected `WebernetesStationHost` stands up on loopback, a private network or
 * the `.hobo.test` overlay. The host is the only seam, exactly as for the
 * temporary station (`LocalTempTransport`), extended with the two reads a
 * convergent resolver needs: `describe` (is it there, where, running what) and
 * `release` (retire it).
 *
 * Everything the host says crosses `parseWebernetesLocalEndpoint`, so a host
 * that answers with a public URL or userinfo is refused before any probe.
 * Readiness is an observation: an HTTP GET of the parsed station URL through
 * the caller's `HttpTransport`, sent to that exact origin and nowhere else
 * (I5). The claim URL is a capability and never reaches outputs (I9). There
 * are no credentials: the request's `credentialRef` is never resolved.
 *
 * A station runs one artifact. Replacing it in place is not a staged hosting
 * transition, so a digest change on a running station is refused; the
 * remediation is a new station id for the new version.
 */
import {
	createResolverRegistry,
	type HttpTransport,
	parseResolveRequest,
	RESOLVER_CONTRACT,
	type ResolveOutcome,
	type ResolveRequest,
	ResolverError,
	type ResourceResolver,
} from "@hobo/core";
import {
	instrumentResolvers,
	type ResolverTelemetryOptions,
} from "./delivery-coverage.js";
import { isJsonObject, isJsonString, type JsonValue } from "./json.js";
import {
	parseWebernetesLocalEndpoint,
	parseWebernetesStationId,
	type WebernetesLocalEndpoint,
} from "./parse.js";

// public-contract: the local yard's hosting product id.
export const WEBERNETES_POD_PRODUCT_ID = "webernetes.pod/v1";

const PROVIDER_ID = "webernetes";
const DIGEST = /^sha256:[a-f0-9]{64}$/u;
const DESIRED_KEYS = new Set(["stationId", "artifactDigest"]);
const PROBE_TIMEOUT_MS = 5_000;
const PROBE_MAX_BYTES = 64 * 1024;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** What the host reports about a station; untrusted until parsed. */
export type WebernetesStationRecord =
	| {
			readonly state: "running";
			readonly stationUrl: string;
			readonly claimUrl: string;
			/** The content address of the artifact the station serves, if known. */
			readonly artifactDigest?: string;
	  }
	| { readonly state: "released" };

/**
 * The seam a local station host implements (the Examples dev server, an
 * overlay host, a test double). `provision` matches `LocalTempTransport`.
 */
export interface WebernetesStationHost {
	provision(input: {
		readonly stationId: string;
	}): Promise<{ stationUrl: string; claimUrl: string }>;
	/** `undefined` means the host has never stood this station up. */
	describe(input: {
		readonly stationId: string;
	}): Promise<WebernetesStationRecord | undefined>;
	release(input: { readonly stationId: string }): Promise<void>;
}

export interface WebernetesResolverOptions extends ResolverTelemetryOptions {
	readonly host: WebernetesStationHost;
}

const HOST_REMEDIATION =
	"start the local station host (the Examples dev server or the overlay host) and reconcile again";

function reject(message: string, remediation?: string): never {
	throw new ResolverError(
		"RESOLVER_PROVIDER_REJECTED",
		remediation ? `${message}. Remediation: ${remediation}` : message,
		WEBERNETES_POD_PRODUCT_ID,
	);
}
function unparseable(message: string): never {
	throw new ResolverError(
		"RESOLVER_OUTPUT_UNPARSEABLE",
		message,
		WEBERNETES_POD_PRODUCT_ID,
	);
}

interface Target {
	readonly request: ResolveRequest;
	readonly stationId: string;
	readonly artifactDigest?: string;
}

function target(raw: ResolveRequest): Target {
	const request = parseResolveRequest(JSON.parse(JSON.stringify(raw)));
	if (request.ref.productId !== WEBERNETES_POD_PRODUCT_ID)
		throw new ResolverError(
			"RESOLVER_PRODUCT_UNSUPPORTED",
			`Webernetes pod resolver cannot operate on ${request.ref.productId}`,
			request.ref.productId,
		);
	for (const key of Object.keys(request.desired))
		if (!DESIRED_KEYS.has(key))
			reject(`Webernetes pod does not implement desired.${key}`);
	let stationId: string;
	try {
		stationId = parseWebernetesStationId(
			request.desired.stationId ?? request.ref.logicalId,
		);
	} catch {
		reject("Webernetes desired.stationId is not a valid station id");
	}
	if (
		request.ref.physicalId !== undefined &&
		request.ref.physicalId !== stationId
	)
		reject("Webernetes station id conflicts with its pinned physical identity");
	const digest = request.desired.artifactDigest;
	if (digest !== undefined && (!isJsonString(digest) || !DIGEST.test(digest)))
		reject(
			"Webernetes desired.artifactDigest must be a sha256 content address",
		);
	return {
		request,
		stationId,
		...(digest === undefined ? {} : { artifactDigest: digest }),
	};
}

interface Running {
	readonly state: "running";
	readonly station: WebernetesLocalEndpoint;
	readonly artifactDigest?: string;
}
type Observed = Running | { readonly state: "released" } | undefined;

function parseRecord(value: JsonValue | undefined): Observed {
	if (value === undefined || value === null) return undefined;
	if (!isJsonObject(value))
		unparseable("Webernetes station record is malformed");
	if (value.state === "released") return { state: "released" };
	if (value.state !== "running")
		unparseable("Webernetes station record has no recognized state");
	let station: WebernetesLocalEndpoint;
	try {
		station = parseWebernetesLocalEndpoint(value.stationUrl, "stationUrl");
		parseWebernetesLocalEndpoint(value.claimUrl, "claimUrl");
	} catch (error) {
		unparseable(
			`Webernetes station host reported a non-local or malformed endpoint: ${error instanceof Error ? error.message : "unknown"}`,
		);
	}
	const digest = value.artifactDigest;
	if (digest !== undefined && (!isJsonString(digest) || !DIGEST.test(digest)))
		unparseable("Webernetes station artifact digest is not a content address");
	return {
		state: "running",
		station,
		...(digest === undefined ? {} : { artifactDigest: digest }),
	};
}

/** Build the local yard resolvers over an injected station host. */
export function createWebernetesResolvers(
	options: WebernetesResolverOptions,
): readonly ResourceResolver[] {
	const host = options.host;
	if (
		!host ||
		typeof host.provision !== "function" ||
		typeof host.describe !== "function" ||
		typeof host.release !== "function"
	)
		throw new ResolverError(
			"RESOLVER_PRODUCT_UNSUPPORTED",
			"Webernetes pod resolver needs a real local station host (provision, describe, release); a generated URL does not provision a host",
			WEBERNETES_POD_PRODUCT_ID,
		);

	async function call<T>(run: () => Promise<T>, operation: string): Promise<T> {
		try {
			return await run();
		} catch (error) {
			if (error instanceof ResolverError) throw error;
			reject(
				`Webernetes local station host failed to ${operation}`,
				HOST_REMEDIATION,
			);
		}
	}
	async function describe(stationId: string): Promise<Observed> {
		const record = await call(() => host.describe({ stationId }), "describe");
		return parseRecord(JSON.parse(JSON.stringify(record ?? null)));
	}
	async function probe(
		station: WebernetesLocalEndpoint,
		transport: HttpTransport,
	): Promise<number> {
		// The probe goes to the parsed local origin only: never a redirect target.
		try {
			const response = await transport({
				method: "GET",
				url: station.url,
				headers: { accept: "*/*" },
				timeoutMs: PROBE_TIMEOUT_MS,
				maxResponseBytes: PROBE_MAX_BYTES,
			});
			return Number.isSafeInteger(response.status) ? response.status : 0;
		} catch {
			return 0;
		}
	}
	async function outcome(
		parsed: Target,
		observed: Observed,
		transport: HttpTransport,
		action: ResolveOutcome["action"],
	): Promise<ResolveOutcome | undefined> {
		if (observed === undefined) return undefined;
		if (observed.state === "released")
			return {
				contract: RESOLVER_CONTRACT,
				action,
				physicalId: parsed.stationId,
				outputs: {
					stationId: parsed.stationId,
					ready: false,
					operationConfirmed: true,
					operationTerminal: true,
					absenceConfirmed: true,
					retirementConfirmed: true,
					lifecycleStatus: "absent",
				},
				diagnostics: ["the local station host reports the station released"],
			};
		const status = await probe(observed.station, transport);
		const healthy = status >= 200 && status < 300;
		const artifactMatches =
			parsed.artifactDigest === undefined ||
			observed.artifactDigest === parsed.artifactDigest;
		const ready = healthy && artifactMatches;
		const url = new URL(observed.station.url);
		const servable =
			url.protocol === "https:" ||
			(url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname));
		const diagnostics: string[] = [];
		if (!healthy)
			diagnostics.push(
				`station probe answered ${status === 0 ? "nothing" : `HTTP ${status}`}; readiness is observed, never assumed`,
			);
		if (!artifactMatches)
			diagnostics.push("the host has not reported the desired artifact yet");
		return {
			contract: RESOLVER_CONTRACT,
			action,
			physicalId: parsed.stationId,
			outputs: {
				stationId: parsed.stationId,
				stationUrl: observed.station.url,
				locality: observed.station.locality,
				...(servable && ready ? { servingEndpoint: observed.station.url } : {}),
				...(observed.artifactDigest === undefined
					? {}
					: { artifactDigest: observed.artifactDigest }),
				probeStatus: status,
				ready,
				operationConfirmed: ready,
				operationTerminal: ready,
				absenceConfirmed: false,
				lifecycleStatus: ready ? "ready" : "pending",
			},
			diagnostics,
		};
	}

	const resolver: ResourceResolver = {
		providerId: PROVIDER_ID,
		productId: WEBERNETES_POD_PRODUCT_ID,
		async read(raw, transport) {
			const parsed = target(raw);
			return outcome(
				parsed,
				await describe(parsed.stationId),
				transport,
				parsed.request.ref.physicalId === parsed.stationId ? "noop" : "adopt",
			);
		},
		async reconcile(raw, transport) {
			const parsed = target(raw);
			let observed = await describe(parsed.stationId);
			let action: ResolveOutcome["action"] =
				parsed.request.ref.physicalId === parsed.stationId ? "noop" : "adopt";
			if (observed?.state === "released")
				reject(
					`Webernetes station ${parsed.stationId} was released; it is not resurrected silently`,
					"deliver the version to a new station id",
				);
			if (
				observed?.state === "running" &&
				parsed.artifactDigest !== undefined &&
				observed.artifactDigest !== undefined &&
				observed.artifactDigest !== parsed.artifactDigest
			)
				reject(
					`Webernetes station ${parsed.stationId} serves another artifact; replacing it in place is not a staged transition`,
					"deliver the new version to a new station id and shift traffic in-process",
				);
			if (observed === undefined) {
				const provisioned = await call(
					() => host.provision({ stationId: parsed.stationId }),
					"provision",
				);
				parseRecord({
					state: "running",
					...JSON.parse(JSON.stringify(provisioned)),
				});
				observed = await describe(parsed.stationId);
				action = "create";
				if (observed?.state !== "running")
					reject(
						`Webernetes station ${parsed.stationId} was provisioned but the host does not describe it running`,
						HOST_REMEDIATION,
					);
			}
			const result = await outcome(parsed, observed, transport, action);
			if (!result)
				unparseable("Webernetes station disappeared during reconcile");
			return result;
		},
		async delete(raw) {
			const parsed = target(raw);
			await call(
				() => host.release({ stationId: parsed.stationId }),
				"release",
			);
			const after = await describe(parsed.stationId);
			if (after?.state === "running")
				reject(
					`Webernetes station ${parsed.stationId} release is not confirmed; the host still reports it running`,
					HOST_REMEDIATION,
				);
		},
	};
	return Object.freeze([resolver]);
}

/** Registry of every Webernetes hosting product with a shipped resolver (I14). */
export function webernetesResolverRegistry(options: WebernetesResolverOptions) {
	return createResolverRegistry(
		instrumentResolvers(createWebernetesResolvers(options), options),
	);
}
