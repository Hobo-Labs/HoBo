/**
 * Direct DigitalOcean API v2 resource resolvers — the default deployment path.
 *
 * Why this module exists: a provider package that publishes an allocatable Yard
 * catalog and ships no `ResourceResolver` fails closed on every deploy. These
 * resolvers close that gap the way the Cloudflare, GCP and AWS ones do: a
 * `ResourceResolver` per product, talking to `api.digitalocean.com/v2` over an
 * injected, guarded transport, with no IaC engine and no state file in the
 * middle.
 *
 * The property that makes that safe is **convergence**. DigitalOcean's v2
 * collections are keyed by a server-assigned `id`, not by the name the caller
 * chose, so "does my resource already exist" is a *listing* question rather
 * than a GET. Every `reconcile()` here therefore pages the collection — under a
 * bounded page budget, never an unbounded loop — looking for the
 * deterministically-named record *before* it creates anything, then applies
 * only the mutable deltas. Running it twice yields the same `physicalId`,
 * exactly one resource, and exactly one create call, which is what makes a
 * crashed half-apply safe to re-run instead of something an operator
 * reconciles by hand. `delete()` treats "already gone" as success for the same
 * reason. `"replace"` is never emitted: replacing a database or a Droplet
 * destroys data, so drift on an immutable field (region, engine, image) is
 * reported as a diagnostic and left for a human.
 *
 * A name that matches more than one record is refused rather than resolved.
 * DigitalOcean does not enforce name uniqueness on Droplets or Load Balancers,
 * and picking "the first one" would make `physicalId` depend on listing order —
 * which is exactly how a reconcile starts silently managing somebody else's
 * resource.
 *
 * Provisioning is asynchronous and this module says so rather than reporting a
 * `create` as ready. A database comes back `status: "creating"`, an app comes
 * back with no `live_url` and a Droplet comes back `status: "new"`; each of
 * those lands in `diagnostics` as *accepted, not confirmed*. There is no
 * polling here at all: a resolver that blocks a deploy on a provider's
 * provisioning clock is worse than one that reports the truth and lets the
 * caller decide.
 *
 * A product with no convergent path ships **no resolver** rather than a
 * plausible one — see {@link DIGITALOCEAN_UNRESOLVED_PRODUCT_IDS}, which names
 * each one and why. A resolver that duplicates a resource on every retry is
 * worse than an absent one.
 *
 * Credentials are locators, never material. A resolver is constructed with an
 * injected `resolveCredential(ref)`; `ResolveRequest.credentialRef` must be a
 * `scheme://…` locator — the grammar core's `parseResolveRequest` enforces —
 * and a value that looks like the personal access token itself is refused,
 * because a raw token in a request record is a token in the event log. The
 * token reaches exactly one place: the `authorization` header. It is never
 * logged, never put in `outputs`, and DigitalOcean's error text is redacted
 * before it reaches a message.
 *
 * Determinism: no clock, no randomness, no environment reads.
 *
 * HONEST SCOPE (also in the README):
 *   - These resolvers are exercised against an *injected fake* transport
 *     modelling a DigitalOcean team. Nothing in this package proves a live
 *     deploy: that additionally needs a real token, real network egress, and a
 *     real DigitalOcean account, none of which a unit test supplies.
 *   - The endpoint paths, request bodies and response field names below are
 *     written from DigitalOcean's published API reference. They have not been
 *     replayed against the running service, so a field DigitalOcean has since
 *     renamed would fail at deploy time, not here.
 *   - Coverage is a slice of each product's API — enough to allocate, observe,
 *     converge and remove — and explicitly not the whole surface.
 *   - The `productId` strings are read off the `./slots.js` factories, so the
 *     registry and the Yard catalog cannot drift apart. Whether a matching
 *     Resource Definition is registered is still checked at resolution time
 *     (`YARD_BINDING_PRODUCT_UNKNOWN`), not here.
 */

import {
	createResolverRegistry,
	type HttpTransport,
	RESOLVER_CONTRACT,
	type ResolveOutcome,
	type ResolveRequest,
	type ResolverAction,
	ResolverError,
	type ResourceResolver,
	type SlotBinding,
	type TransportMethod,
	type TransportResponse,
} from "@hobo/core";

import { type AwsCredentials, signAwsRequest } from "@hobo/core/aws-sigv4";

import {
	isJsonBoolean,
	isJsonNumber,
	isJsonObject,
	isJsonString,
	type JsonObject,
	type JsonValue,
	parseJsonObject,
} from "./json.js";
import { DIGITALOCEAN_PROVIDER_TARGET } from "./options.js";
import {
	appPlatform,
	blockStorage,
	droplet,
	functions,
	kubernetesCluster,
	loadBalancer,
	managed,
	managedValkey,
	spaces,
} from "./slots.js";
import {
	DIGITALOCEAN_MAX_RESPONSE_BYTES,
	DIGITALOCEAN_MAX_TIMEOUT_MS,
	digitaloceanApiUrl,
	functionsUrl,
	guardedDigitalOceanTransport,
	guardedFunctionsTransport,
	guardedSpacesTransport,
	spacesUrl,
} from "./transport.js";

// ---------------------------------------------------------------------------
// Product ids — read off the slot factories so the registry cannot drift from
// the catalog it is supposed to serve.
// ---------------------------------------------------------------------------

function productIdOf(binding: SlotBinding, factory: string): string {
	const { productId } = binding;
	if (productId === undefined) {
		throw new ResolverError(
			"RESOLVER_PRODUCT_UNSUPPORTED",
			`slot factory ${factory}() emitted a binding without a productId, so no resolver can be keyed to it`,
		);
	}
	return productId;
}

export const DIGITALOCEAN_APP_SERVICE_PRODUCT_ID = productIdOf(
	appPlatform.service(),
	"appPlatform.service",
);
export const DIGITALOCEAN_APP_STATIC_SITE_PRODUCT_ID = productIdOf(
	appPlatform.staticSite(),
	"appPlatform.staticSite",
);
export const DIGITALOCEAN_APP_WORKER_PRODUCT_ID = productIdOf(
	appPlatform.worker(),
	"appPlatform.worker",
);
export const DIGITALOCEAN_APP_JOB_PRODUCT_ID = productIdOf(
	appPlatform.job(),
	"appPlatform.job",
);
export const DIGITALOCEAN_FUNCTIONS_PRODUCT_ID = productIdOf(
	functions(),
	"functions",
);
export const DIGITALOCEAN_DROPLET_PRODUCT_ID = productIdOf(
	droplet(),
	"droplet",
);
export const DIGITALOCEAN_LOAD_BALANCER_PRODUCT_ID = productIdOf(
	loadBalancer(),
	"loadBalancer",
);
export const DIGITALOCEAN_MANAGED_MONGODB_PRODUCT_ID = productIdOf(
	managed.mongodb(),
	"managed.mongodb",
);
export const DIGITALOCEAN_MANAGED_MYSQL_PRODUCT_ID = productIdOf(
	managed.mysql(),
	"managed.mysql",
);
export const DIGITALOCEAN_MANAGED_OPENSEARCH_PRODUCT_ID = productIdOf(
	managed.opensearch(),
	"managed.opensearch",
);
export const DIGITALOCEAN_MANAGED_POSTGRES_PRODUCT_ID = productIdOf(
	managed.postgres(),
	"managed.postgres",
);
export const DIGITALOCEAN_MANAGED_VALKEY_PRODUCT_ID = productIdOf(
	managedValkey(),
	"managedValkey",
);
export const DIGITALOCEAN_SPACES_PRODUCT_ID = productIdOf(spaces(), "spaces");
export const DIGITALOCEAN_BLOCK_STORAGE_PRODUCT_ID = productIdOf(
	blockStorage(),
	"blockStorage",
);
export const DIGITALOCEAN_KUBERNETES_CLUSTER_PRODUCT_ID = productIdOf(
	kubernetesCluster(),
	"kubernetesCluster",
);

/** Every product this module resolves, id-sorted for a deterministic registry. */
export const DIGITALOCEAN_RESOLVED_PRODUCT_IDS: readonly string[] =
	Object.freeze(
		[
			DIGITALOCEAN_APP_SERVICE_PRODUCT_ID,
			DIGITALOCEAN_APP_STATIC_SITE_PRODUCT_ID,
			DIGITALOCEAN_DROPLET_PRODUCT_ID,
			DIGITALOCEAN_LOAD_BALANCER_PRODUCT_ID,
			DIGITALOCEAN_MANAGED_MONGODB_PRODUCT_ID,
			DIGITALOCEAN_MANAGED_MYSQL_PRODUCT_ID,
			DIGITALOCEAN_MANAGED_OPENSEARCH_PRODUCT_ID,
			DIGITALOCEAN_MANAGED_POSTGRES_PRODUCT_ID,
			DIGITALOCEAN_MANAGED_VALKEY_PRODUCT_ID,
			DIGITALOCEAN_SPACES_PRODUCT_ID,
			DIGITALOCEAN_BLOCK_STORAGE_PRODUCT_ID,
			DIGITALOCEAN_KUBERNETES_CLUSTER_PRODUCT_ID,
			DIGITALOCEAN_APP_WORKER_PRODUCT_ID,
			DIGITALOCEAN_APP_JOB_PRODUCT_ID,
			DIGITALOCEAN_FUNCTIONS_PRODUCT_ID,
		].sort(compareStrings),
	);

/**
 * Product ids this package catalogs but does not resolve.
 *
 * Empty. Every product in the DigitalOcean catalog has a convergent path.
 *
 * It is exported anyway, and the tests still assert that resolved + unresolved
 * accounts for the catalog exactly once. The list existing and being empty is a
 * different claim from the list not existing: a product added to `./slots.ts`
 * without a resolver has to be named here, and that is a decision a reviewer
 * sees rather than a gap nobody counted.
 */
export const DIGITALOCEAN_UNRESOLVED_PRODUCT_IDS: readonly string[] =
	Object.freeze([]);

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

/** What a host must supply to build the resolvers. */
export interface DigitalOceanResolverOptions {
	/**
	 * Resolves a credential *locator* to a DigitalOcean personal access token.
	 * Injected so the resolver never holds a secret and never decides where
	 * secrets live.
	 */
	readonly resolveCredential: (ref: string) => Promise<string>;
	/**
	 * How many pages of a collection a lookup may read before it refuses.
	 * Bounded on purpose: an unbounded listing is an unbounded deploy, and a
	 * team with more resources than this budget covers should say so rather
	 * than have the resolver silently conclude "not found" and create a
	 * duplicate. Defaults to {@link DEFAULT_MAX_LIST_PAGES}.
	 */
	readonly maxListPages?: number;
	/**
	 * Resolves a credential *locator* to a Spaces access key pair. Separate
	 * from `resolveCredential` because Spaces is a separate credential: the
	 * control-plane personal access token does not authenticate against
	 * `<region>.digitaloceanspaces.com`, and letting one function serve both
	 * would invite sending the wrong secret to the wrong origin. Required only
	 * to build the Spaces resolver.
	 */
	readonly resolveSpacesCredential?: (ref: string) => Promise<SpacesKeyPair>;
	/**
	 * SigV4 signing clock, injected. Reading `Date.now()` inside the resolver
	 * would make a signed request untestable, which is the same reason the AWS
	 * provider takes one. Required only to build the Spaces resolver.
	 */
	readonly nowMs?: number | (() => number);
}

/** A Spaces access key pair, as the host's custody hands it over. */
export interface SpacesKeyPair {
	readonly accessKeyId: string;
	readonly secretAccessKey: string;
}

/** Twenty pages of 200 records: 4,000 resources before a listing refuses. */
export const DEFAULT_MAX_LIST_PAGES = 20;

/** Records per page requested from a collection endpoint. */
const PAGE_SIZE = 200;

/**
 * A credential locator, using the same grammar core's `parseResolveRequest`
 * enforces (`scheme://path`, no userinfo). Restated here rather than imported
 * because a resolver must refuse a bad ref even when a caller skipped the parse
 * boundary — and a second grammar would be a second answer.
 */
const CREDENTIAL_REF_PATTERN = /^[a-z][a-z0-9+.-]*:\/\/[^\s@]+$/u;

/**
 * What a DigitalOcean personal access token looks like when someone pastes the
 * value into `credentialRef` by mistake. Refusing this shape is the difference
 * between a locator in the event log and a live token in the event log.
 */
const RAW_CREDENTIAL_PATTERN = /^(?:dop_v1_)?[A-Za-z0-9_-]{32,}$/u;

/** Anything long and token-shaped is scrubbed out of provider error text. */
const TOKEN_PATTERN = /[A-Za-z0-9_-]{20,}/gu;

/**
 * Redact provider text before it reaches a message, a diagnostic, or a log.
 * DigitalOcean echoes request context in `message`, and that context has
 * carried resource ids and token fragments before.
 */
export function redactDigitalOceanText(text: string, limit = 400): string {
	const scrubbed = text.replace(TOKEN_PATTERN, "[redacted]");
	return scrubbed.length > limit ? `${scrubbed.slice(0, limit)}…` : scrubbed;
}

// ---------------------------------------------------------------------------
// Small shared parsers
// ---------------------------------------------------------------------------

function compareStrings(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function optionalString(
	record: JsonObject | undefined,
	key: string,
): string | undefined {
	if (record === undefined) return undefined;
	const value = record[key];
	return isJsonString(value) && value.trim().length > 0 ? value : undefined;
}

function optionalBoolean(
	record: JsonObject | undefined,
	key: string,
): boolean | undefined {
	if (record === undefined) return undefined;
	const value = record[key];
	return isJsonBoolean(value) ? value : undefined;
}

function optionalInteger(
	record: JsonObject | undefined,
	key: string,
): number | undefined {
	if (record === undefined) return undefined;
	const value = record[key];
	return isJsonNumber(value) && Number.isSafeInteger(value) ? value : undefined;
}

function requestedMarker(
	context: DigitalOceanResolverContext,
	key: "artifactDigest" | "ownershipRef",
): string | undefined {
	const value = context.desired[key];
	if (value === undefined) return undefined;
	if (!isJsonString(value) || !/^sha256:[a-f0-9]{64}$/u.test(value))
		throw new ResolverError(
			"RESOLVER_PRODUCT_UNSUPPORTED",
			`desired.${key} must be a canonical sha256 reference`,
		);
	return value;
}

function markerTags(context: DigitalOceanResolverContext): string[] {
	const tags = Array.isArray(context.desired.tags) ? context.desired.tags : [];
	if (tags.some((tag) => !isJsonString(tag)))
		throw new ResolverError(
			"RESOLVER_PRODUCT_UNSUPPORTED",
			"desired.tags must contain strings",
		);
	const result = tags.filter(isJsonString);
	for (const [key, prefix] of [
		["artifactDigest", "hobo-artifact:"],
		["ownershipRef", "hobo-owner:"],
	] as const) {
		const value = requestedMarker(context, key);
		if (value !== undefined) {
			if (result.some((tag) => tag.startsWith(prefix)))
				throw new ResolverError(
					"RESOLVER_PRODUCT_UNSUPPORTED",
					"reserved hosting marker tags must be supplied through their dedicated fields",
				);
			result.push(`${prefix}${value}`);
		}
	}
	return result.sort(compareStrings);
}

function observedTagMarkers(record: JsonObject): JsonObject {
	const tags = Array.isArray(record.tags)
		? record.tags.filter(isJsonString)
		: [];
	const markers: JsonObject = {};
	for (const [key, prefix] of [
		["artifactDigest", "hobo-artifact:"],
		["ownershipRef", "hobo-owner:"],
	] as const) {
		const matches = tags.filter((tag) => tag.startsWith(prefix));
		if (matches.length > 1)
			throw new ResolverError(
				"RESOLVER_OUTPUT_UNPARSEABLE",
				"provider returned ambiguous hosting marker tags",
			);
		const value = matches[0]?.slice(prefix.length);
		if (value !== undefined) {
			if (!/^sha256:[a-f0-9]{64}$/u.test(value))
				throw new ResolverError(
					"RESOLVER_OUTPUT_UNPARSEABLE",
					"provider returned an invalid hosting marker tag",
				);
			Object.assign(markers, { [key]: value });
		}
	}
	return markers;
}

function markerEnvs(
	context: DigitalOceanResolverContext,
	raw: JsonValue | undefined,
): JsonObject[] {
	const envs = Array.isArray(raw) ? raw.filter(isJsonObject) : [];
	const result = [...envs];
	for (const [key, name] of [
		["artifactDigest", "HOBO_ARTIFACT_DIGEST"],
		["ownershipRef", "HOBO_OWNERSHIP_REF"],
	] as const) {
		const value = requestedMarker(context, key);
		if (value !== undefined) {
			if (envs.some((env) => env.key === name))
				throw new ResolverError(
					"RESOLVER_PRODUCT_UNSUPPORTED",
					"reserved hosting environment markers must be supplied through their dedicated fields",
				);
			result.push({ key: name, value, type: "GENERAL", scope: "RUN_TIME" });
		}
	}
	return result;
}

function observedEnvMarkers(record: JsonObject): JsonObject {
	const envs = Array.isArray(record.envs)
		? record.envs.filter(isJsonObject)
		: [];
	const markers: JsonObject = {};
	for (const [key, name] of [
		["artifactDigest", "HOBO_ARTIFACT_DIGEST"],
		["ownershipRef", "HOBO_OWNERSHIP_REF"],
	] as const) {
		const matches = envs.filter((env) => env.key === name);
		if (matches.length > 1)
			throw new ResolverError(
				"RESOLVER_OUTPUT_UNPARSEABLE",
				"provider returned ambiguous hosting environment markers",
			);
		const value = matches[0]?.value;
		if (value !== undefined) {
			if (!isJsonString(value) || !/^sha256:[a-f0-9]{64}$/u.test(value))
				throw new ResolverError(
					"RESOLVER_OUTPUT_UNPARSEABLE",
					"provider returned invalid hosting environment markers",
				);
			Object.assign(markers, { [key]: value });
		}
	}
	return markers;
}

function nestedRecord(record: JsonObject | undefined, key: string): JsonObject {
	if (record === undefined) return {};
	const value = record[key];
	return isJsonObject(value) ? value : {};
}

function desiredOf(request: ResolveRequest): JsonObject {
	return parseJsonObject(JSON.stringify(request.desired));
}

/** DigitalOcean ids are numbers on Droplets and UUID strings elsewhere. */
function identityOf(record: JsonObject, label: string): string {
	const value = record.id;
	if (isJsonString(value) && value.trim().length > 0) return value;
	if (isJsonNumber(value) && Number.isSafeInteger(value)) {
		return String(value);
	}
	throw new ResolverError(
		"RESOLVER_OUTPUT_UNPARSEABLE",
		`${label}: DigitalOcean returned a record without a usable id, so the resource cannot be addressed`,
	);
}

// ---------------------------------------------------------------------------
// The wire
// ---------------------------------------------------------------------------

interface DigitalOceanCall {
	readonly method: TransportMethod;
	/** Host-relative, with every dynamic segment already encoded. */
	readonly path: string;
	readonly json?: unknown;
}

/**
 * Send one call, through the guard. The guard is applied here rather than left
 * to the caller: an unguarded transport slipping through would be a
 * legal-TypeScript security defect, and the token is in the header of every one
 * of these requests.
 */
async function send(
	context: DigitalOceanResolverContext,
	call: DigitalOceanCall,
): Promise<TransportResponse> {
	const body = call.json === undefined ? undefined : JSON.stringify(call.json);
	const guarded = guardedDigitalOceanTransport(context.transport);
	return guarded({
		method: call.method,
		url: digitaloceanApiUrl(call.path),
		headers: {
			accept: "application/json",
			authorization: `Bearer ${context.token}`,
			...(body !== undefined
				? { "content-type": "application/json" }
				: undefined),
		},
		...(body !== undefined ? { body } : undefined),
		timeoutMs: DIGITALOCEAN_MAX_TIMEOUT_MS,
		maxResponseBytes: DIGITALOCEAN_MAX_RESPONSE_BYTES,
	});
}

function isNotFound(response: TransportResponse): boolean {
	return response.status === 404;
}

/**
 * Parse a JSON body. An empty body on a success status is `{}` —
 * DigitalOcean answers deletes with `204 No Content` — and anything else that
 * is not a JSON object is `RESOLVER_OUTPUT_UNPARSEABLE`, because a body this
 * code cannot read leaves the outcome of the call unknown, and an unknown
 * outcome is refused rather than assumed.
 */
function parseJsonRecord(
	response: TransportResponse,
	label: string,
): JsonObject {
	if (response.body.trim().length === 0) return {};
	let parsed: JsonValue;
	try {
		// SAFETY: JSON.parse yields a JSON value at this DigitalOcean document boundary.
		parsed = JSON.parse(response.body) as JsonValue;
	} catch {
		throw new ResolverError(
			"RESOLVER_OUTPUT_UNPARSEABLE",
			`${label}: DigitalOcean returned a status ${response.status} body that is not JSON, so the outcome of the call is unknown and it is refused rather than assumed`,
		);
	}
	if (!isJsonObject(parsed)) {
		throw new ResolverError(
			"RESOLVER_OUTPUT_UNPARSEABLE",
			`${label}: DigitalOcean returned JSON that is not an object (status ${response.status}), so the resource it describes cannot be identified`,
		);
	}
	return parsed;
}

/**
 * The refusal path. DigitalOcean's error envelope is
 * `{"id":"unprocessable_entity","message":"…"}`; the message is redacted
 * before it is quoted, because provider text is the most common way a token
 * fragment or a caller's private path reaches a log.
 */
function providerRejection(
	response: TransportResponse,
	label: string,
): ResolverError {
	let detail = "no error detail was returned";
	try {
		const record = parseJsonRecord(response, label);
		const id = optionalString(record, "id");
		const message = optionalString(record, "message");
		const parts = [id, message].filter(
			(part): part is string => part !== undefined,
		);
		if (parts.length > 0) {
			detail = redactDigitalOceanText(parts.join(": "));
		}
	} catch {
		const snippet = response.body.trim();
		if (snippet.length > 0) detail = redactDigitalOceanText(snippet, 160);
	}
	return new ResolverError(
		"RESOLVER_PROVIDER_REJECTED",
		`${label}: DigitalOcean refused the call with status ${response.status}: ${detail}`,
	);
}

/** A successful response as a record; any 4xx/5xx is a typed refusal. */
function expectOk(response: TransportResponse, label: string): JsonObject {
	if (response.status >= 400) throw providerRejection(response, label);
	return parseJsonRecord(response, label);
}

// ---------------------------------------------------------------------------
// Resolver plumbing
// ---------------------------------------------------------------------------

/** Everything a resolver body needs, with the credential already resolved. */
interface DigitalOceanResolverContext {
	readonly request: ResolveRequest;
	readonly transport: HttpTransport;
	readonly token: string;
	/** The deterministic resource name: `desired.name`, else the logical id. */
	readonly name: string;
	readonly desired: JsonObject;
	/** True when the caller already knows the physical id (adopt vs noop). */
	readonly knownPhysicalId: string | undefined;
	readonly maxListPages: number;
	/** Present only on the Spaces path; undefined elsewhere by construction. */
	readonly spacesKeys: SpacesKeyPair | undefined;
	/** Injected SigV4 clock. Only the Spaces path signs. */
	readonly nowMs: () => number;
}

function outcome(
	action: ResolverAction,
	physicalId: string,
	outputs: { readonly [key: string]: JsonValue | undefined },
	diagnostics: readonly string[],
): ResolveOutcome {
	return Object.freeze({
		contract: RESOLVER_CONTRACT,
		action,
		physicalId,
		outputs: Object.freeze(parseJsonObject(JSON.stringify(outputs))),
		diagnostics: Object.freeze([...diagnostics]),
	});
}

/**
 * Existing resource, no delta: `noop` when the caller already named it, `adopt`
 * when the resolver found something the request did not know about. The
 * distinction is the audit record — adopting an unmanaged resource is a fact an
 * operator should see, not something folded into "nothing happened".
 */
function settledAction(context: DigitalOceanResolverContext): ResolverAction {
	return context.knownPhysicalId === undefined ? "adopt" : "noop";
}

function assertListPages(pages: number | undefined): number {
	if (pages === undefined) return DEFAULT_MAX_LIST_PAGES;
	if (!Number.isSafeInteger(pages) || pages < 1 || pages > 500) {
		throw new ResolverError(
			"RESOLVER_PRODUCT_UNSUPPORTED",
			`digitalocean resolvers need a bounded maxListPages between 1 and 500, received ${JSON.stringify(pages)}; an unbounded listing is an unbounded deploy`,
		);
	}
	return pages;
}

/**
 * The credential parse boundary. A blank ref is `RESOLVER_CREDENTIAL_MISSING`
 * (with remediation), a token-shaped one is `RESOLVER_CREDENTIAL_NOT_A_REF` — a
 * raw secret in a request record has already leaked by the time it is used —
 * and a host that hands back nothing is missing, never "carry on
 * unauthenticated", which would surface at DigitalOcean as a confusing 401.
 */
async function resolveToken(
	request: ResolveRequest,
	resolve: (ref: string) => Promise<string>,
): Promise<string> {
	const ref = request.credentialRef;
	if (ref.trim().length === 0) {
		throw new ResolverError(
			"RESOLVER_CREDENTIAL_MISSING",
			'digitalocean resolver: credentialRef is empty. Supply a locator such as "env://DIGITALOCEAN_TOKEN" or "secret://camp/digitalocean-pat" and register it with the host credential resolver; the resolver never accepts inline credential material',
		);
	}
	const trimmed = ref.trim();
	if (RAW_CREDENTIAL_PATTERN.test(trimmed)) {
		throw new ResolverError(
			"RESOLVER_CREDENTIAL_NOT_A_REF",
			"digitalocean resolver: credentialRef looks like credential material rather than a locator. Store the personal access token with the host secret custody and pass its reference (scheme://path); a raw token in a ResolveRequest is a token in the event log",
		);
	}
	if (!CREDENTIAL_REF_PATTERN.test(trimmed)) {
		throw new ResolverError(
			"RESOLVER_CREDENTIAL_NOT_A_REF",
			`digitalocean resolver: credentialRef ${JSON.stringify(redactDigitalOceanText(trimmed, 60))} is not a locator. Expected "<scheme>://<path>", for example "env://DIGITALOCEAN_TOKEN"`,
		);
	}
	let material: string;
	try {
		material = await resolve(trimmed);
	} catch (cause) {
		throw new ResolverError(
			"RESOLVER_CREDENTIAL_MISSING",
			`digitalocean resolver: the host could not resolve credentialRef ${JSON.stringify(trimmed)}: ${redactDigitalOceanText(
				cause instanceof Error ? cause.message : String(cause),
				160,
			)}. Register the reference with the credential resolver before deploying`,
		);
	}
	if (material.trim().length === 0) {
		throw new ResolverError(
			"RESOLVER_CREDENTIAL_MISSING",
			`digitalocean resolver: credentialRef ${JSON.stringify(trimmed)} resolved to nothing. A missing credential is refused rather than retried unauthenticated, which would look like a permissions error at DigitalOcean`,
		);
	}
	return material.trim();
}

/**
 * The Spaces credential parse boundary. Same discipline as `resolveToken`: the
 * ref must be a locator, the host resolves it, and a pair with an empty half is
 * refused rather than sent as a half-signed request.
 */
async function resolveSpacesKeys(
	request: ResolveRequest,
	resolve: ((ref: string) => Promise<SpacesKeyPair>) | undefined,
): Promise<SpacesKeyPair> {
	if (resolve === undefined) {
		throw new ResolverError(
			"RESOLVER_CREDENTIAL_MISSING",
			"digitalocean spaces resolver: no resolveSpacesCredential was injected",
		);
	}
	const ref = request.credentialRef;
	if (ref.trim().length === 0) {
		throw new ResolverError(
			"RESOLVER_CREDENTIAL_MISSING",
			'digitalocean spaces resolver: credentialRef is empty. Supply a locator such as "secret://camp/digitalocean-spaces-keys"; the resolver never accepts inline credential material',
		);
	}
	const trimmed = ref.trim();
	if (RAW_CREDENTIAL_PATTERN.test(trimmed)) {
		throw new ResolverError(
			"RESOLVER_CREDENTIAL_NOT_A_REF",
			"digitalocean spaces resolver: credentialRef looks like credential material rather than a locator. Store the Spaces key pair with the host secret custody and pass its reference (scheme://path)",
		);
	}
	if (!CREDENTIAL_REF_PATTERN.test(trimmed)) {
		throw new ResolverError(
			"RESOLVER_CREDENTIAL_NOT_A_REF",
			`digitalocean spaces resolver: credentialRef ${JSON.stringify(redactDigitalOceanText(trimmed, 60))} is not a locator. Expected "<scheme>://<path>"`,
		);
	}
	let keys: SpacesKeyPair;
	try {
		keys = await resolve(trimmed);
	} catch (cause) {
		throw new ResolverError(
			"RESOLVER_CREDENTIAL_MISSING",
			`digitalocean spaces resolver: the host could not resolve credentialRef ${JSON.stringify(trimmed)}: ${redactDigitalOceanText(
				cause instanceof Error ? cause.message : String(cause),
				160,
			)}`,
		);
	}
	if (
		keys.accessKeyId.trim().length === 0 ||
		keys.secretAccessKey.trim().length === 0
	) {
		throw new ResolverError(
			"RESOLVER_CREDENTIAL_MISSING",
			`digitalocean spaces resolver: credentialRef ${JSON.stringify(trimmed)} resolved to an incomplete key pair. A half-populated pair would produce a signature that fails at Spaces with a message about the wrong thing`,
		);
	}
	return {
		accessKeyId: keys.accessKeyId,
		secretAccessKey: keys.secretAccessKey,
	};
}

function resourceName(request: ResolveRequest, productId: string): string {
	const desiredName = optionalString(desiredOf(request), "name");
	if (desiredName !== undefined) return desiredName;
	const logicalId = request.ref.logicalId;
	if (logicalId.trim().length > 0) {
		return logicalId;
	}
	throw new ResolverError(
		"RESOLVER_PRODUCT_UNSUPPORTED",
		`${productId}: the request names no resource — set desired.name or ref.logicalId. The name is what makes reconcile convergent, so it is never generated here`,
	);
}

/** The physical id the caller already knows, if it supplied a usable one. */
function knownPhysicalId(request: ResolveRequest): string | undefined {
	const value = request.ref.physicalId;
	return value !== undefined && value.trim().length > 0 ? value : undefined;
}

/**
 * The region a regional product needs. Never defaulted: a resource silently
 * created in `nyc3` because nobody said otherwise is a residency incident, not
 * a convenience.
 */
function requiredRegion(
	context: DigitalOceanResolverContext,
	productId: string,
): string {
	const region =
		optionalString(context.desired, "region") ??
		optionalString(context.desired, "location");
	if (region === undefined) {
		throw new ResolverError(
			"RESOLVER_PRODUCT_UNSUPPORTED",
			`${productId}: the request names no region — set desired.region, for example "nyc3". A region is never chosen here, because a resource placed in an unrequested region is a residency decision this resolver may not take`,
		);
	}
	return region;
}

function requiredString(
	context: DigitalOceanResolverContext,
	key: string,
	productId: string,
	example: string,
): string {
	const value = optionalString(context.desired, key);
	if (value === undefined) {
		throw new ResolverError(
			"RESOLVER_PRODUCT_UNSUPPORTED",
			`${productId}: the request names no ${key} — set desired.${key}, for example ${JSON.stringify(example)}. This resolver invents no plan size or image, because a resource billed at a size nobody asked for is a cost incident`,
		);
	}
	return value;
}

// ---------------------------------------------------------------------------
// Collections: page, then match by name
// ---------------------------------------------------------------------------

/** How one collection is shaped: its path, its list key, and its item key. */
interface Collection {
	/** `/v2/databases`, `/v2/droplets`, … */
	readonly path: string;
	/** The array key in a list response: `databases`, `droplets`, … */
	readonly listKey: string;
	/** The object key in a single-item response: `database`, `droplet`, … */
	readonly itemKey: string;
	/** Reads the caller-visible name off one record. */
	readonly nameOf: (record: JsonObject) => string | undefined;
}

function listPath(collection: Collection, page: number): string {
	return `${collection.path}?page=${page}&per_page=${PAGE_SIZE}`;
}

/**
 * Find the single record carrying this name, paging under the injected budget.
 *
 * Two records with the same name is a refusal, not a coin flip: DigitalOcean
 * does not enforce name uniqueness on Droplets or Load Balancers, and picking
 * the first would make `physicalId` depend on listing order — which is how a
 * reconcile starts silently managing somebody else's resource.
 *
 * Running out of pages is also a refusal. Concluding "not found" from an
 * exhausted budget would create a duplicate of a resource that exists on the
 * page nobody read.
 */
async function findByName(
	context: DigitalOceanResolverContext,
	collection: Collection,
): Promise<JsonObject | undefined> {
	const label = `digitalocean list ${collection.listKey} for ${context.name}`;
	if (context.knownPhysicalId !== undefined) {
		const response = await send(context, {
			method: "GET",
			path: `${collection.path}/${encodeURIComponent(context.knownPhysicalId)}`,
		});
		if (isNotFound(response)) return undefined;
		const record = nestedRecord(expectOk(response, label), collection.itemKey);
		if (identityOf(record, label) !== context.knownPhysicalId)
			throw new ResolverError(
				"RESOLVER_OUTPUT_UNPARSEABLE",
				`${label}: physical identity differs from the pinned resource`,
			);
		return record;
	}
	const matches: JsonObject[] = [];
	for (let page = 1; page <= context.maxListPages; page += 1) {
		const record = expectOk(
			await send(context, { method: "GET", path: listPath(collection, page) }),
			label,
		);
		const items = record[collection.listKey];
		if (!Array.isArray(items)) {
			throw new ResolverError(
				"RESOLVER_OUTPUT_UNPARSEABLE",
				`${label}: DigitalOcean returned a page without a ${JSON.stringify(collection.listKey)} array, so the collection cannot be searched and a create would risk duplicating an existing resource`,
			);
		}
		if (
			items.some(
				(item) => !isJsonObject(item) || collection.nameOf(item) === undefined,
			)
		)
			throw new ResolverError(
				"RESOLVER_OUTPUT_UNPARSEABLE",
				`${label}: an incomplete collection record cannot establish absence or uniqueness`,
			);
		for (const item of items) {
			if (isJsonObject(item) && collection.nameOf(item) === context.name) {
				matches.push(item);
			}
		}
		if (items.length < PAGE_SIZE) {
			if (matches.length > 1) throw ambiguous(context, collection);
			return matches[0];
		}
	}
	if (matches.length > 1) throw ambiguous(context, collection);
	throw new ResolverError(
		"RESOLVER_PROVIDER_REJECTED",
		`digitalocean ${collection.listKey}: read ${context.maxListPages} pages of ${PAGE_SIZE} without reaching the end of the collection. Neither uniqueness nor absence of ${JSON.stringify(context.name)} has been proven, so the lookup refuses to adopt or create from an exhausted page budget; raise maxListPages if the team really is this large`,
	);
}

function ambiguous(
	context: DigitalOceanResolverContext,
	collection: Collection,
): ResolverError {
	return new ResolverError(
		"RESOLVER_PROVIDER_REJECTED",
		`digitalocean ${collection.listKey}: more than one record is named ${JSON.stringify(context.name)}. DigitalOcean does not enforce name uniqueness here, and choosing one by listing order would make the managed resource depend on the order the API answered in; rename the duplicates or pass ref.physicalId`,
	);
}

// ---------------------------------------------------------------------------
// Managed databases — /v2/databases
// ---------------------------------------------------------------------------

const DATABASE_COLLECTION: Collection = Object.freeze({
	path: "/v2/databases",
	listKey: "databases",
	itemKey: "database",
	nameOf: (record: JsonObject) => optionalString(record, "name"),
});

/** Engine slugs the DigitalOcean API takes, per catalogued product. */
const DATABASE_ENGINES: Readonly<Record<string, string>> = Object.freeze({
	[DIGITALOCEAN_MANAGED_POSTGRES_PRODUCT_ID]: "pg",
	[DIGITALOCEAN_MANAGED_MYSQL_PRODUCT_ID]: "mysql",
	[DIGITALOCEAN_MANAGED_MONGODB_PRODUCT_ID]: "mongodb",
	[DIGITALOCEAN_MANAGED_OPENSEARCH_PRODUCT_ID]: "opensearch",
	[DIGITALOCEAN_MANAGED_VALKEY_PRODUCT_ID]: "valkey",
});

/**
 * Outputs never carry the connection URI. DigitalOcean returns
 * `connection.uri` with the password inline, and an output is a value the
 * deployment record keeps — so the host and port go out and the credential
 * stays where it was.
 */
function databaseOutputs(record: JsonObject) {
	const connection = nestedRecord(record, "connection");
	const host = optionalString(connection, "host");
	const port = optionalInteger(connection, "port");
	const database = optionalString(connection, "database");
	const user = optionalString(connection, "user");
	const status = optionalString(record, "status");
	const engine = optionalString(record, "engine");
	const version = optionalString(record, "version");
	return {
		ready: status === "online" && host !== undefined,
		...(optionalString(record, "name") !== undefined
			? { name: optionalString(record, "name") }
			: undefined),
		...(host !== undefined ? { host } : undefined),
		...(port !== undefined ? { port } : undefined),
		...(database !== undefined ? { database } : undefined),
		...(user !== undefined ? { user } : undefined),
		...(engine !== undefined ? { engine } : undefined),
		...(version !== undefined ? { version } : undefined),
		...(status !== undefined ? { status } : undefined),
	};
}

function databaseDiagnostics(
	context: DigitalOceanResolverContext,
	record: JsonObject,
	productId: string,
): readonly string[] {
	const diagnostics: string[] = [];
	const status = optionalString(record, "status");
	if (status !== undefined && status !== "online") {
		diagnostics.push(
			`database cluster is ${status}, not online: DigitalOcean provisions asynchronously and this resolver does not poll, so the create is accepted, not confirmed`,
		);
	}
	const wantedRegion = optionalString(context.desired, "region");
	const actualRegion = optionalString(record, "region");
	if (
		wantedRegion !== undefined &&
		actualRegion !== undefined &&
		wantedRegion !== actualRegion
	) {
		diagnostics.push(
			`database cluster is in ${actualRegion} but the request asks for ${wantedRegion}; a cluster's region is immutable and this resolver never replaces a database, so the drift is reported for a human rather than "fixed" by destroying the data`,
		);
	}
	const wantedEngine = DATABASE_ENGINES[productId];
	const actualEngine = optionalString(record, "engine");
	if (
		wantedEngine !== undefined &&
		actualEngine !== undefined &&
		wantedEngine !== actualEngine
	) {
		diagnostics.push(
			`cluster ${JSON.stringify(context.name)} runs engine ${actualEngine} but ${productId} allocates ${wantedEngine}; the engine is fixed at creation, so this is reported rather than silently adopted as the right product`,
		);
	}
	return diagnostics;
}

function databaseSpec(
	productId: string,
): Omit<DigitalOceanResolverSpec, "productId"> {
	const engine = DATABASE_ENGINES[productId];
	if (engine === undefined) {
		throw new ResolverError(
			"RESOLVER_PRODUCT_UNSUPPORTED",
			`digitalocean database resolver has no engine for ${productId}`,
		);
	}
	return {
		async read(context) {
			const observed = await findByName(context, DATABASE_COLLECTION);
			return observed === undefined
				? undefined
				: outcome(
						settledAction(context),
						identityOf(observed, `digitalocean read database ${context.name}`),
						databaseOutputs(observed),
						databaseDiagnostics(context, observed, productId),
					);
		},
		async reconcile(context) {
			const observed = await findByName(context, DATABASE_COLLECTION);
			if (observed === undefined) {
				const label = `digitalocean create database ${context.name}`;
				const created = expectOk(
					await send(context, {
						method: "POST",
						path: DATABASE_COLLECTION.path,
						json: {
							name: context.name,
							engine,
							region: requiredRegion(context, productId),
							size: requiredString(
								context,
								"size",
								productId,
								"db-s-1vcpu-1gb",
							),
							num_nodes: optionalInteger(context.desired, "nodeCount") ?? 1,
							...(optionalString(context.desired, "version") !== undefined
								? { version: optionalString(context.desired, "version") }
								: undefined),
							...(optionalString(context.desired, "privateNetworkUuid") !==
							undefined
								? {
										private_network_uuid: optionalString(
											context.desired,
											"privateNetworkUuid",
										),
									}
								: undefined),
							...(optionalInteger(context.desired, "storageMib") !== undefined
								? {
										storage_size_mib: optionalInteger(
											context.desired,
											"storageMib",
										),
									}
								: undefined),
						},
					}),
					label,
				);
				const database = nestedRecord(created, DATABASE_COLLECTION.itemKey);
				return outcome(
					"create",
					identityOf(database, label),
					databaseOutputs(database),
					databaseDiagnostics(context, database, productId),
				);
			}
			const id = identityOf(
				observed,
				`digitalocean read database ${context.name}`,
			);
			const wantedSize = optionalString(context.desired, "size");
			const wantedNodes = optionalInteger(context.desired, "nodeCount");
			const currentSize = optionalString(observed, "size");
			const currentNodes = optionalInteger(observed, "num_nodes");
			const sizeDrift = wantedSize !== undefined && wantedSize !== currentSize;
			const nodeDrift =
				wantedNodes !== undefined && wantedNodes !== currentNodes;
			if (!sizeDrift && !nodeDrift) {
				return outcome(
					settledAction(context),
					id,
					databaseOutputs(observed),
					databaseDiagnostics(context, observed, productId),
				);
			}
			const label = `digitalocean resize database ${context.name}`;
			expectOk(
				await send(context, {
					method: "PUT",
					path: `${DATABASE_COLLECTION.path}/${encodeURIComponent(id)}/resize`,
					json: {
						size: wantedSize ?? currentSize,
						num_nodes: wantedNodes ?? currentNodes ?? 1,
					},
				}),
				label,
			);
			// The resize endpoint answers 202 with no body, so the outputs come
			// from a fresh read rather than from the record we sent — a resolver
			// that echoed the request would report a size the cluster does not
			// have yet.
			const refreshed =
				(await findByName(context, DATABASE_COLLECTION)) ?? observed;
			return outcome("update", id, databaseOutputs(refreshed), [
				...databaseDiagnostics(context, refreshed, productId),
				"resize accepted; DigitalOcean applies it asynchronously and this resolver does not poll, so the new size is requested, not confirmed",
			]);
		},
		async remove(context) {
			const observed = await findByName(context, DATABASE_COLLECTION);
			if (observed === undefined) return;
			const label = `digitalocean delete database ${context.name}`;
			const id = identityOf(observed, label);
			const response = await send(context, {
				method: "DELETE",
				path: `${DATABASE_COLLECTION.path}/${encodeURIComponent(id)}`,
			});
			if (isNotFound(response)) return;
			expectOk(response, label);
		},
	};
}

// ---------------------------------------------------------------------------
// Droplets — /v2/droplets
// ---------------------------------------------------------------------------

const DROPLET_COLLECTION: Collection = Object.freeze({
	path: "/v2/droplets",
	listKey: "droplets",
	itemKey: "droplet",
	nameOf: (record: JsonObject) => optionalString(record, "name"),
});

function dropletOutputs(record: JsonObject) {
	const networks = nestedRecord(record, "networks");
	const v4 = Array.isArray(networks.v4) ? networks.v4 : [];
	const publicAddress = v4
		.filter(isJsonObject)
		.find((entry) => optionalString(entry, "type") === "public");
	const privateAddress = v4
		.filter(isJsonObject)
		.find((entry) => optionalString(entry, "type") === "private");
	const region = nestedRecord(record, "region");
	return {
		...observedTagMarkers(record),
		ready: optionalString(record, "status") === "active",
		operationConfirmed: optionalString(record, "status") === "active",
		...(optionalString(record, "name") !== undefined
			? { name: optionalString(record, "name") }
			: undefined),
		...(optionalString(record, "status") !== undefined
			? { status: optionalString(record, "status") }
			: undefined),
		...(optionalString(record, "size_slug") !== undefined
			? { size: optionalString(record, "size_slug") }
			: undefined),
		...(optionalString(region, "slug") !== undefined
			? { region: optionalString(region, "slug") }
			: undefined),
		...(publicAddress !== undefined &&
		optionalString(publicAddress, "ip_address") !== undefined
			? { publicIpv4: optionalString(publicAddress, "ip_address") }
			: undefined),
		...(privateAddress !== undefined &&
		optionalString(privateAddress, "ip_address") !== undefined
			? { privateIpv4: optionalString(privateAddress, "ip_address") }
			: undefined),
	};
}

function dropletDiagnostics(
	context: DigitalOceanResolverContext,
	record: JsonObject,
): readonly string[] {
	const diagnostics: string[] = [];
	const status = optionalString(record, "status");
	if (status !== undefined && status !== "active") {
		diagnostics.push(
			`droplet is ${status}, not active: DigitalOcean provisions asynchronously and this resolver does not poll, so the create is accepted, not confirmed`,
		);
	}
	const wantedRegion = optionalString(context.desired, "region");
	const actualRegion = optionalString(nestedRecord(record, "region"), "slug");
	if (
		wantedRegion !== undefined &&
		actualRegion !== undefined &&
		wantedRegion !== actualRegion
	) {
		diagnostics.push(
			`droplet is in ${actualRegion} but the request asks for ${wantedRegion}; a droplet cannot be moved between regions and this resolver never replaces one, so the drift is reported for a human`,
		);
	}
	const wantedSize = optionalString(context.desired, "size");
	const actualSize = optionalString(record, "size_slug");
	if (
		wantedSize !== undefined &&
		actualSize !== undefined &&
		wantedSize !== actualSize
	) {
		diagnostics.push(
			`droplet is size ${actualSize} but the request asks for ${wantedSize}; resizing a droplet requires a power-off, which this resolver will not do to a running machine on its own — action left for a human`,
		);
	}
	return diagnostics;
}

const DROPLET_SPEC: Omit<DigitalOceanResolverSpec, "productId"> = {
	async read(context) {
		const observed = await findByName(context, DROPLET_COLLECTION);
		return observed === undefined
			? undefined
			: outcome(
					settledAction(context),
					identityOf(observed, `digitalocean read droplet ${context.name}`),
					dropletOutputs(observed),
					dropletDiagnostics(context, observed),
				);
	},
	async reconcile(context) {
		const observed = await findByName(context, DROPLET_COLLECTION);
		if (observed !== undefined) {
			// Every mutable difference on a Droplet (size, image) needs a
			// power-off or a rebuild, so there is no in-place update path here.
			// Reporting the drift is the honest outcome; "converging" it would
			// mean taking a running machine down without being asked.
			return outcome(
				settledAction(context),
				identityOf(observed, `digitalocean read droplet ${context.name}`),
				dropletOutputs(observed),
				dropletDiagnostics(context, observed),
			);
		}
		const productId = DIGITALOCEAN_DROPLET_PRODUCT_ID;
		const label = `digitalocean create droplet ${context.name}`;
		const created = expectOk(
			await send(context, {
				method: "POST",
				path: DROPLET_COLLECTION.path,
				json: {
					name: context.name,
					region: requiredRegion(context, productId),
					size: requiredString(context, "size", productId, "s-1vcpu-1gb"),
					image: requiredString(
						context,
						"image",
						productId,
						"ubuntu-24-04-x64",
					),
					tags: markerTags(context),
					...(optionalString(context.desired, "userData") !== undefined
						? { user_data: optionalString(context.desired, "userData") }
						: undefined),
					...(optionalBoolean(context.desired, "backups") !== undefined
						? { backups: optionalBoolean(context.desired, "backups") }
						: undefined),
					...(optionalBoolean(context.desired, "monitoring") !== undefined
						? { monitoring: optionalBoolean(context.desired, "monitoring") }
						: undefined),
					...(optionalBoolean(context.desired, "ipv6") !== undefined
						? { ipv6: optionalBoolean(context.desired, "ipv6") }
						: undefined),
					...(optionalString(context.desired, "vpcUuid") !== undefined
						? { vpc_uuid: optionalString(context.desired, "vpcUuid") }
						: undefined),
				},
			}),
			label,
		);
		const record = nestedRecord(created, DROPLET_COLLECTION.itemKey);
		return outcome(
			"create",
			identityOf(record, label),
			dropletOutputs(record),
			dropletDiagnostics(context, record),
		);
	},
	async remove(context) {
		const observed = await findByName(context, DROPLET_COLLECTION);
		if (observed === undefined) return;
		const label = `digitalocean delete droplet ${context.name}`;
		const id = identityOf(observed, label);
		const response = await send(context, {
			method: "DELETE",
			path: `${DROPLET_COLLECTION.path}/${encodeURIComponent(id)}`,
		});
		if (isNotFound(response)) return;
		expectOk(response, label);
	},
};

// ---------------------------------------------------------------------------
// Load balancers — /v2/load_balancers
// ---------------------------------------------------------------------------

const LOAD_BALANCER_COLLECTION: Collection = Object.freeze({
	path: "/v2/load_balancers",
	listKey: "load_balancers",
	itemKey: "load_balancer",
	nameOf: (record: JsonObject) => optionalString(record, "name"),
});

/**
 * The default forwarding rule. A load balancer with no rule forwards nothing,
 * and DigitalOcean rejects the create — so an unstated rule set becomes plain
 * HTTP 80→80, which is stated here rather than left as a surprise inside the
 * request body.
 */
const DEFAULT_FORWARDING_RULES = Object.freeze([
	Object.freeze({
		entry_protocol: "http",
		entry_port: 80,
		target_protocol: "http",
		target_port: 80,
	}),
]);

function loadBalancerOutputs(record: JsonObject) {
	const region = nestedRecord(record, "region");
	return {
		ready:
			optionalString(record, "status") === "active" &&
			optionalString(record, "ip") !== undefined,
		...(optionalString(record, "name") !== undefined
			? { name: optionalString(record, "name") }
			: undefined),
		...(optionalString(record, "ip") !== undefined
			? { ip: optionalString(record, "ip") }
			: undefined),
		...(optionalString(record, "status") !== undefined
			? { status: optionalString(record, "status") }
			: undefined),
		...(optionalString(record, "algorithm") !== undefined
			? { algorithm: optionalString(record, "algorithm") }
			: undefined),
		...(optionalString(region, "slug") !== undefined
			? { region: optionalString(region, "slug") }
			: undefined),
	};
}

function loadBalancerDiagnostics(record: JsonObject): readonly string[] {
	const status = optionalString(record, "status");
	return status !== undefined && status !== "active"
		? [
				`load balancer is ${status}, not active: DigitalOcean provisions asynchronously and this resolver does not poll, so the create is accepted, not confirmed`,
			]
		: [];
}

function loadBalancerBody(context: DigitalOceanResolverContext) {
	const rules = context.desired.forwardingRules;
	return {
		name: context.name,
		region: requiredRegion(context, DIGITALOCEAN_LOAD_BALANCER_PRODUCT_ID),
		forwarding_rules: Array.isArray(rules) ? rules : DEFAULT_FORWARDING_RULES,
		...(optionalString(context.desired, "algorithm") !== undefined
			? { algorithm: optionalString(context.desired, "algorithm") }
			: undefined),
		...(optionalInteger(context.desired, "sizeUnit") !== undefined
			? { size_unit: optionalInteger(context.desired, "sizeUnit") }
			: undefined),
		...(optionalBoolean(context.desired, "redirectHttpToHttps") !== undefined
			? {
					redirect_http_to_https: optionalBoolean(
						context.desired,
						"redirectHttpToHttps",
					),
				}
			: undefined),
		...(optionalString(context.desired, "vpcUuid") !== undefined
			? { vpc_uuid: optionalString(context.desired, "vpcUuid") }
			: undefined),
	};
}

const LOAD_BALANCER_SPEC: Omit<DigitalOceanResolverSpec, "productId"> = {
	async read(context) {
		const observed = await findByName(context, LOAD_BALANCER_COLLECTION);
		return observed === undefined
			? undefined
			: outcome(
					settledAction(context),
					identityOf(
						observed,
						`digitalocean read load balancer ${context.name}`,
					),
					loadBalancerOutputs(observed),
					loadBalancerDiagnostics(observed),
				);
	},
	async reconcile(context) {
		const observed = await findByName(context, LOAD_BALANCER_COLLECTION);
		if (observed === undefined) {
			const label = `digitalocean create load balancer ${context.name}`;
			const created = expectOk(
				await send(context, {
					method: "POST",
					path: LOAD_BALANCER_COLLECTION.path,
					json: loadBalancerBody(context),
				}),
				label,
			);
			const record = nestedRecord(created, LOAD_BALANCER_COLLECTION.itemKey);
			return outcome(
				"create",
				identityOf(record, label),
				loadBalancerOutputs(record),
				loadBalancerDiagnostics(record),
			);
		}
		const id = identityOf(
			observed,
			`digitalocean read load balancer ${context.name}`,
		);
		const wantedAlgorithm = optionalString(context.desired, "algorithm");
		const wantedRedirect = optionalBoolean(
			context.desired,
			"redirectHttpToHttps",
		);
		const algorithmDrift =
			wantedAlgorithm !== undefined &&
			wantedAlgorithm !== optionalString(observed, "algorithm");
		const redirectDrift =
			wantedRedirect !== undefined &&
			wantedRedirect !== optionalBoolean(observed, "redirect_http_to_https");
		if (!algorithmDrift && !redirectDrift) {
			return outcome(
				settledAction(context),
				id,
				loadBalancerOutputs(observed),
				loadBalancerDiagnostics(observed),
			);
		}
		// DigitalOcean's load-balancer PUT is a full replace, not a patch: a
		// partial body silently clears the fields it omits. The body is
		// therefore rebuilt from `desired` in full rather than from the delta.
		const label = `digitalocean update load balancer ${context.name}`;
		const updated = expectOk(
			await send(context, {
				method: "PUT",
				path: `${LOAD_BALANCER_COLLECTION.path}/${encodeURIComponent(id)}`,
				json: loadBalancerBody(context),
			}),
			label,
		);
		const record = nestedRecord(updated, LOAD_BALANCER_COLLECTION.itemKey);
		return outcome(
			"update",
			id,
			loadBalancerOutputs(record),
			loadBalancerDiagnostics(record),
		);
	},
	async remove(context) {
		const observed = await findByName(context, LOAD_BALANCER_COLLECTION);
		if (observed === undefined) return;
		const label = `digitalocean delete load balancer ${context.name}`;
		const id = identityOf(observed, label);
		const response = await send(context, {
			method: "DELETE",
			path: `${LOAD_BALANCER_COLLECTION.path}/${encodeURIComponent(id)}`,
		});
		if (isNotFound(response)) return;
		expectOk(response, label);
	},
};

// ---------------------------------------------------------------------------
// App Platform — /v2/apps
// ---------------------------------------------------------------------------

const APP_COLLECTION: Collection = Object.freeze({
	path: "/v2/apps",
	listKey: "apps",
	itemKey: "app",
	// An app's name lives inside its spec, not at the record root.
	nameOf: (record: JsonObject) =>
		optionalString(nestedRecord(record, "spec"), "name"),
});

function appOutputs(record: JsonObject) {
	const spec = nestedRecord(record, "spec");
	const liveUrl = optionalString(record, "live_url");
	const ingress = optionalString(record, "default_ingress");
	const phase = optionalString(
		nestedRecord(record, "active_deployment"),
		"phase",
	);
	return {
		...observedEnvMarkers(
			nestedRecord(nestedRecord(record, "active_deployment"), "spec"),
		),
		ready:
			phase === "ACTIVE" &&
			liveUrl !== undefined &&
			(record.in_progress_deployment === undefined ||
				record.in_progress_deployment === null),
		...(optionalString(spec, "name") !== undefined
			? { name: optionalString(spec, "name") }
			: undefined),
		...(optionalString(spec, "region") !== undefined
			? { region: optionalString(spec, "region") }
			: undefined),
		...(liveUrl !== undefined ? { url: liveUrl } : undefined),
		...(ingress !== undefined ? { defaultIngress: ingress } : undefined),
		...(phase !== undefined ? { phase } : undefined),
	};
}

function appDiagnostics(record: JsonObject): readonly string[] {
	const diagnostics: string[] = [];
	if (optionalString(record, "live_url") === undefined) {
		diagnostics.push(
			"the app has no live_url yet: App Platform builds and deploys asynchronously and this resolver does not poll, so the create is accepted, not confirmed",
		);
	}
	const phase = optionalString(
		nestedRecord(record, "active_deployment"),
		"phase",
	);
	if (phase !== undefined && phase !== "ACTIVE") {
		diagnostics.push(
			`the active deployment is in phase ${phase}, not ACTIVE; the app spec was accepted but the rollout it triggered has not finished`,
		);
	}
	return diagnostics;
}

/**
 * The app spec the caller authored, with the name forced to the resolver's
 * deterministic name.
 *
 * `desired.spec` is passed through rather than assembled field by field: an App
 * Platform spec carries services, static sites, workers, jobs, databases,
 * domains, ingress rules and env var *references*, and a resolver that rebuilt
 * a subset of that would silently drop everything it did not know about on the
 * next reconcile. The one field this resolver owns is `name`, because the name
 * is what makes the lookup convergent.
 */
function appSpec(context: DigitalOceanResolverContext, productId: string) {
	const spec = context.desired.spec;
	if (!isJsonObject(spec)) {
		throw new ResolverError(
			"RESOLVER_PRODUCT_UNSUPPORTED",
			`${productId}: the request carries no desired.spec. An App Platform app is defined by its spec (services, static sites, env var references, ingress); this resolver forwards the spec you authored and owns only its name, because inventing a spec would deploy something nobody wrote`,
		);
	}
	const envs = markerEnvs(context, spec.envs);
	return envs.length === 0
		? { ...spec, name: context.name }
		: { ...spec, name: context.name, envs };
}

function appSpecEqual(left: JsonObject, right: JsonObject): boolean {
	return stableJson(left) === stableJson(right);
}

/** Key-sorted JSON, so a spec compare does not depend on key order. */
function stableJson(value: JsonValue | undefined): string {
	if (value === undefined) return "null";
	if (Array.isArray(value)) {
		return `[${value.map((item) => stableJson(item)).join(",")}]`;
	}
	if (isJsonObject(value)) {
		return `{${Object.keys(value)
			.sort(compareStrings)
			.map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
			.join(",")}}`;
	}
	return JSON.stringify(value) ?? "null";
}

function appPlatformSpec(
	productId: string,
): Omit<DigitalOceanResolverSpec, "productId"> {
	return {
		async read(context) {
			const observed = await findByName(context, APP_COLLECTION);
			return observed === undefined
				? undefined
				: outcome(
						settledAction(context),
						identityOf(observed, `digitalocean read app ${context.name}`),
						appOutputs(observed),
						appDiagnostics(observed),
					);
		},
		async reconcile(context) {
			const spec = appSpec(context, productId);
			const observed = await findByName(context, APP_COLLECTION);
			if (observed === undefined) {
				const label = `digitalocean create app ${context.name}`;
				const created = expectOk(
					await send(context, {
						method: "POST",
						path: APP_COLLECTION.path,
						json: { spec },
					}),
					label,
				);
				const record = nestedRecord(created, APP_COLLECTION.itemKey);
				return outcome(
					"create",
					identityOf(record, label),
					appOutputs(record),
					appDiagnostics(record),
				);
			}
			const id = identityOf(observed, `digitalocean read app ${context.name}`);
			if (appSpecEqual(spec, nestedRecord(observed, "spec"))) {
				return outcome(
					settledAction(context),
					id,
					appOutputs(observed),
					appDiagnostics(observed),
				);
			}
			const label = `digitalocean update app ${context.name}`;
			const updated = expectOk(
				await send(context, {
					method: "PUT",
					path: `${APP_COLLECTION.path}/${encodeURIComponent(id)}`,
					json: { spec },
				}),
				label,
			);
			const record = nestedRecord(updated, APP_COLLECTION.itemKey);
			return outcome("update", id, appOutputs(record), [
				...appDiagnostics(record),
				"the updated spec triggers a new App Platform deployment; this resolver does not poll it, so the rollout is requested, not confirmed",
			]);
		},
		async remove(context) {
			const observed = await findByName(context, APP_COLLECTION);
			if (observed === undefined) return;
			const label = `digitalocean delete app ${context.name}`;
			const id = identityOf(observed, label);
			const response = await send(context, {
				method: "DELETE",
				path: `${APP_COLLECTION.path}/${encodeURIComponent(id)}`,
			});
			if (isNotFound(response)) return;
			expectOk(response, label);
		},
	};
}

// ---------------------------------------------------------------------------
// Functions — an OpenWhisk action inside a namespace, on the namespace's host
// ---------------------------------------------------------------------------

/**
 * DigitalOcean Functions has two layers, and only the outer one is on the v2
 * control plane.
 *
 * `/v2/functions/namespaces` manages *namespaces*, and a namespace record
 * carries an `api_host` plus a `key`. That host serves an OpenWhisk-compatible
 * API where an individual function is an addressable resource:
 *
 *   GET    /api/v1/namespaces/{namespace}/actions/{name}?code=true
 *   PUT    /api/v1/namespaces/{namespace}/actions/{name}?overwrite=true
 *   DELETE /api/v1/namespaces/{namespace}/actions/{name}
 *
 * An earlier revision of this package concluded there was no convergent create
 * here, on the grounds that deploying a function is a non-deterministic source
 * upload. That describes `doctl serverless deploy`, which builds an archive
 * from a source tree — a build step in the CLI, not the API. The API takes an
 * action body, and `PUT ?overwrite=true` is create-or-replace: idempotent by
 * construction, which is the only property `reconcile` has to have. The wrong
 * layer was inspected, and the conclusion did not survive looking at the right
 * one.
 *
 * This resolver deploys an action that is *already built*. Producing the code
 * or the archive is a build concern and stays outside: `desired.action.exec`
 * carries what the provider stores, the same way the App Platform resolvers
 * forward a spec rather than assembling one.
 */
interface FunctionsNamespace {
	readonly apiHost: string;
	/** The `fn-…` namespace string the action paths are scoped to. */
	readonly namespace: string;
	/** `uuid:key`, for OpenWhisk's HTTP Basic. Material — never published. */
	readonly basic: string;
}

/** The namespace this function lives in. Required: it is not derivable. */
function namespaceIdOf(context: DigitalOceanResolverContext): string {
	const namespaceId = optionalString(context.desired, "namespaceId");
	if (namespaceId === undefined) {
		throw new ResolverError(
			"RESOLVER_PRODUCT_UNSUPPORTED",
			`${DIGITALOCEAN_FUNCTIONS_PRODUCT_ID}: the request names no namespaceId — set desired.namespaceId to the Functions namespace UUID this function belongs to (GET /v2/functions/namespaces lists them). A namespace is a billed, region-pinned container and this resolver will neither create one nor pick one, because picking would place the workload in a region nobody asked for`,
			DIGITALOCEAN_FUNCTIONS_PRODUCT_ID,
		);
	}
	return namespaceId;
}

/**
 * Read the namespace from the *control plane* to learn where its functions
 * live and how to authenticate to them.
 *
 * The host comes from DigitalOcean rather than from `desired` deliberately: a
 * host in a property bag is a host an author could point anywhere, and the
 * namespace credential would go with it. `functionsUrl` still refuses anything
 * not shaped like a Functions host, so a compromised or surprising control-plane
 * answer is refused rather than dialled.
 */
async function functionsNamespace(
	context: DigitalOceanResolverContext,
): Promise<FunctionsNamespace> {
	const namespaceId = namespaceIdOf(context);
	const label = `digitalocean read functions namespace ${namespaceId}`;
	const response = await send(context, {
		method: "GET",
		path: `/v2/functions/namespaces/${encodeURIComponent(namespaceId)}`,
	});
	if (isNotFound(response)) {
		throw new ResolverError(
			"RESOLVER_PRODUCT_UNSUPPORTED",
			`${DIGITALOCEAN_FUNCTIONS_PRODUCT_ID}: no Functions namespace ${JSON.stringify(namespaceId)} exists. Create the namespace deliberately — it is billed and region-pinned — and reconcile this function afterwards`,
			DIGITALOCEAN_FUNCTIONS_PRODUCT_ID,
		);
	}
	const record = nestedRecord(expectOk(response, label), "namespace");
	const apiHost = optionalString(record, "api_host");
	const namespace = optionalString(record, "namespace");
	const uuid = optionalString(record, "uuid");
	const key = optionalString(record, "key");
	if (
		apiHost === undefined ||
		namespace === undefined ||
		uuid === undefined ||
		key === undefined
	) {
		throw new ResolverError(
			"RESOLVER_OUTPUT_UNPARSEABLE",
			// Deliberately does not echo the record: it carries the key.
			`${label}: the namespace record is missing one of api_host, namespace, uuid or key, so this resolver cannot address or authenticate to the namespace's function API`,
			DIGITALOCEAN_FUNCTIONS_PRODUCT_ID,
		);
	}
	return { apiHost, namespace, basic: `${uuid}:${key}` };
}

/**
 * Send one call to a namespace's function API.
 *
 * A separate send path from the control plane's, for the same reason Spaces has
 * one: a different origin and a different credential. The personal access token
 * never reaches `doserverless.co`, and the namespace key never reaches
 * `api.digitalocean.com`.
 */
async function sendFunctions(
	context: DigitalOceanResolverContext,
	ns: FunctionsNamespace,
	call: {
		readonly method: TransportMethod;
		readonly path: string;
		readonly json?: unknown;
	},
): Promise<TransportResponse> {
	const body = call.json === undefined ? undefined : JSON.stringify(call.json);
	const guarded = guardedFunctionsTransport(context.transport, ns.apiHost);
	return guarded({
		method: call.method,
		url: functionsUrl(ns.apiHost, call.path),
		headers: {
			accept: "application/json",
			// OpenWhisk authenticates with HTTP Basic over uuid:key.
			authorization: `Basic ${base64Utf8(ns.basic)}`,
			...(body !== undefined
				? { "content-type": "application/json" }
				: undefined),
		},
		...(body !== undefined ? { body } : undefined),
		timeoutMs: DIGITALOCEAN_MAX_TIMEOUT_MS,
		maxResponseBytes: DIGITALOCEAN_MAX_RESPONSE_BYTES,
	});
}

/**
 * Base64 of the UTF-8 bytes. `btoa` alone is latin1 and would corrupt a
 * non-ASCII credential; built on globals rather than `node:buffer` so this
 * package keeps working outside Node.
 */
function base64Utf8(value: string): string {
	const bytes = new TextEncoder().encode(value);
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary);
}

/** `/api/v1/namespaces/{ns}/actions/{name}`, every segment encoded. */
function actionPath(ns: FunctionsNamespace, name: string): string {
	return `/api/v1/namespaces/${encodeURIComponent(ns.namespace)}/actions/${name
		.split("/")
		.map((segment) => encodeURIComponent(segment))
		.join("/")}`;
}

/** The action body the caller authored, with the name forced to ours. */
function actionBody(context: DigitalOceanResolverContext): JsonObject {
	const action = context.desired.action;
	if (!isJsonObject(action)) {
		throw new ResolverError(
			"RESOLVER_PRODUCT_UNSUPPORTED",
			`${DIGITALOCEAN_FUNCTIONS_PRODUCT_ID}: the request carries no desired.action. A function is defined by its exec block (runtime kind plus code, or a base64 archive), its limits and its parameters; this resolver forwards the action you authored and owns only its name. Building the code or the archive is a build step and stays outside this resolver, the same way the App Platform resolvers forward a spec rather than assembling one`,
			DIGITALOCEAN_FUNCTIONS_PRODUCT_ID,
		);
	}
	if (!isJsonObject(action.exec)) {
		throw new ResolverError(
			"RESOLVER_PRODUCT_UNSUPPORTED",
			`${DIGITALOCEAN_FUNCTIONS_PRODUCT_ID}: desired.action carries no exec block. OpenWhisk needs at least { kind, code } — for example { kind: "nodejs:default", code: "…" } — and a function deployed without one would be accepted and fail at invoke time instead`,
			DIGITALOCEAN_FUNCTIONS_PRODUCT_ID,
		);
	}
	return { ...action, name: context.name };
}

/**
 * The parts of an action this resolver authored, for the drift compare.
 *
 * OpenWhisk answers with fields it owns — `version`, `publish`, `updated`, and
 * platform annotations such as `exec` provenance — so comparing whole records
 * would report drift on every read and re-PUT forever. Comparing only what was
 * sent is what makes the second reconcile a no-op.
 */
function authoredAction(action: JsonObject): JsonObject {
	const exec = isJsonObject(action.exec) ? action.exec : {};
	return {
		exec: {
			kind: exec.kind ?? null,
			code: exec.code ?? null,
			binary: exec.binary ?? null,
			main: exec.main ?? null,
			image: exec.image ?? null,
		},
		limits: isJsonObject(action.limits) ? action.limits : {},
		parameters: Array.isArray(action.parameters) ? action.parameters : [],
		annotations: Array.isArray(action.annotations) ? action.annotations : [],
	};
}

/**
 * Annotations the platform adds on its own. They are not drift, and treating
 * them as drift would mean a re-PUT on every reconcile.
 */
const PLATFORM_ANNOTATION_KEYS = Object.freeze([
	"exec",
	"provide-api-key",
	"binary",
]);

function withoutPlatformAnnotations(action: JsonObject): JsonObject {
	const raw = action.annotations;
	const annotations = Array.isArray(raw)
		? raw.filter(
				(item) =>
					!isJsonObject(item) ||
					!PLATFORM_ANNOTATION_KEYS.includes(optionalString(item, "key") ?? ""),
			)
		: [];
	return { ...action, annotations };
}

function functionOutputs(
	context: DigitalOceanResolverContext,
	ns: FunctionsNamespace,
	observed: JsonObject,
) {
	const exec = isJsonObject(observed.exec) ? observed.exec : undefined;
	const web = (
		Array.isArray(observed.annotations) ? observed.annotations : []
	).some(
		(item) =>
			isJsonObject(item) &&
			optionalString(item, "key") === "web-export" &&
			item.value === true,
	);
	return {
		ready:
			exec !== undefined &&
			optionalString(exec, "kind") !== undefined &&
			optionalString(observed, "version") !== undefined,
		functionName: context.name,
		namespace: ns.namespace,
		// The host, not the key. `basic` never leaves this module.
		apiHost: ns.apiHost,
		...(exec !== undefined && isJsonString(exec.kind)
			? { runtime: exec.kind }
			: undefined),
		...(isJsonString(observed.version)
			? { version: observed.version }
			: undefined),
		...(web
			? {
					url: `https://${ns.apiHost.replace(/^https:\/\//u, "")}/api/v1/web/${ns.namespace}/default/${context.name}`,
				}
			: undefined),
	};
}

const FUNCTIONS_SPEC: Omit<DigitalOceanResolverSpec, "productId"> = {
	async read(context) {
		const ns = await functionsNamespace(context);
		const response = await sendFunctions(context, ns, {
			method: "GET",
			path: `${actionPath(ns, context.name)}?code=true`,
		});
		if (isNotFound(response)) return undefined;
		const observed = expectOk(
			response,
			`digitalocean read function ${context.name}`,
		);
		return outcome(
			settledAction(context),
			`${ns.namespace}/${context.name}`,
			functionOutputs(context, ns, observed),
			[],
		);
	},
	async reconcile(context) {
		const ns = await functionsNamespace(context);
		const wanted = actionBody(context);
		const existing = await sendFunctions(context, ns, {
			method: "GET",
			path: `${actionPath(ns, context.name)}?code=true`,
		});
		const observed = isNotFound(existing)
			? undefined
			: expectOk(existing, `digitalocean read function ${context.name}`);
		if (
			observed !== undefined &&
			stableJson(withoutPlatformAnnotations(authoredAction(observed))) ===
				stableJson(withoutPlatformAnnotations(authoredAction(wanted)))
		) {
			return outcome(
				settledAction(context),
				`${ns.namespace}/${context.name}`,
				functionOutputs(context, ns, observed),
				[],
			);
		}
		// `overwrite=true` makes this create-or-replace, which is what lets the
		// same request run twice and leave one function behind.
		const label = `digitalocean put function ${context.name}`;
		const written = expectOk(
			await sendFunctions(context, ns, {
				method: "PUT",
				path: `${actionPath(ns, context.name)}?overwrite=true`,
				json: wanted,
			}),
			label,
		);
		return outcome(
			observed === undefined ? "create" : "update",
			`${ns.namespace}/${context.name}`,
			functionOutputs(context, ns, written),
			[
				"the action was accepted by the namespace; OpenWhisk warms a container on first invoke, so the function exists but has not been proven to run",
				"the code or archive in desired.action.exec is deployed as authored: building it from a source tree is a build step this resolver does not perform, which is what keeps the same request producing the same function twice",
			],
		);
	},
	async remove(context) {
		const ns = await functionsNamespace(context);
		const response = await sendFunctions(context, ns, {
			method: "DELETE",
			path: actionPath(ns, context.name),
		});
		if (isNotFound(response)) return;
		expectOk(response, `digitalocean delete function ${context.name}`);
	},
};

// ---------------------------------------------------------------------------
// App Platform components — read-modify-write on the app that owns them
// ---------------------------------------------------------------------------

/**
 * A worker and a job are components *inside* an app spec, not standalone
 * resources with their own ids.
 *
 * That is a fact about the API, and the wrong conclusion to draw from it is
 * that they cannot converge. `PUT /v2/apps/{id}` replaces the whole spec, so a
 * component converges by read-modify-write: read the app, replace the one
 * component this request owns, put the spec back. That is idempotent — the
 * second run finds the component already equal and writes nothing — which is
 * the only property `reconcile` actually has to have.
 *
 * Two rules keep it from being dangerous:
 *
 *   - **It never creates the app.** An app is `digitalocean.app-platform-*`'s
 *     own resource with its own resolver; a component resolver that created one
 *     would race it. A missing app is refused with the name of the resolver
 *     that should have made it.
 *   - **It only ever touches its own component.** Every other key of the spec —
 *     other services, databases, domains, ingress rules — is carried through
 *     from what was read, so a component resolver cannot drop somebody else's
 *     work as a side effect of running.
 *
 * The remaining hazard is honest and documented: two component resolvers
 * writing to one app in the same instant would have one overwrite the other's
 * read. It is the same read-modify-write race any shared-parent resource has,
 * and the diagnostic says so rather than pretending otherwise.
 */
type AppComponentKind = "workers" | "jobs";

/** The app this component belongs to. Required: it is not derivable. */
function ownerAppName(
	context: DigitalOceanResolverContext,
	productId: string,
): string {
	const appName = optionalString(context.desired, "appName");
	if (appName === undefined) {
		throw new ResolverError(
			"RESOLVER_PRODUCT_UNSUPPORTED",
			`${productId}: the request names no appName — set desired.appName to the App Platform app this component belongs to. A component lives inside one app's spec and the app is not derivable from the component's name, so it is required rather than guessed; guessing would put the workload in somebody else's app`,
			productId,
		);
	}
	return appName;
}

/** The component body the caller authored, with its name forced to ours. */
function componentSpec(
	context: DigitalOceanResolverContext,
	productId: string,
) {
	const component = context.desired.component;
	if (!isJsonObject(component)) {
		throw new ResolverError(
			"RESOLVER_PRODUCT_UNSUPPORTED",
			`${productId}: the request carries no desired.component. A worker or job component is defined by its image or source, run command, instance size and count; this resolver forwards the component you authored and owns only its name, because inventing one would deploy something nobody wrote`,
			productId,
		);
	}
	return { ...component, name: context.name };
}

/** Find the app by an explicit name rather than by the request's own name. */
async function findAppNamed(
	context: DigitalOceanResolverContext,
	appName: string,
): Promise<JsonObject | undefined> {
	let physicalId = context.knownPhysicalId;
	if (physicalId !== undefined) {
		const kind =
			context.request.ref.productId === DIGITALOCEAN_APP_WORKER_PRODUCT_ID
				? "workers"
				: "jobs";
		const suffix = `/${kind}/${context.name}`;
		if (!physicalId.endsWith(suffix))
			throw new ResolverError(
				"RESOLVER_PRODUCT_UNSUPPORTED",
				"the pinned physical component identity differs from its requested app component",
			);
		physicalId = physicalId.slice(0, -suffix.length);
		if (!physicalId)
			throw new ResolverError(
				"RESOLVER_PRODUCT_UNSUPPORTED",
				"the pinned component has no physical app identity",
			);
	}
	return findByName(
		{ ...context, name: appName, knownPhysicalId: physicalId },
		APP_COLLECTION,
	);
}

function componentsOf(
	spec: JsonObject,
	kind: AppComponentKind,
): readonly JsonObject[] {
	const list = spec[kind];
	return Array.isArray(list) ? list.filter(isJsonObject) : [];
}

function componentOutputs(
	context: DigitalOceanResolverContext,
	kind: AppComponentKind,
	app: JsonObject,
	component: JsonObject,
) {
	const appId = optionalString(app, "id");
	const instanceSize = optionalString(component, "instance_size_slug");
	const instanceCount = optionalInteger(component, "instance_count");
	return {
		ready: appOutputs(app).ready,
		componentName: context.name,
		componentKind: kind === "workers" ? "worker" : "job",
		appName: optionalString(nestedRecord(app, "spec"), "name") ?? "",
		...(appId === undefined ? undefined : { appId }),
		...(instanceSize === undefined ? undefined : { instanceSize }),
		...(instanceCount === undefined ? undefined : { instanceCount }),
		...(kind === "jobs"
			? { runsOn: optionalString(component, "kind") ?? "UNSPECIFIED" }
			: undefined),
	};
}

/**
 * Put the app spec back with one component replaced, added, or dropped.
 *
 * Everything except the one component is carried through from what was read.
 */
function specWithComponent(
	app: JsonObject,
	kind: AppComponentKind,
	name: string,
	replacement: JsonObject | undefined,
) {
	const spec = nestedRecord(app, "spec");
	const others = componentsOf(spec, kind).filter(
		(item) => optionalString(item, "name") !== name,
	);
	const next =
		replacement === undefined
			? others
			: [...others, replacement].sort((left, right) =>
					compareStrings(
						optionalString(left, "name") ?? "",
						optionalString(right, "name") ?? "",
					),
				);
	return {
		...spec,
		...(next.length > 0 ? { [kind]: next } : undefined),
		...(next.length === 0 && kind in spec ? { [kind]: [] } : undefined),
	};
}

const COMPONENT_RACE_DIAGNOSTIC =
	"a component converges by read-modify-write on the whole app spec; two component resolvers writing to one app at the same instant would have one overwrite the other's read, so reconcile one app's components in sequence rather than concurrently";

function appComponentSpec(
	kind: AppComponentKind,
	productId: string,
): Omit<DigitalOceanResolverSpec, "productId"> {
	const noun = kind === "workers" ? "worker" : "job";

	function physicalId(
		app: JsonObject,
		context: DigitalOceanResolverContext,
	): string {
		const appId = identityOf(app, `digitalocean read app for ${context.name}`);
		return `${appId}/${kind}/${context.name}`;
	}

	function findComponent(
		app: JsonObject,
		name: string,
	): JsonObject | undefined {
		return componentsOf(nestedRecord(app, "spec"), kind).find(
			(item) => optionalString(item, "name") === name,
		);
	}

	async function putSpec(
		context: DigitalOceanResolverContext,
		app: JsonObject,
		spec: JsonObject,
		label: string,
	): Promise<JsonObject> {
		const appId = identityOf(app, label);
		const updated = expectOk(
			await send(context, {
				method: "PUT",
				path: `${APP_COLLECTION.path}/${encodeURIComponent(appId)}`,
				json: { spec },
			}),
			label,
		);
		return nestedRecord(updated, APP_COLLECTION.itemKey);
	}

	return {
		async read(context) {
			const app = await findAppNamed(context, ownerAppName(context, productId));
			if (app === undefined) return undefined;
			const component = findComponent(app, context.name);
			return component === undefined
				? undefined
				: outcome(
						settledAction(context),
						physicalId(app, context),
						componentOutputs(context, kind, app, component),
						[],
					);
		},
		async reconcile(context) {
			const appName = ownerAppName(context, productId);
			const wanted = componentSpec(context, productId);
			const app = await findAppNamed(context, appName);
			if (app === undefined) {
				throw new ResolverError(
					"RESOLVER_PRODUCT_UNSUPPORTED",
					`${productId}: no App Platform app named ${JSON.stringify(appName)} exists. A ${noun} is a component inside an app's spec, so the app has to exist first — reconcile a ${DIGITALOCEAN_APP_SERVICE_PRODUCT_ID} (or ${DIGITALOCEAN_APP_STATIC_SITE_PRODUCT_ID}) binding for it before this one. This resolver will not create the app itself, because that would race the resolver that owns it`,
					productId,
				);
			}
			const observed = findComponent(app, context.name);
			if (observed !== undefined && appSpecEqual(observed, wanted)) {
				return outcome(
					settledAction(context),
					physicalId(app, context),
					componentOutputs(context, kind, app, observed),
					[],
				);
			}
			const label =
				observed === undefined
					? `digitalocean add ${noun} ${context.name} to app ${appName}`
					: `digitalocean update ${noun} ${context.name} in app ${appName}`;
			const record = await putSpec(
				context,
				app,
				specWithComponent(app, kind, context.name, wanted),
				label,
			);
			const component = findComponent(record, context.name) ?? wanted;
			return outcome(
				observed === undefined ? "create" : "update",
				physicalId(record, context),
				componentOutputs(context, kind, record, component),
				[
					...appDiagnostics(record),
					`the ${noun} was written into app ${appName}'s spec, which triggers a new App Platform deployment; this resolver does not poll it, so the rollout is requested, not confirmed`,
					COMPONENT_RACE_DIAGNOSTIC,
					...(kind === "jobs"
						? [
								"a job component runs on the schedule its kind names (PRE_DEPLOY, POST_DEPLOY, FAILED_DEPLOY); this resolver defines the job, it does not invoke it",
							]
						: []),
				],
			);
		},
		async remove(context) {
			const appName = ownerAppName(context, productId);
			const app = await findAppNamed(context, appName);
			// An app that is gone took its components with it, and an app that
			// never had this component is already in the wanted state.
			if (app === undefined) return;
			if (findComponent(app, context.name) === undefined) return;
			await putSpec(
				context,
				app,
				specWithComponent(app, kind, context.name, undefined),
				`digitalocean remove ${noun} ${context.name} from app ${appName}`,
			);
		},
	};
}

// ---------------------------------------------------------------------------
// Spaces — S3 on <region>.digitaloceanspaces.com, signed with SigV4
// ---------------------------------------------------------------------------

/**
 * Spaces is the one product here that does not speak to the v2 control plane.
 * It is an S3 surface on its own host, authenticated with its own key pair and
 * signed with SigV4 rather than carrying a bearer token — so it gets its own
 * guard policy, its own credential, and its own send path. Folding it into the
 * control-plane path would mean one bad config value could send a personal
 * access token to a Spaces origin, or a Spaces key to the API.
 *
 * Convergence is a plain read-or-create: `HEAD /{bucket}` answers 200 or 404,
 * and 404 is the only signal that a create is needed. Bucket names are global
 * per region, so a 409 on create means somebody else owns the name — reported
 * rather than adopted, because adopting a bucket you do not own is worse than
 * failing.
 */
async function sendSpaces(
	context: DigitalOceanResolverContext,
	call: {
		readonly method: TransportMethod;
		readonly path: string;
		readonly body?: string;
	},
): Promise<TransportResponse> {
	const region = requiredRegion(context, DIGITALOCEAN_SPACES_PRODUCT_ID);
	const keys = context.spacesKeys;
	if (keys === undefined) {
		throw new ResolverError(
			"RESOLVER_CREDENTIAL_MISSING",
			`${DIGITALOCEAN_SPACES_PRODUCT_ID}: no Spaces credential was resolved. Construct the resolvers with resolveSpacesCredential(ref) — Spaces uses an access key pair, not the control-plane personal access token, and this package will not send one where the other belongs`,
		);
	}
	const url = spacesUrl(region, call.path);
	const credentials: AwsCredentials = {
		accessKeyId: keys.accessKeyId,
		secretAccessKey: keys.secretAccessKey,
	};
	const signed = signAwsRequest({
		method: call.method,
		url,
		...(call.body === undefined ? undefined : { body: call.body }),
		region,
		// Spaces presents itself as S3; the signing service name is what makes
		// the signature verify on their side.
		service: "s3",
		credentials,
		now: new Date(context.nowMs()),
	});
	const guarded = guardedSpacesTransport(context.transport, region);
	return guarded({
		method: call.method,
		url,
		headers: lowerCaseHeaders(signed.headers),
		...(call.body === undefined ? undefined : { body: call.body }),
		timeoutMs: DIGITALOCEAN_MAX_TIMEOUT_MS,
		maxResponseBytes: DIGITALOCEAN_MAX_RESPONSE_BYTES,
	});
}

/**
 * Fold signed header names to lower case.
 *
 * `signAwsRequest` returns `Authorization` with its conventional casing and
 * everything else lower; HTTP header names are case-insensitive, so both reach
 * the provider identically. Folding here means every request this repo composes
 * carries one convention, which is what lets a guard, a test, or a log line
 * look for `authorization` without knowing which signer produced it.
 */
function lowerCaseHeaders(headers: Readonly<Record<string, string>>) {
	const out = {};
	for (const [name, value] of Object.entries(headers)) {
		Object.assign(out, { [name.toLowerCase()]: value });
	}
	return out;
}

/** The bucket path, path-style so one host serves every bucket in a region. */
function bucketPath(context: DigitalOceanResolverContext): string {
	return `/${encodeURIComponent(context.name)}`;
}

function spacesOutputs(context: DigitalOceanResolverContext, region: string) {
	return {
		ready: true,
		bucketName: context.name,
		region,
		endpoint: `https://${context.name}.${region}.digitaloceanspaces.com`,
		s3Endpoint: `https://${region}.digitaloceanspaces.com`,
	};
}

const SPACES_SPEC: Omit<DigitalOceanResolverSpec, "productId"> = {
	async read(context) {
		const region = requiredRegion(context, DIGITALOCEAN_SPACES_PRODUCT_ID);
		const response = await sendSpaces(context, {
			method: "HEAD",
			path: bucketPath(context),
		});
		if (response.status === 404) return undefined;
		if (response.status >= 400) {
			throw providerRejection(response, `spaces read bucket ${context.name}`);
		}
		return outcome(
			settledAction(context),
			context.name,
			spacesOutputs(context, region),
			[],
		);
	},
	async reconcile(context) {
		const region = requiredRegion(context, DIGITALOCEAN_SPACES_PRODUCT_ID);
		const head = await sendSpaces(context, {
			method: "HEAD",
			path: bucketPath(context),
		});
		if (head.status !== 404) {
			if (head.status >= 400) {
				throw providerRejection(head, `spaces read bucket ${context.name}`);
			}
			return outcome(
				settledAction(context),
				context.name,
				spacesOutputs(context, region),
				[],
			);
		}
		const label = `spaces create bucket ${context.name}`;
		const created = await sendSpaces(context, {
			method: "PUT",
			path: bucketPath(context),
		});
		if (created.status === 409) {
			throw new ResolverError(
				"RESOLVER_PROVIDER_REJECTED",
				`${label}: the bucket name is already taken. Spaces bucket names are global within a region, so this is somebody else's bucket — it is reported rather than adopted, because adopting a bucket you do not own is worse than failing`,
			);
		}
		if (created.status >= 400) throw providerRejection(created, label);
		return outcome("create", context.name, spacesOutputs(context, region), [
			"the bucket was created with Spaces' default private ACL; this resolver does not set an ACL, so a bucket meant to be public still needs one applied deliberately",
		]);
	},
	async remove(context) {
		const label = `spaces delete bucket ${context.name}`;
		const response = await sendSpaces(context, {
			method: "DELETE",
			path: bucketPath(context),
		});
		if (response.status === 404) return;
		if (response.status === 409) {
			throw new ResolverError(
				"RESOLVER_PROVIDER_REJECTED",
				`${label}: the bucket is not empty. This resolver will not enumerate and delete objects to make a delete succeed — that is unbounded data loss dressed as cleanup. Empty the bucket deliberately, then reconcile`,
			);
		}
		if (response.status >= 400) throw providerRejection(response, label);
	},
};

// ---------------------------------------------------------------------------
// Block Storage volumes — /v2/volumes
// ---------------------------------------------------------------------------

const VOLUME_COLLECTION: Collection = Object.freeze({
	path: "/v2/volumes",
	listKey: "volumes",
	itemKey: "volume",
	nameOf: (record: JsonObject) => optionalString(record, "name"),
});

function volumeOutputs(record: JsonObject) {
	const size = optionalInteger(record, "size_gigabytes");
	const region = optionalString(nestedRecord(record, "region"), "slug");
	return {
		ready: size !== undefined && size > 0 && region !== undefined,
		...(optionalString(record, "name") !== undefined
			? { name: optionalString(record, "name") }
			: undefined),
		...(size !== undefined ? { sizeGigabytes: size } : undefined),
		...(region !== undefined ? { region } : undefined),
		...(optionalString(record, "filesystem_type") !== undefined
			? { filesystemType: optionalString(record, "filesystem_type") }
			: undefined),
	};
}

const BLOCK_STORAGE_SPEC: Omit<DigitalOceanResolverSpec, "productId"> = {
	async read(context) {
		const observed = await findByName(context, VOLUME_COLLECTION);
		return observed === undefined
			? undefined
			: outcome(
					settledAction(context),
					identityOf(observed, `digitalocean read volume ${context.name}`),
					volumeOutputs(observed),
					[],
				);
	},
	async reconcile(context) {
		const productId = DIGITALOCEAN_BLOCK_STORAGE_PRODUCT_ID;
		const observed = await findByName(context, VOLUME_COLLECTION);
		if (observed === undefined) {
			const size = optionalInteger(context.desired, "sizeGigabytes");
			if (size === undefined) {
				throw new ResolverError(
					"RESOLVER_PRODUCT_UNSUPPORTED",
					`${productId}: the request names no sizeGigabytes — set desired.sizeGigabytes, for example 10. A volume billed at a size nobody asked for is a cost incident, so no size is invented here`,
				);
			}
			const label = `digitalocean create volume ${context.name}`;
			const created = expectOk(
				await send(context, {
					method: "POST",
					path: VOLUME_COLLECTION.path,
					json: {
						name: context.name,
						size_gigabytes: size,
						region: requiredRegion(context, productId),
						...(optionalString(context.desired, "filesystemType") !== undefined
							? {
									filesystem_type: optionalString(
										context.desired,
										"filesystemType",
									),
								}
							: undefined),
					},
				}),
				label,
			);
			const record = nestedRecord(created, VOLUME_COLLECTION.itemKey);
			return outcome(
				"create",
				identityOf(record, label),
				volumeOutputs(record),
				[],
			);
		}
		const id = identityOf(observed, `digitalocean read volume ${context.name}`);
		const wanted = optionalInteger(context.desired, "sizeGigabytes");
		const actual = optionalInteger(observed, "size_gigabytes");
		if (wanted === undefined || actual === undefined || wanted <= actual) {
			const diagnostics =
				wanted !== undefined && actual !== undefined && wanted < actual
					? [
							`volume is ${actual} GB but the request asks for ${wanted} GB; DigitalOcean volumes only grow, so shrinking is reported for a human rather than "fixed" by replacing the volume and destroying the data on it`,
						]
					: [];
			return outcome(
				settledAction(context),
				id,
				volumeOutputs(observed),
				diagnostics,
			);
		}
		const label = `digitalocean resize volume ${context.name}`;
		expectOk(
			await send(context, {
				method: "POST",
				path: `${VOLUME_COLLECTION.path}/${encodeURIComponent(id)}/actions`,
				json: {
					type: "resize",
					size_gigabytes: wanted,
					region: requiredRegion(context, productId),
				},
			}),
			label,
		);
		const refreshed =
			(await findByName(context, VOLUME_COLLECTION)) ?? observed;
		return outcome("update", id, volumeOutputs(refreshed), [
			"resize accepted; DigitalOcean applies it asynchronously and this resolver does not poll, and a grown volume still needs its filesystem extended inside the guest",
		]);
	},
	async remove(context) {
		const observed = await findByName(context, VOLUME_COLLECTION);
		if (observed === undefined) return;
		const label = `digitalocean delete volume ${context.name}`;
		const id = identityOf(observed, label);
		const response = await send(context, {
			method: "DELETE",
			path: `${VOLUME_COLLECTION.path}/${encodeURIComponent(id)}`,
		});
		if (isNotFound(response)) return;
		expectOk(response, label);
	},
};

// ---------------------------------------------------------------------------
// DOKS clusters — /v2/kubernetes/clusters
// ---------------------------------------------------------------------------

const CLUSTER_COLLECTION: Collection = Object.freeze({
	path: "/v2/kubernetes/clusters",
	listKey: "kubernetes_clusters",
	itemKey: "kubernetes_cluster",
	nameOf: (record: JsonObject) => optionalString(record, "name"),
});

function clusterOutputs(record: JsonObject) {
	const status = optionalString(nestedRecord(record, "status"), "state");
	return {
		ready:
			status === "running" && optionalString(record, "endpoint") !== undefined,
		...(optionalString(record, "name") !== undefined
			? { name: optionalString(record, "name") }
			: undefined),
		...(optionalString(record, "region") !== undefined
			? { region: optionalString(record, "region") }
			: undefined),
		...(optionalString(record, "version") !== undefined
			? { version: optionalString(record, "version") }
			: undefined),
		...(optionalString(record, "endpoint") !== undefined
			? { endpoint: optionalString(record, "endpoint") }
			: undefined),
		...(status !== undefined ? { status } : undefined),
	};
}

/**
 * The cluster resolver allocates the *substrate*: a cluster and its node pool.
 * It deliberately does not touch workload objects — those are
 * `@hobo/provider-kubernetes`' business, resolved against this cluster's own
 * apiserver, and the `endpoint` output is the handoff between the two.
 */
const KUBERNETES_CLUSTER_SPEC: Omit<DigitalOceanResolverSpec, "productId"> = {
	async read(context) {
		const observed = await findByName(context, CLUSTER_COLLECTION);
		return observed === undefined
			? undefined
			: outcome(
					settledAction(context),
					identityOf(observed, `digitalocean read cluster ${context.name}`),
					clusterOutputs(observed),
					clusterDiagnostics(observed),
				);
	},
	async reconcile(context) {
		const productId = DIGITALOCEAN_KUBERNETES_CLUSTER_PRODUCT_ID;
		const observed = await findByName(context, CLUSTER_COLLECTION);
		if (observed === undefined) {
			const label = `digitalocean create cluster ${context.name}`;
			const created = expectOk(
				await send(context, {
					method: "POST",
					path: CLUSTER_COLLECTION.path,
					json: {
						name: context.name,
						region: requiredRegion(context, productId),
						version: requiredString(
							context,
							"version",
							productId,
							"1.31.1-do.0",
						),
						node_pools: [
							{
								name: `${context.name}-pool`,
								size: requiredString(context, "size", productId, "s-2vcpu-4gb"),
								count: optionalInteger(context.desired, "nodeCount") ?? 1,
								...(optionalBoolean(context.desired, "autoScale") !== undefined
									? {
											auto_scale: optionalBoolean(context.desired, "autoScale"),
										}
									: undefined),
							},
						],
					},
				}),
				label,
			);
			const record = nestedRecord(created, CLUSTER_COLLECTION.itemKey);
			return outcome(
				"create",
				identityOf(record, label),
				clusterOutputs(record),
				clusterDiagnostics(record),
			);
		}
		// A cluster's region and Kubernetes version upgrade path are not things
		// to converge silently: an upgrade restarts every node. Drift is
		// reported and left for a human, as everywhere else here.
		return outcome(
			settledAction(context),
			identityOf(observed, `digitalocean read cluster ${context.name}`),
			clusterOutputs(observed),
			[
				...clusterDiagnostics(observed),
				...clusterDriftDiagnostics(context, observed),
			],
		);
	},
	async remove(context) {
		const observed = await findByName(context, CLUSTER_COLLECTION);
		if (observed === undefined) return;
		const label = `digitalocean delete cluster ${context.name}`;
		const id = identityOf(observed, label);
		const response = await send(context, {
			method: "DELETE",
			path: `${CLUSTER_COLLECTION.path}/${encodeURIComponent(id)}`,
		});
		if (isNotFound(response)) return;
		expectOk(response, label);
	},
};

function clusterDiagnostics(record: JsonObject): readonly string[] {
	const state = optionalString(nestedRecord(record, "status"), "state");
	return state !== undefined && state !== "running"
		? [
				`cluster is ${state}, not running: DigitalOcean provisions asynchronously and this resolver does not poll, so the create is accepted, not confirmed`,
			]
		: [];
}

function clusterDriftDiagnostics(
	context: DigitalOceanResolverContext,
	record: JsonObject,
): readonly string[] {
	const diagnostics: string[] = [];
	const wantedVersion = optionalString(context.desired, "version");
	const actualVersion = optionalString(record, "version");
	if (
		wantedVersion !== undefined &&
		actualVersion !== undefined &&
		wantedVersion !== actualVersion
	) {
		diagnostics.push(
			`cluster runs ${actualVersion} but the request asks for ${wantedVersion}; a version upgrade restarts every node, so this resolver reports it rather than triggering one`,
		);
	}
	const wantedRegion = optionalString(context.desired, "region");
	const actualRegion = optionalString(record, "region");
	if (
		wantedRegion !== undefined &&
		actualRegion !== undefined &&
		wantedRegion !== actualRegion
	) {
		diagnostics.push(
			`cluster is in ${actualRegion} but the request asks for ${wantedRegion}; a cluster's region is immutable and this resolver never replaces one`,
		);
	}
	return diagnostics;
}

// ---------------------------------------------------------------------------
// Wrapper and registry
// ---------------------------------------------------------------------------

/** Per-product behaviour; the wrapper owns credentials, naming, and refusals. */
interface DigitalOceanResolverSpec {
	readonly productId: string;
	reconcile(context: DigitalOceanResolverContext): Promise<ResolveOutcome>;
	read(
		context: DigitalOceanResolverContext,
	): Promise<ResolveOutcome | undefined>;
	remove(context: DigitalOceanResolverContext): Promise<void>;
}

/**
 * The SigV4 clock, refused rather than defaulted. A signer that reads the
 * ambient clock cannot be pinned by a test, which is the same reason the AWS
 * provider takes one.
 */
function clockOf(nowMs: DigitalOceanResolverOptions["nowMs"]): () => number {
	if (nowMs === undefined) {
		throw new ResolverError(
			"RESOLVER_PRODUCT_UNSUPPORTED",
			"the digitalocean spaces resolver needs an injected nowMs (a number or a () => number). SigV4 signs a timestamp, and reading the clock inside the resolver would make a signed request untestable",
		);
	}
	if (nowMs instanceof Function) return nowMs;
	if (Number.isFinite(nowMs)) return () => nowMs;
	throw new ResolverError(
		"RESOLVER_PRODUCT_UNSUPPORTED",
		"the digitalocean spaces resolver needs an injected nowMs (a number or a () => number). SigV4 signs a timestamp, and reading the clock inside the resolver would make a signed request untestable",
	);
}

function createResolver(
	spec: DigitalOceanResolverSpec,
	options: DigitalOceanResolverOptions,
): ResourceResolver {
	const maxListPages = assertListPages(options.maxListPages);
	const signsRequests = spec.productId === DIGITALOCEAN_SPACES_PRODUCT_ID;
	if (!(options.resolveCredential instanceof Function)) {
		throw new ResolverError(
			"RESOLVER_CREDENTIAL_MISSING",
			"digitalocean resolvers need an injected resolveCredential(ref): the resolver never reads an environment variable or a credential file itself",
		);
	}

	async function contextFor(
		request: ResolveRequest,
		transport: HttpTransport,
	): Promise<DigitalOceanResolverContext> {
		if (request.ref.productId !== spec.productId) {
			throw new ResolverError(
				"RESOLVER_PRODUCT_UNSUPPORTED",
				`digitalocean resolver for ${spec.productId} was handed a request for ${JSON.stringify(request.ref.productId)}; route the request through the registry rather than picking a resolver by hand`,
				spec.productId,
			);
		}
		// The Spaces path never resolves the control-plane token, and the
		// control-plane path never resolves the Spaces keys. Keeping the two
		// exclusive is what makes "the wrong secret cannot reach this origin" a
		// property of construction rather than of care.
		// The Spaces prerequisites are demanded when the Spaces resolver is
		// actually used, not when the registry is built. A registry is a
		// catalog: building one to reconcile a Postgres cluster must not fail
		// for want of an object-storage key pair that will never be sent.
		const nowMs = signsRequests ? clockOf(options.nowMs) : () => 0;
		const token = signsRequests
			? ""
			: await resolveToken(request, options.resolveCredential);
		const spacesKeys = signsRequests
			? await resolveSpacesKeys(request, options.resolveSpacesCredential)
			: undefined;
		if (
			signsRequests &&
			knownPhysicalId(request) !== undefined &&
			knownPhysicalId(request) !== resourceName(request, spec.productId)
		)
			throw new ResolverError(
				"RESOLVER_PRODUCT_UNSUPPORTED",
				"the pinned physical bucket identity differs from the requested name",
			);
		return {
			request,
			transport,
			token,
			name: resourceName(request, spec.productId),
			desired: desiredOf(request),
			knownPhysicalId: knownPhysicalId(request),
			maxListPages,
			spacesKeys,
			nowMs,
		};
	}

	return {
		providerId: DIGITALOCEAN_PROVIDER_TARGET,
		productId: spec.productId,
		async reconcile(request, transport) {
			const context = await contextFor(request, transport);
			if (context.knownPhysicalId !== undefined) {
				const observed = await spec.read(context);
				assertPinnedIdentity(context, observed);
				if (!observed)
					throw new ResolverError(
						"RESOLVER_PROVIDER_REJECTED",
						"the pinned physical resource is absent; a replacement requires a new authorized resource identity",
					);
			}
			const result = await spec.reconcile(context);
			assertPinnedIdentity(context, result);
			return lifecycleOutcome(
				result,
				result.action === "noop" || result.action === "adopt",
			);
		},
		async read(request, transport) {
			const context = await contextFor(request, transport);
			const result = await spec.read(context);
			assertPinnedIdentity(context, result);
			return result === undefined ? undefined : lifecycleOutcome(result, true);
		},
		async delete(request, transport) {
			const context = await contextFor(request, transport);
			if (context.knownPhysicalId !== undefined) {
				const observed = await spec.read(context);
				assertPinnedIdentity(context, observed);
				if (!observed) return;
			}
			await spec.remove(context);
		},
	};
}

function assertPinnedIdentity(
	context: DigitalOceanResolverContext,
	result: ResolveOutcome | undefined,
): void {
	if (
		result &&
		context.knownPhysicalId !== undefined &&
		result.physicalId !== context.knownPhysicalId
	)
		throw new ResolverError(
			"RESOLVER_OUTPUT_UNPARSEABLE",
			"provider observation differs from the pinned physical resource identity",
		);
}

function lifecycleOutcome(
	result: ResolveOutcome,
	observed: boolean,
): ResolveOutcome {
	const ready =
		result.outputs.ready === true && result.diagnostics.length === 0;
	return outcome(
		result.action,
		result.physicalId,
		{ ...result.outputs, ready, operationConfirmed: observed && ready },
		result.diagnostics,
	);
}

/**
 * Every DigitalOcean resolver, id-sorted so the list is a function of the code
 * rather than of construction order. The five catalogued products that are
 * absent are named in {@link DIGITALOCEAN_UNRESOLVED_PRODUCT_IDS}, with the
 * reason.
 */
export function digitaloceanResolvers(
	options: DigitalOceanResolverOptions,
): readonly ResourceResolver[] {
	const specs: readonly DigitalOceanResolverSpec[] = [
		{
			productId: DIGITALOCEAN_APP_SERVICE_PRODUCT_ID,
			...appPlatformSpec(DIGITALOCEAN_APP_SERVICE_PRODUCT_ID),
		},
		{
			productId: DIGITALOCEAN_APP_STATIC_SITE_PRODUCT_ID,
			...appPlatformSpec(DIGITALOCEAN_APP_STATIC_SITE_PRODUCT_ID),
		},
		{
			productId: DIGITALOCEAN_APP_WORKER_PRODUCT_ID,
			...appComponentSpec("workers", DIGITALOCEAN_APP_WORKER_PRODUCT_ID),
		},
		{ productId: DIGITALOCEAN_FUNCTIONS_PRODUCT_ID, ...FUNCTIONS_SPEC },
		{
			productId: DIGITALOCEAN_APP_JOB_PRODUCT_ID,
			...appComponentSpec("jobs", DIGITALOCEAN_APP_JOB_PRODUCT_ID),
		},
		{ productId: DIGITALOCEAN_DROPLET_PRODUCT_ID, ...DROPLET_SPEC },
		{
			productId: DIGITALOCEAN_LOAD_BALANCER_PRODUCT_ID,
			...LOAD_BALANCER_SPEC,
		},
		{
			productId: DIGITALOCEAN_MANAGED_MONGODB_PRODUCT_ID,
			...databaseSpec(DIGITALOCEAN_MANAGED_MONGODB_PRODUCT_ID),
		},
		{
			productId: DIGITALOCEAN_MANAGED_MYSQL_PRODUCT_ID,
			...databaseSpec(DIGITALOCEAN_MANAGED_MYSQL_PRODUCT_ID),
		},
		{
			productId: DIGITALOCEAN_MANAGED_OPENSEARCH_PRODUCT_ID,
			...databaseSpec(DIGITALOCEAN_MANAGED_OPENSEARCH_PRODUCT_ID),
		},
		{
			productId: DIGITALOCEAN_MANAGED_POSTGRES_PRODUCT_ID,
			...databaseSpec(DIGITALOCEAN_MANAGED_POSTGRES_PRODUCT_ID),
		},
		{
			productId: DIGITALOCEAN_MANAGED_VALKEY_PRODUCT_ID,
			...databaseSpec(DIGITALOCEAN_MANAGED_VALKEY_PRODUCT_ID),
		},
		{ productId: DIGITALOCEAN_SPACES_PRODUCT_ID, ...SPACES_SPEC },
		{
			productId: DIGITALOCEAN_BLOCK_STORAGE_PRODUCT_ID,
			...BLOCK_STORAGE_SPEC,
		},
		{
			productId: DIGITALOCEAN_KUBERNETES_CLUSTER_PRODUCT_ID,
			...KUBERNETES_CLUSTER_SPEC,
		},
	];
	return Object.freeze(
		[...specs]
			.sort((left, right) => compareStrings(left.productId, right.productId))
			.map((spec) => createResolver(spec, options)),
	);
}

/** The same resolvers, behind core's product-id lookup. */
export function digitaloceanResolverRegistry(
	options: DigitalOceanResolverOptions,
): {
	get(productId: string): ResourceResolver | undefined;
	list(): readonly ResourceResolver[];
} {
	return createResolverRegistry(digitaloceanResolvers(options));
}
