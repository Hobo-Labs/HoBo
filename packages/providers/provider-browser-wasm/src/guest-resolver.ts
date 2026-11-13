/**
 * Browser WASM guest resolver (plan 0024 WP14, I14; D6).
 *
 * A browser guest is not delivered to a server. What a reconciler can own and
 * observe is the host origin's publication: `/_hobo/host/capabilities` and
 * `/_hobo/guests/<id>/manifest.json`, the same two documents a page reads
 * before it instantiates anything (`createHostAssetClient`). The realization
 * path is therefore observation-only, as for GitOps publishers: the host page
 * itself is delivered by the hosting provider that serves the origin (a static
 * deploy on Vercel, Netlify or Cloudflare), and this resolver reports `ready`
 * only when the origin publishes exactly the desired digest in a context that
 * can hold it. It never mutates the origin, never fetches or runs a component
 * and never resolves a credential: there is nothing to authenticate to.
 *
 * Every read goes through the package's same-origin guard and its parsers, so
 * a redirect, a cross-origin path or a changed document shape is refused
 * before anything reaches an outcome.
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
import { createHostAssetClient } from "./client.js";
import {
	instrumentResolvers,
	type ResolverTelemetryOptions,
} from "./delivery-coverage.js";
import { BrowserWasmProviderError } from "./errors.js";
import { isJsonString, type JsonValue } from "./json.js";
import type { GuestManifest, HostCapabilities } from "./manifest.js";
import type { HostAssetTransport } from "./transport.js";

// public-contract: the browser guest hosting product id.
export const BROWSER_WASM_GUEST_PRODUCT_ID = "browser-wasm.guest/v1";

const PROVIDER_ID = "browser-wasm";
const DIGEST = /^sha256:([a-f0-9]{64})$/u;
const GUEST_ID = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/u;
const DESIRED_KEYS = new Set(["origin", "guestId", "artifactDigest"]);
const READ_TIMEOUT_MS = 5_000;
const MANIFEST_MAX_BYTES = 256 * 1024;

export type BrowserWasmResolverOptions = ResolverTelemetryOptions;

function reject(message: string, remediation?: string): never {
	throw new ResolverError(
		"RESOLVER_PROVIDER_REJECTED",
		remediation ? `${message}. Remediation: ${remediation}` : message,
		BROWSER_WASM_GUEST_PRODUCT_ID,
	);
}

interface Target {
	readonly request: ResolveRequest;
	readonly origin: string;
	readonly guestId: string;
	readonly artifactDigest: string;
	readonly physicalId: string;
}

function parseOrigin(value: JsonValue | undefined): string {
	if (!isJsonString(value)) reject("desired.origin is required");
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		reject("desired.origin is not a URL");
	}
	if (
		url.protocol !== "https:" ||
		url.username ||
		url.password ||
		url.search ||
		url.hash ||
		(url.pathname !== "/" && url.pathname !== "")
	)
		reject(
			"desired.origin must be a bare https origin",
			"set it to the scheme and host the host page is served from",
		);
	return url.origin;
}

function target(raw: ResolveRequest): Target {
	const request = parseResolveRequest(JSON.parse(JSON.stringify(raw)));
	if (request.ref.productId !== BROWSER_WASM_GUEST_PRODUCT_ID)
		throw new ResolverError(
			"RESOLVER_PRODUCT_UNSUPPORTED",
			`Browser WASM guest resolver cannot operate on ${request.ref.productId}`,
			request.ref.productId,
		);
	for (const key of Object.keys(request.desired))
		if (!DESIRED_KEYS.has(key))
			reject(`Browser WASM guest does not implement desired.${key}`);
	const origin = parseOrigin(request.desired.origin);
	const guestId = request.desired.guestId ?? request.ref.logicalId;
	if (!isJsonString(guestId) || !GUEST_ID.test(guestId))
		reject("desired.guestId is not an RFC 1123 label");
	const digest = request.desired.artifactDigest;
	if (!isJsonString(digest) || !DIGEST.test(digest))
		reject(
			"desired.artifactDigest must be a sha256 content address (promote, never rebuild)",
		);
	const physicalId = `${origin}/_hobo/guests/${guestId}`;
	if (
		request.ref.physicalId !== undefined &&
		request.ref.physicalId !== physicalId
	)
		reject("guest identity conflicts with its pinned physical identity");
	return { request, origin, guestId, artifactDigest: digest, physicalId };
}

/** Adapt core's string-bodied transport to the package's byte-bodied seam. */
function hostTransport(transport: HttpTransport): HostAssetTransport {
	const encoder = new TextEncoder();
	return {
		async request(call) {
			const response = await transport({
				method: "GET",
				url: call.url,
				headers: call.headers,
				timeoutMs: Math.min(call.timeoutMs, READ_TIMEOUT_MS),
				maxResponseBytes: Math.min(call.maxResponseBytes, MANIFEST_MAX_BYTES),
			});
			return {
				status: response.status,
				headers: response.headers,
				body: encoder.encode(response.body),
			};
		},
	};
}

type Observed =
	| { readonly published: false; readonly host: HostCapabilities }
	| {
			readonly published: true;
			readonly host: HostCapabilities;
			readonly manifest: GuestManifest;
	  };

async function observe(
	parsed: Target,
	transport: HttpTransport,
): Promise<Observed> {
	const client = createHostAssetClient({
		transport: hostTransport(transport),
		origin: parsed.origin,
	});
	try {
		const host = await client.fetchHostCapabilities();
		try {
			const manifest = await client.fetchGuestManifest(parsed.guestId);
			return { published: true, host, manifest };
		} catch (error) {
			if (
				error instanceof BrowserWasmProviderError &&
				error.code === "BUNDLE_UNAVAILABLE" &&
				!error.retryable
			)
				return { published: false, host };
			throw error;
		}
	} catch (error) {
		if (!(error instanceof BrowserWasmProviderError)) throw error;
		if (error.code === "PROVIDER_CONTRACT_CHANGED")
			throw new ResolverError(
				"RESOLVER_OUTPUT_UNPARSEABLE",
				`host origin ${parsed.origin}: ${error.message}`,
				BROWSER_WASM_GUEST_PRODUCT_ID,
			);
		reject(
			`host origin ${parsed.origin} could not be read (${error.code}): ${error.message}`,
			"deliver the host page to that origin and serve /_hobo/host/capabilities",
		);
	}
}

function outcome(
	parsed: Target,
	observed: Observed,
	action: ResolveOutcome["action"],
): ResolveOutcome {
	const diagnostics: string[] = [];
	const hostOutputs = {
		crossOriginIsolated: observed.host.crossOriginIsolated,
		hostPersistence: observed.host.persistence,
		hostMaxMemoryBytes: observed.host.maxMemoryBytes,
	};
	if (!observed.published) {
		diagnostics.push(
			`the host origin does not publish guest ${parsed.guestId} yet; publish it with the host page deployment`,
		);
		return {
			contract: RESOLVER_CONTRACT,
			action,
			physicalId: parsed.physicalId,
			outputs: {
				origin: parsed.origin,
				guestId: parsed.guestId,
				...hostOutputs,
				published: false,
				ready: false,
				operationConfirmed: false,
				operationTerminal: false,
				absenceConfirmed: true,
				lifecycleStatus: "pending",
			},
			diagnostics,
		};
	}
	const manifest = observed.manifest;
	const published = `sha256:${manifest.contentDigest.slice("sha256-".length)}`;
	const digestMatches = published === parsed.artifactDigest;
	if (!digestMatches)
		diagnostics.push(
			"the host origin publishes another digest for this guest; the host page deployment has not caught up",
		);
	const memoryFits = manifest.memoryLimitBytes <= observed.host.maxMemoryBytes;
	if (!memoryFits)
		diagnostics.push(
			"the host context reports less memory than the guest manifest requires",
		);
	const persistenceFits =
		manifest.persistence === "transient-memory" ||
		(observed.host.persistence === manifest.persistence &&
			observed.host.dedicatedWorkers);
	if (!persistenceFits)
		diagnostics.push(
			`the guest requires ${manifest.persistence} persistence and the host context reports ${observed.host.persistence}`,
		);
	const ready = digestMatches && memoryFits && persistenceFits;
	return {
		contract: RESOLVER_CONTRACT,
		action,
		physicalId: parsed.physicalId,
		outputs: {
			origin: parsed.origin,
			guestId: parsed.guestId,
			...hostOutputs,
			published: true,
			artifactDigest: published,
			world: manifest.world,
			componentPath: manifest.componentPath,
			// The guest runs in visitors' browsers: what is observed is the
			// publication a page verifies before instantiation.
			servingScope: "host-origin-publication",
			ready,
			operationConfirmed: ready,
			operationTerminal: ready,
			absenceConfirmed: false,
			lifecycleStatus: ready ? "ready" : "pending",
		},
		diagnostics,
	};
}

/** Build the observation-only Browser WASM resolvers. */
export function createBrowserWasmResolvers(): readonly ResourceResolver[] {
	const resolver: ResourceResolver = {
		providerId: PROVIDER_ID,
		productId: BROWSER_WASM_GUEST_PRODUCT_ID,
		async read(raw, transport) {
			const parsed = target(raw);
			const observed = await observe(parsed, transport);
			if (!observed.published) return undefined;
			return outcome(
				parsed,
				observed,
				parsed.request.ref.physicalId === parsed.physicalId ? "noop" : "adopt",
			);
		},
		async reconcile(raw, transport) {
			const parsed = target(raw);
			return outcome(
				parsed,
				await observe(parsed, transport),
				parsed.request.ref.physicalId === parsed.physicalId ? "noop" : "adopt",
			);
		},
		async delete(raw, transport) {
			const parsed = target(raw);
			const observed = await observe(parsed, transport);
			if (observed.published)
				reject(
					`host origin ${parsed.origin} still publishes guest ${parsed.guestId}`,
					"remove the guest from the host page deployment, then delete again",
				);
		},
	};
	return Object.freeze([resolver]);
}

/** Registry of every Browser WASM hosting product with a shipped resolver (I14). */
export function browserWasmResolverRegistry(
	options: BrowserWasmResolverOptions = {},
) {
	return createResolverRegistry(
		instrumentResolvers(createBrowserWasmResolvers(), options),
	);
}
