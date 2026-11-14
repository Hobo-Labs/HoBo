/**
 * Flux (FluxCloud / FluxOS) app resolver (plan 0024 WP13, I14; D6).
 *
 * The hosting product is a registered Flux app: a compose of digest-pinned
 * containers that FluxOS schedules onto community or enterprise nodes. Two
 * documented public reads observe it:
 *
 * - `GET /apps/appspecifications/{name}`: the registered specification;
 * - `GET /apps/location/{name}`: the nodes currently running it.
 *
 * The resolver adopts an app whose owner and digest-pinned images match the
 * desired state and reports readiness only from observed running instances
 * (I5). It never mutates: registering, updating and removing a Flux app each
 * need a message signed by the owner's wallet key (and payment), which HoBo
 * does not hold and must not hold. A drift or an absent app is therefore a
 * typed refusal whose remediation names the signed path (an agent-local
 * bridge reached from a `hobo:resolver` WASM component, R2).
 *
 * Reads are public, so the request's `credentialRef` is never resolved and no
 * credential header is ever sent. Specification `environmentParameters` are
 * never copied into outputs: Flux publishes them, but HoBo records stay
 * secret-free (I9).
 */
import {
	createResolverRegistry,
	guardTransport,
	type HttpTransport,
	parseResolveRequest,
	RESOLVER_CONTRACT,
	type ResolveOutcome,
	type ResolveRequest,
	ResolverError,
	type ResourceResolver,
	type TransportResponse,
} from "@hobo/core";
import {
	instrumentResolvers,
	type ResolverTelemetryOptions,
} from "./delivery-coverage.js";
import {
	isJsonArray,
	isJsonNumber,
	isJsonObject,
	isJsonString,
	type JsonObject,
	type JsonValue,
} from "./json.js";

// public-contract: the Flux app hosting product id.
export const FLUX_APP_PRODUCT_ID = "flux.app/v1";
// public-contract: the documented public FluxOS API origin.
export const FLUX_API_ORIGIN = "https://api.runonflux.io";

const PROVIDER_ID = "flux";
const APP_NAME = /^[A-Za-z0-9]{3,32}$/u;
const OWNER = /^[A-Za-z0-9]{20,96}$/u;
const COMPONENT = /^[A-Za-z0-9]{1,32}$/u;
const PINNED_IMAGE = /^[a-z0-9][a-z0-9._/:-]{0,254}@(sha256:[a-f0-9]{64})$/u;
const DESIRED_KEYS = new Set(["appName", "owner", "images", "minInstances"]);
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const TIMEOUT_MS = 30_000;

export type FluxResolverOptions = ResolverTelemetryOptions;

function reject(message: string, remediation?: string): never {
	throw new ResolverError(
		"RESOLVER_PROVIDER_REJECTED",
		remediation ? `${message}. Remediation: ${remediation}` : message,
		FLUX_APP_PRODUCT_ID,
	);
}
function unparseable(message: string): never {
	throw new ResolverError(
		"RESOLVER_OUTPUT_UNPARSEABLE",
		message,
		FLUX_APP_PRODUCT_ID,
	);
}

interface Target {
	readonly request: ResolveRequest;
	readonly appName: string;
	readonly owner: string;
	/** component name -> sha256 digest */
	readonly digests: ReadonlyMap<string, string>;
	readonly images: ReadonlyMap<string, string>;
	readonly minInstances: number | undefined;
}

const SIGNED_PATH =
	"sign and broadcast the registration or update with the owner's wallet through an agent-local bridge called from a signed hobo:resolver WASM component (R2), then reconcile to adopt it";

function target(raw: ResolveRequest): Target {
	const request = parseResolveRequest(JSON.parse(JSON.stringify(raw)));
	if (request.ref.productId !== FLUX_APP_PRODUCT_ID)
		throw new ResolverError(
			"RESOLVER_PRODUCT_UNSUPPORTED",
			`Flux app resolver cannot operate on ${request.ref.productId}`,
			request.ref.productId,
		);
	for (const key of Object.keys(request.desired))
		if (!DESIRED_KEYS.has(key))
			reject(`Flux app does not implement desired.${key}`);
	const { appName, owner, images, minInstances } = request.desired;
	if (!isJsonString(appName) || !APP_NAME.test(appName))
		reject("Flux desired.appName must be 3-32 alphanumeric characters");
	if (
		request.ref.physicalId !== undefined &&
		request.ref.physicalId !== appName
	)
		reject("Flux app name conflicts with its pinned physical identity");
	if (!isJsonString(owner) || !OWNER.test(owner))
		reject("Flux desired.owner must be the app owner's address");
	if (!isJsonObject(images) || Object.keys(images).length === 0)
		reject("Flux desired.images must name each compose component's image");
	const digests = new Map<string, string>();
	const pinned = new Map<string, string>();
	for (const [component, image] of Object.entries(images)) {
		if (!COMPONENT.test(component))
			reject(`Flux component name ${JSON.stringify(component)} is invalid`);
		const match = isJsonString(image) ? PINNED_IMAGE.exec(image) : null;
		if (!match?.[1])
			reject(
				`Flux component ${component} image must be pinned by sha256 digest`,
				"promote the Freight's digest-pinned image; tags would rebuild on the node (I1)",
			);
		digests.set(component, match[1]);
		pinned.set(component, String(image));
	}
	if (
		minInstances !== undefined &&
		(!isJsonNumber(minInstances) ||
			!Number.isSafeInteger(minInstances) ||
			minInstances < 1 ||
			minInstances > 1000)
	)
		reject("Flux desired.minInstances must be an integer from 1 to 1000");
	return {
		request,
		appName,
		owner,
		digests,
		images: pinned,
		minInstances: isJsonNumber(minInstances) ? minInstances : undefined,
	};
}

async function readJson(
	transport: HttpTransport,
	path: string,
): Promise<JsonObject> {
	let response: TransportResponse;
	try {
		response = await transport({
			method: "GET",
			url: `${FLUX_API_ORIGIN}${path}`,
			headers: { accept: "application/json" },
			timeoutMs: TIMEOUT_MS,
			maxResponseBytes: MAX_RESPONSE_BYTES,
		});
	} catch (error) {
		if (error instanceof ResolverError) throw error;
		reject(
			"FluxOS API read failed in transport",
			"retry the reconcile; reads are side-effect free",
		);
	}
	if (response.status < 200 || response.status >= 300)
		reject(
			`FluxOS API returned HTTP ${response.status}`,
			"retry the reconcile; reads are side-effect free",
		);
	let body: JsonValue;
	try {
		// SAFETY: JSON.parse yields a JSON value at this provider boundary.
		body = JSON.parse(response.body) as JsonValue;
	} catch {
		unparseable("FluxOS API returned a non-JSON body");
	}
	if (!isJsonObject(body) || !isJsonString(body.status))
		unparseable("FluxOS API envelope is malformed");
	return body;
}

async function observe(
	parsed: Target,
	supplied: HttpTransport,
): Promise<ResolveOutcome | undefined> {
	const transport = guardTransport(supplied, {
		allowedHosts: ["api.runonflux.io"],
		allowedPathPrefixes: ["/apps/appspecifications/", "/apps/location/"],
		maxTimeoutMs: TIMEOUT_MS,
		maxResponseBytes: MAX_RESPONSE_BYTES,
	});
	const envelope = await readJson(
		transport,
		`/apps/appspecifications/${parsed.appName}`,
	);
	// FluxOS answers an unknown app with status "error": not proof of absence (I5).
	if (envelope.status !== "success") return undefined;
	const spec = envelope.data;
	if (
		!isJsonObject(spec) ||
		!isJsonString(spec.name) ||
		!isJsonString(spec.owner) ||
		!isJsonNumber(spec.instances) ||
		!Number.isSafeInteger(spec.instances) ||
		spec.instances < 1 ||
		!isJsonArray(spec.compose) ||
		spec.compose.length === 0
	)
		unparseable(
			"FluxOS app specification is missing name, owner, instances or compose",
		);
	if (spec.name.toLowerCase() !== parsed.appName.toLowerCase())
		reject("FluxOS returned the specification of another app");
	if (spec.owner !== parsed.owner)
		reject(
			`Flux app ${parsed.appName} is registered to another owner`,
			"choose an app name your owner address registered; Flux app names are global",
		);
	const observed = new Map<string, string>();
	for (const component of spec.compose) {
		if (
			!isJsonObject(component) ||
			!isJsonString(component.name) ||
			!isJsonString(component.repotag)
		)
			unparseable("FluxOS compose component is missing name or repotag");
		observed.set(component.name, component.repotag);
	}
	const desiredNames = [...parsed.images.keys()].sort();
	const observedNames = [...observed.keys()].sort();
	if (desiredNames.join("\n") !== observedNames.join("\n"))
		reject(
			`Flux app ${parsed.appName} components [${observedNames.join(", ")}] differ from desired [${desiredNames.join(", ")}]`,
			`changing the compose needs an owner-signed appupdate; ${SIGNED_PATH}`,
		);
	for (const [component, image] of parsed.images)
		if (observed.get(component) !== image)
			reject(
				`Flux app ${parsed.appName} component ${component} runs another image`,
				`an image change needs an owner-signed appupdate; ${SIGNED_PATH}`,
			);
	const locations = await readJson(
		transport,
		`/apps/location/${parsed.appName}`,
	);
	if (locations.status !== "success" || !isJsonArray(locations.data))
		unparseable("FluxOS app location listing is malformed");
	const nodes = new Set<string>();
	for (const entry of locations.data) {
		if (!isJsonObject(entry) || !isJsonString(entry.ip))
			unparseable("FluxOS app location entry has no node address");
		nodes.add(entry.ip);
	}
	const required = Math.max(spec.instances, parsed.minInstances ?? 0);
	const ready = nodes.size >= required;
	const componentDigests: Record<string, string> = {};
	for (const [component, digest] of [...parsed.digests].sort(([a], [b]) =>
		a < b ? -1 : a > b ? 1 : 0,
	))
		componentDigests[component] = digest;
	const single =
		parsed.digests.size === 1 ? [...parsed.digests.values()][0] : undefined;
	const observedOutputs = {
		appName: parsed.appName,
		owner: parsed.owner,
		instances: spec.instances,
		requiredInstances: required,
		runningInstances: nodes.size,
		componentDigests,
		ready,
		operationConfirmed: ready,
		operationTerminal: ready,
		absenceConfirmed: false,
		lifecycleStatus: ready ? "ready" : "pending",
	};
	return {
		contract: RESOLVER_CONTRACT,
		action: parsed.request.ref.physicalId === parsed.appName ? "noop" : "adopt",
		physicalId: parsed.appName,
		// Only a single-component app has one artifact identity to report.
		outputs:
			single === undefined
				? observedOutputs
				: { ...observedOutputs, artifactDigest: single },
		diagnostics: ready
			? []
			: [
					`${nodes.size} of ${required} required instances are running; readiness is observed, never assumed`,
				],
	};
}

/** Build the Flux resolvers. Reads are public; nothing here holds a key. */
export function createFluxResolvers(): readonly ResourceResolver[] {
	const resolver: ResourceResolver = {
		providerId: PROVIDER_ID,
		productId: FLUX_APP_PRODUCT_ID,
		async read(raw, transport) {
			return observe(target(raw), transport);
		},
		async reconcile(raw, transport) {
			const parsed = target(raw);
			const observed = await observe(parsed, transport);
			if (!observed)
				reject(
					`Flux app ${parsed.appName} is not registered; registration needs the owner's wallet signature and payment, which HoBo never holds`,
					SIGNED_PATH,
				);
			return observed;
		},
		async delete(raw) {
			const parsed = target(raw);
			reject(
				`Flux app ${parsed.appName} is not removed by HoBo; removal is an owner-signed act or expiry of the subscription`,
				"remove it with the owner's wallet, or let the subscription expire, then reconcile to observe it gone",
			);
		},
	};
	return Object.freeze([resolver]);
}

/** Registry of every Flux hosting product with a shipped resolver (I14). */
export function fluxResolverRegistry(options: FluxResolverOptions = {}) {
	return createResolverRegistry(
		instrumentResolvers(createFluxResolvers(), options),
	);
}
