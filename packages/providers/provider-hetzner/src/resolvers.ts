/**
 * Direct Hetzner Cloud API resource resolvers — the default deployment path.
 *
 * Why this module exists: a provider package that publishes an allocatable Yard
 * catalog and ships no `ResourceResolver` fails closed on every deploy. These
 * resolvers close that gap the way the Cloudflare, GCP and AWS ones do: a
 * `ResourceResolver` per product, talking to `api.hetzner.cloud/v1` over an
 * injected, guarded transport, with no IaC engine and no state file in the
 * middle.
 *
 * The property that makes that safe is **convergence**. Hetzner's collections
 * are keyed by a server-assigned numeric id, but — unlike most provider APIs —
 * every collection here accepts an exact `?name=` filter, so "does my resource
 * already exist" is one bounded call rather than a paged scan. Every
 * `reconcile()` asks that question *before* it creates anything, then applies
 * only the mutable deltas. Running it twice yields the same `physicalId`,
 * exactly one resource, and exactly one create call, which is what makes a
 * crashed half-apply safe to re-run instead of something an operator
 * reconciles by hand. `delete()` treats "already gone" as success for the same
 * reason. `"replace"` is never emitted: replacing a server or a volume
 * destroys data, so drift on an immutable field (location, image, server type)
 * is reported as a diagnostic and left for a human.
 *
 * Hetzner returns an `Action` alongside most mutations — a long-running job
 * with `status: "running"`. This module does **not** poll it. A create comes
 * back before the server is up, and that lands in `diagnostics` as *accepted,
 * not confirmed*, because a resolver that blocked a deploy on a provider's
 * provisioning clock would be worse than one that reports the truth and lets
 * the caller decide. The action id is published in `outputs` so a caller that
 * does want to wait has something to wait on.
 *
 * A product with no convergent path ships **no resolver** rather than a
 * plausible one — see {@link HETZNER_UNRESOLVED_PRODUCT_IDS}, which names each
 * one and why. Both absences here are the same shape: a different host with a
 * different credential, which `./transport.ts` deliberately does not allowlist.
 *
 * Credentials are locators, never material. A resolver is constructed with an
 * injected `resolveCredential(ref)`; `ResolveRequest.credentialRef` must be a
 * `scheme://…` locator — the grammar core's `parseResolveRequest` enforces —
 * and a value that looks like the API token itself is refused, because a raw
 * token in a request record is a token in the event log. The token reaches
 * exactly one place: the `authorization` header. It is never logged, never put
 * in `outputs`, and Hetzner's error text is redacted before it reaches a
 * message.
 *
 * Determinism: no clock, no randomness, no environment reads.
 *
 * HONEST SCOPE (also in the README):
 *   - These resolvers are exercised against an *injected fake* transport
 *     modelling a Hetzner project. Nothing in this package proves a live
 *     deploy: that additionally needs a real token, real network egress, and a
 *     real Hetzner project, none of which a unit test supplies.
 *   - The endpoint paths, request bodies and response field names below are
 *     written from Hetzner's published API reference. They have not been
 *     replayed against the running service, so a field Hetzner has since
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
	isJsonArray,
	isJsonBoolean,
	isJsonNumber,
	isJsonObject,
	isJsonString,
	type JsonObject,
	type JsonValue,
	parseJsonObject,
} from "./json.js";
import { HETZNER_PROVIDER_TARGET } from "./options.js";
import {
	cloudServer,
	loadBalancer,
	objectStorage,
	storageBox,
	volume,
} from "./slots.js";
import {
	guardedHetznerTransport,
	guardedHetznerUnifiedApiTransport,
	guardedObjectStorageTransport,
	HETZNER_MAX_RESPONSE_BYTES,
	HETZNER_MAX_TIMEOUT_MS,
	hetznerApiUrl,
	hetznerUnifiedApiUrl,
	objectStorageUrl,
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

export const HETZNER_CLOUD_SERVER_PRODUCT_ID = productIdOf(
	cloudServer(),
	"cloudServer",
);
export const HETZNER_LOAD_BALANCER_PRODUCT_ID = productIdOf(
	loadBalancer(),
	"loadBalancer",
);
export const HETZNER_VOLUME_PRODUCT_ID = productIdOf(volume(), "volume");
export const HETZNER_OBJECT_STORAGE_PRODUCT_ID = productIdOf(
	objectStorage(),
	"objectStorage",
);
export const HETZNER_STORAGE_BOX_PRODUCT_ID = productIdOf(
	storageBox(),
	"storageBox",
);

/** Every product this module resolves, id-sorted for a deterministic registry. */
export const HETZNER_RESOLVED_PRODUCT_IDS: readonly string[] = Object.freeze(
	[
		HETZNER_CLOUD_SERVER_PRODUCT_ID,
		HETZNER_LOAD_BALANCER_PRODUCT_ID,
		HETZNER_OBJECT_STORAGE_PRODUCT_ID,
		HETZNER_STORAGE_BOX_PRODUCT_ID,
		HETZNER_VOLUME_PRODUCT_ID,
	].sort(compareStrings),
);

/**
 * Product ids this package catalogs but does not resolve.
 *
 * Empty. Every product in the Hetzner catalog has a convergent path: Cloud
 * Servers, Load Balancers and Volumes on the Cloud API, Object Storage on its
 * S3 surface, and Storage Boxes on the unified API.
 *
 * It is exported anyway, and the tests still assert that resolved + unresolved
 * accounts for the catalog exactly once. The list existing and being empty is a
 * different claim from the list not existing: a product added to `./slots.ts`
 * without a resolver has to be named here, and that is a decision a reviewer
 * sees rather than a gap nobody counted.
 */
export const HETZNER_UNRESOLVED_PRODUCT_IDS: readonly string[] = Object.freeze(
	[],
);

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

/** What a host must supply to build the resolvers. */
export interface HetznerResolverOptions {
	/**
	 * Resolves a credential *locator* to a Hetzner Cloud project API token.
	 * Injected so the resolver never holds a secret and never decides where
	 * secrets live.
	 */
	readonly resolveCredential: (ref: string) => Promise<string>;
	/**
	 * Resolves a credential *locator* to an Object Storage access key pair.
	 * Separate from `resolveCredential` because Object Storage is a separate
	 * credential: the project API token does not authenticate against
	 * `<location>.your-objectstorage.com`, and letting one function serve both
	 * would invite sending the wrong secret to the wrong origin. Required only
	 * to build the Object Storage resolver.
	 */
	readonly resolveObjectStorageCredential?: (
		ref: string,
	) => Promise<ObjectStorageKeyPair>;
	/**
	 * SigV4 signing clock, injected. Reading `Date.now()` inside the resolver
	 * would make a signed request untestable. Required only to build the
	 * Object Storage resolver.
	 */
	readonly nowMs?: number | (() => number);
	/**
	 * Resolves the create password for one Storage Box, by logical id.
	 *
	 * Keyed by logical id rather than by a locator in `desired` because core
	 * refuses credential-shaped keys in a property bag: `desired` is recorded in
	 * the event log, and the safest thing to write there about a password is
	 * nothing at all. The host maps the logical id to its own custody. Required
	 * only to build the Storage Box resolver.
	 */
	readonly resolveStorageBoxPassword?: (logicalId: string) => Promise<string>;
}

/** An Object Storage access key pair, as the host's custody hands it over. */
export interface ObjectStorageKeyPair {
	readonly accessKeyId: string;
	readonly secretAccessKey: string;
}

/**
 * A credential locator, using the same grammar core's `parseResolveRequest`
 * enforces (`scheme://path`, no userinfo). Restated here rather than imported
 * because a resolver must refuse a bad ref even when a caller skipped the parse
 * boundary — and a second grammar would be a second answer.
 */
const CREDENTIAL_REF_PATTERN = /^[a-z][a-z0-9+.-]*:\/\/[^\s@]+$/u;

/**
 * What a Hetzner Cloud API token looks like when someone pastes the value into
 * `credentialRef` by mistake — 64 alphanumeric characters. Refusing this shape
 * is the difference between a locator in the event log and a live token in the
 * event log.
 */
const RAW_CREDENTIAL_PATTERN = /^[A-Za-z0-9]{32,}$/u;

/** Anything long and token-shaped is scrubbed out of provider error text. */
const TOKEN_PATTERN = /[A-Za-z0-9_-]{20,}/gu;

/**
 * Redact provider text before it reaches a message, a diagnostic, or a log.
 * Hetzner echoes request context in `error.message`, and that context has
 * carried resource names and token fragments before.
 */
export function redactHetznerText(text: string, limit = 400): string {
	const scrubbed = text.replace(TOKEN_PATTERN, "[redacted]");
	return scrubbed.length > limit ? `${scrubbed.slice(0, limit)}…` : scrubbed;
}

// ---------------------------------------------------------------------------
// Small shared parsers
// ---------------------------------------------------------------------------

function compareStrings(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function optionalString(record: JsonObject, key: string): string | undefined {
	const value = record[key];
	return isJsonString(value) && value.trim().length > 0 ? value : undefined;
}

function optionalBoolean(record: JsonObject, key: string): boolean | undefined {
	const value = record[key];
	return isJsonBoolean(value) ? value : undefined;
}

function optionalInteger(record: JsonObject, key: string): number | undefined {
	const value = record[key];
	return isJsonNumber(value) && Number.isSafeInteger(value) ? value : undefined;
}

function hostingLabels(context: HetznerResolverContext): JsonObject {
	const labels = context.desired.labels;
	if (labels !== undefined && !isJsonObject(labels))
		throw new ResolverError(
			"RESOLVER_PRODUCT_UNSUPPORTED",
			"desired.labels must be an object",
		);
	const result: JsonObject = labels === undefined ? {} : { ...labels };
	for (const [field, prefix] of [
		["artifactDigest", "hobo-artifact"],
		["ownershipRef", "hobo-owner"],
	] as const) {
		const value = context.desired[field];
		if (value === undefined) continue;
		if (!isJsonString(value) || !/^sha256:[a-f0-9]{64}$/u.test(value))
			throw new ResolverError(
				"RESOLVER_PRODUCT_UNSUPPORTED",
				`desired.${field} must be a canonical sha256 reference`,
			);
		if (
			result[`${prefix}-a`] !== undefined ||
			result[`${prefix}-b`] !== undefined
		)
			throw new ResolverError(
				"RESOLVER_PRODUCT_UNSUPPORTED",
				"reserved hosting labels must be supplied through their dedicated fields",
			);
		Object.assign(result, {
			[`${prefix}-a`]: value.slice(7, 39),
			[`${prefix}-b`]: value.slice(39),
		});
	}
	return result;
}

function observedHostingLabels(record: JsonObject): JsonObject {
	const labels = nestedRecord(record, "labels");
	const result: JsonObject = {};
	for (const [field, prefix] of [
		["artifactDigest", "hobo-artifact"],
		["ownershipRef", "hobo-owner"],
	] as const) {
		const first = labels[`${prefix}-a`],
			second = labels[`${prefix}-b`];
		if (first === undefined && second === undefined) continue;
		if (
			!isJsonString(first) ||
			!isJsonString(second) ||
			!/^[a-f0-9]{32}$/u.test(first) ||
			!/^[a-f0-9]{32}$/u.test(second)
		)
			throw new ResolverError(
				"RESOLVER_OUTPUT_UNPARSEABLE",
				"provider returned incomplete or invalid hosting labels",
			);
		Object.assign(result, { [field]: `sha256:${first}${second}` });
	}
	return result;
}

function nestedRecord(record: JsonObject, key: string): JsonObject {
	const value = record[key];
	return isJsonObject(value) ? value : {};
}

/** Hetzner ids are numbers on every resource this module touches. */
function identityOf(record: JsonObject, label: string): string {
	const value = record.id;
	if (isJsonNumber(value) && Number.isSafeInteger(value)) {
		return String(value);
	}
	if (isJsonString(value) && value.trim().length > 0) return value;
	throw new ResolverError(
		"RESOLVER_OUTPUT_UNPARSEABLE",
		`${label}: Hetzner returned a record without a usable id, so the resource cannot be addressed`,
	);
}

// ---------------------------------------------------------------------------
// The wire
// ---------------------------------------------------------------------------

/**
 * Which token-authenticated origin a call goes to. Both take the same kind of
 * scoped API token, so the distinction is about *reach*: each has its own guard
 * policy, and a path is bound to its surface at the collection rather than
 * chosen per call.
 */
type HetznerSurface = "cloud" | "unified";

interface HetznerCall {
	readonly method: TransportMethod;
	/** Host-relative, with every dynamic segment already encoded. */
	readonly path: string;
	readonly json?: unknown;
	/** Defaults to the Cloud API, which is what most of this package speaks. */
	readonly surface?: HetznerSurface;
}

/**
 * Send one call, through the guard. The guard is applied here rather than left
 * to the caller: an unguarded transport slipping through would be a
 * legal-TypeScript security defect, and the token is in the header of every one
 * of these requests.
 */
async function send(
	context: HetznerResolverContext,
	call: HetznerCall,
): Promise<TransportResponse> {
	const body = call.json === undefined ? undefined : JSON.stringify(call.json);
	const unified = call.surface === "unified";
	const guarded = unified
		? guardedHetznerUnifiedApiTransport(context.transport)
		: guardedHetznerTransport(context.transport);
	return guarded({
		method: call.method,
		url: unified ? hetznerUnifiedApiUrl(call.path) : hetznerApiUrl(call.path),
		headers: {
			accept: "application/json",
			authorization: `Bearer ${context.token}`,
			...(body !== undefined
				? { "content-type": "application/json" }
				: undefined),
		},
		...(body !== undefined ? { body } : undefined),
		timeoutMs: HETZNER_MAX_TIMEOUT_MS,
		maxResponseBytes: HETZNER_MAX_RESPONSE_BYTES,
	});
}

function isNotFound(response: TransportResponse): boolean {
	return response.status === 404;
}

/**
 * Parse a JSON body. An empty body on a success status is `{}` — Hetzner
 * answers some deletes with `204 No Content` — and anything else that is not a
 * JSON object is `RESOLVER_OUTPUT_UNPARSEABLE`, because a body this code cannot
 * read leaves the outcome of the call unknown, and an unknown outcome is
 * refused rather than assumed.
 */
function parseJson(response: TransportResponse, label: string): JsonValue {
	if (response.body.trim().length === 0) return {};
	try {
		// SAFETY: JSON.parse yields a JSON value at this document boundary.
		return JSON.parse(response.body) as JsonValue;
	} catch {
		throw new ResolverError(
			"RESOLVER_OUTPUT_UNPARSEABLE",
			`${label}: Hetzner returned a status ${response.status} body that is not JSON, so the outcome of the call is unknown and it is refused rather than assumed`,
		);
	}
}

/**
 * The refusal path. Hetzner's error envelope is
 * `{"error":{"code":"invalid_input","message":"…"}}`; the message is redacted
 * before it is quoted, because provider text is the most common way a token
 * fragment or a caller's private path reaches a log.
 */
function providerRejection(
	response: TransportResponse,
	label: string,
): ResolverError {
	let detail = "no error detail was returned";
	try {
		const parsed = parseJson(response, label);
		const error = isJsonObject(parsed) ? nestedRecord(parsed, "error") : {};
		const code = optionalString(error, "code");
		const message = optionalString(error, "message");
		const parts = [code, message].filter(
			(part): part is string => part !== undefined,
		);
		if (parts.length > 0) detail = redactHetznerText(parts.join(": "));
	} catch {
		const snippet = response.body.trim();
		if (snippet.length > 0) detail = redactHetznerText(snippet, 160);
	}
	return new ResolverError(
		"RESOLVER_PROVIDER_REJECTED",
		`${label}: Hetzner refused the call with status ${response.status}: ${detail}`,
	);
}

/** A successful response as a record; any 4xx/5xx is a typed refusal. */
function expectOk(response: TransportResponse, label: string): JsonObject {
	if (response.status >= 400) throw providerRejection(response, label);
	const parsed = parseJson(response, label);
	if (!isJsonObject(parsed)) {
		throw new ResolverError(
			"RESOLVER_OUTPUT_UNPARSEABLE",
			`${label}: Hetzner returned JSON that is not an object (status ${response.status}), so the resource it describes cannot be identified`,
		);
	}
	return parsed;
}

// ---------------------------------------------------------------------------
// Resolver plumbing
// ---------------------------------------------------------------------------

/** Everything a resolver body needs, with the credential already resolved. */
interface HetznerResolverContext {
	readonly request: ResolveRequest;
	readonly transport: HttpTransport;
	readonly token: string;
	/** The deterministic resource name: `desired.name`, else the logical id. */
	readonly name: string;
	readonly desired: JsonObject;
	/** True when the caller already knows the physical id (adopt vs noop). */
	readonly knownPhysicalId: string | undefined;
	/** Present only on the Object Storage path; undefined elsewhere. */
	readonly objectStorageKeys: ObjectStorageKeyPair | undefined;
	/** Injected SigV4 clock. Only the Object Storage path signs. */
	readonly nowMs: () => number;
	/**
	 * The host's Storage Box password custody, if it wired one.
	 *
	 * A function rather than a resolved string so nothing is fetched for a
	 * request that does not need it, and so material never sits on a context
	 * that gets passed around. Undefined on every path but the Storage Box.
	 */
	readonly resolveStorageBoxPassword:
		| ((logicalId: string) => Promise<string>)
		| undefined;
}

function outcome(
	action: ResolverAction,
	physicalId: string,
	outputs: JsonObject,
	diagnostics: readonly string[],
): ResolveOutcome {
	return Object.freeze({
		contract: RESOLVER_CONTRACT,
		action,
		physicalId,
		outputs: Object.freeze({ ...outputs }),
		diagnostics: Object.freeze([...diagnostics]),
	});
}

/**
 * Existing resource, no delta: `noop` when the caller already named it, `adopt`
 * when the resolver found something the request did not know about. The
 * distinction is the audit record — adopting an unmanaged resource is a fact an
 * operator should see, not something folded into "nothing happened".
 */
function settledAction(context: HetznerResolverContext): ResolverAction {
	return context.knownPhysicalId === undefined ? "adopt" : "noop";
}

/**
 * The credential parse boundary. A blank ref is `RESOLVER_CREDENTIAL_MISSING`
 * (with remediation), a token-shaped one is `RESOLVER_CREDENTIAL_NOT_A_REF` — a
 * raw secret in a request record has already leaked by the time it is used —
 * and a host that hands back nothing is missing, never "carry on
 * unauthenticated", which would surface at Hetzner as a confusing 401.
 */
async function resolveToken(
	request: ResolveRequest,
	resolve: (ref: string) => Promise<string>,
): Promise<string> {
	const ref = request.credentialRef;
	if (ref.trim().length === 0) {
		throw new ResolverError(
			"RESOLVER_CREDENTIAL_MISSING",
			'hetzner resolver: credentialRef is empty. Supply a locator such as "env://HCLOUD_TOKEN" or "secret://camp/hetzner-project-token" and register it with the host credential resolver; the resolver never accepts inline credential material',
		);
	}
	const trimmed = ref.trim();
	if (RAW_CREDENTIAL_PATTERN.test(trimmed)) {
		throw new ResolverError(
			"RESOLVER_CREDENTIAL_NOT_A_REF",
			"hetzner resolver: credentialRef looks like credential material rather than a locator. Store the project API token with the host secret custody and pass its reference (scheme://path); a raw token in a ResolveRequest is a token in the event log",
		);
	}
	if (!CREDENTIAL_REF_PATTERN.test(trimmed)) {
		throw new ResolverError(
			"RESOLVER_CREDENTIAL_NOT_A_REF",
			`hetzner resolver: credentialRef ${JSON.stringify(redactHetznerText(trimmed, 60))} is not a locator. Expected "<scheme>://<path>", for example "env://HCLOUD_TOKEN"`,
		);
	}
	let material: string;
	try {
		material = await resolve(trimmed);
	} catch (cause) {
		throw new ResolverError(
			"RESOLVER_CREDENTIAL_MISSING",
			`hetzner resolver: the host could not resolve credentialRef ${JSON.stringify(trimmed)}: ${redactHetznerText(
				cause instanceof Error ? cause.message : String(cause),
				160,
			)}. Register the reference with the credential resolver before deploying`,
		);
	}
	if (material.trim().length === 0) {
		throw new ResolverError(
			"RESOLVER_CREDENTIAL_MISSING",
			`hetzner resolver: credentialRef ${JSON.stringify(trimmed)} resolved to nothing. A missing credential is refused rather than retried unauthenticated, which would look like a permissions error at Hetzner`,
		);
	}
	return material.trim();
}

/**
 * The Object Storage credential parse boundary. Same discipline as
 * `resolveToken`: the ref must be a locator, the host resolves it, and a pair
 * with an empty half is refused rather than sent as a half-signed request.
 */
async function resolveObjectStorageKeys(
	request: ResolveRequest,
	resolve: ((ref: string) => Promise<ObjectStorageKeyPair>) | undefined,
): Promise<ObjectStorageKeyPair> {
	if (resolve === undefined) {
		throw new ResolverError(
			"RESOLVER_CREDENTIAL_MISSING",
			"hetzner object storage resolver: no resolveObjectStorageCredential was injected",
		);
	}
	const ref = request.credentialRef;
	if (ref.trim().length === 0) {
		throw new ResolverError(
			"RESOLVER_CREDENTIAL_MISSING",
			'hetzner object storage resolver: credentialRef is empty. Supply a locator such as "secret://camp/hetzner-object-storage-keys"; the resolver never accepts inline credential material',
		);
	}
	const trimmed = ref.trim();
	if (RAW_CREDENTIAL_PATTERN.test(trimmed)) {
		throw new ResolverError(
			"RESOLVER_CREDENTIAL_NOT_A_REF",
			"hetzner object storage resolver: credentialRef looks like credential material rather than a locator. Store the key pair with the host secret custody and pass its reference (scheme://path)",
		);
	}
	if (!CREDENTIAL_REF_PATTERN.test(trimmed)) {
		throw new ResolverError(
			"RESOLVER_CREDENTIAL_NOT_A_REF",
			`hetzner object storage resolver: credentialRef ${JSON.stringify(redactHetznerText(trimmed, 60))} is not a locator. Expected "<scheme>://<path>"`,
		);
	}
	let keys: ObjectStorageKeyPair;
	try {
		keys = await resolve(trimmed);
	} catch (cause) {
		throw new ResolverError(
			"RESOLVER_CREDENTIAL_MISSING",
			`hetzner object storage resolver: the host could not resolve credentialRef ${JSON.stringify(trimmed)}: ${redactHetznerText(
				cause instanceof Error ? cause.message : String(cause),
				160,
			)}`,
		);
	}
	// Check the shape before reading fields: `resolve` is an injected host
	// callback, so the key-pair type is what it promises, not what it returned.
	// Reading `.accessKeyId` off `undefined` throws a TypeError -- the untyped
	// failure this boundary exists to turn into an actionable refusal.
	if (
		Object.prototype.toString.call(keys) !== "[object Object]" ||
		!isJsonString(keys.accessKeyId) ||
		!isJsonString(keys.secretAccessKey) ||
		keys.accessKeyId.trim().length === 0 ||
		keys.secretAccessKey.trim().length === 0
	) {
		throw new ResolverError(
			"RESOLVER_CREDENTIAL_MISSING",
			`hetzner object storage resolver: credentialRef ${JSON.stringify(trimmed)} resolved to an incomplete key pair. A half-populated pair would produce a signature that fails at Hetzner with a message about the wrong thing`,
		);
	}
	return {
		accessKeyId: keys.accessKeyId,
		secretAccessKey: keys.secretAccessKey,
	};
}

function resourceName(request: ResolveRequest, productId: string): string {
	const desiredName = optionalString(
		parseJsonObject(JSON.stringify(request.desired)),
		"name",
	);
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
 * The location a placed product needs. Never defaulted: a resource silently
 * created in `fsn1` because nobody said otherwise is a residency incident, not
 * a convenience — and on Hetzner it is a *jurisdiction* decision, since `fsn1`
 * and `ash` are on different continents under different law.
 */
function requiredLocation(
	context: HetznerResolverContext,
	productId: string,
): string {
	const location =
		optionalString(context.desired, "location") ??
		optionalString(context.desired, "region");
	if (location === undefined) {
		throw new ResolverError(
			"RESOLVER_PRODUCT_UNSUPPORTED",
			`${productId}: the request names no location — set desired.location (or desired.region), for example "fsn1". A location is never chosen here, because Hetzner's locations span jurisdictions and placing a resource in an unrequested one is a residency decision this resolver may not take`,
		);
	}
	return location;
}

function requiredString(
	context: HetznerResolverContext,
	key: string,
	productId: string,
	example: string,
): string {
	const value = optionalString(context.desired, key);
	if (value === undefined) {
		throw new ResolverError(
			"RESOLVER_PRODUCT_UNSUPPORTED",
			`${productId}: the request names no ${key} — set desired.${key}, for example ${JSON.stringify(example)}. This resolver invents no server type or image, because a resource billed at a size nobody asked for is a cost incident`,
		);
	}
	return value;
}

// ---------------------------------------------------------------------------
// Collections: an exact name filter, not a paged scan
// ---------------------------------------------------------------------------

/** How one collection is shaped: its host, path, list key, and item key. */
interface Collection {
	/**
	 * Which origin answers for it. Carried on the collection rather than
	 * decided at the call site so a path can never be sent to the host that
	 * does not serve it — the two hosts take the same bearer token, so nothing
	 * downstream would notice a mix-up.
	 */
	readonly surface: HetznerSurface;
	/** `/v1/servers`, `/v1/volumes`, … */
	readonly path: string;
	/** The array key in a list response: `servers`, `volumes`, … */
	readonly listKey: string;
	/** The object key in a single-item response: `server`, `volume`, … */
	readonly itemKey: string;
}

const SERVERS: Collection = Object.freeze({
	surface: "cloud",
	path: "/v1/servers",
	listKey: "servers",
	itemKey: "server",
});

const LOAD_BALANCERS: Collection = Object.freeze({
	surface: "cloud",
	path: "/v1/load_balancers",
	listKey: "load_balancers",
	itemKey: "load_balancer",
});

const VOLUMES: Collection = Object.freeze({
	surface: "cloud",
	path: "/v1/volumes",
	listKey: "volumes",
	itemKey: "volume",
});

/**
 * Storage Boxes, on the unified host.
 *
 * Same envelope and same exact `?name=` filter as the Cloud API collections,
 * which is why they share `findByName` rather than getting a second search
 * with a second set of edge cases.
 */
const STORAGE_BOXES: Collection = Object.freeze({
	surface: "unified",
	path: "/v1/storage_boxes",
	listKey: "storage_boxes",
	itemKey: "storage_box",
});

/**
 * Find the single record carrying this name.
 *
 * Hetzner's collections take an exact `?name=` filter, so this is one bounded
 * call — no paging budget, and no chance of concluding "absent" from an
 * exhausted page count. Two records under one name is still refused rather than
 * resolved: Hetzner does enforce name uniqueness per project today, so a second
 * match means either the filter did not do what this code believes or something
 * outside the project answered, and both are reasons to stop rather than to
 * pick one.
 */
async function findByName(
	context: HetznerResolverContext,
	collection: Collection,
): Promise<JsonObject | undefined> {
	const label = `hetzner list ${collection.listKey} named ${context.name}`;
	if (context.knownPhysicalId !== undefined) {
		const response = await send(context, {
			method: "GET",
			path: `${collection.path}/${encodeURIComponent(context.knownPhysicalId)}`,
			surface: collection.surface,
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
	const record = expectOk(
		await send(context, {
			method: "GET",
			path: `${collection.path}?name=${encodeURIComponent(context.name)}`,
			surface: collection.surface,
		}),
		label,
	);
	const items = record[collection.listKey];
	if (!isJsonArray(items)) {
		throw new ResolverError(
			"RESOLVER_OUTPUT_UNPARSEABLE",
			`${label}: Hetzner returned a body without a ${JSON.stringify(collection.listKey)} array, so the collection cannot be searched and a create would risk duplicating an existing resource`,
		);
	}
	if (
		items.some(
			(item) =>
				!isJsonObject(item) || optionalString(item, "name") === undefined,
		)
	)
		throw new ResolverError(
			"RESOLVER_OUTPUT_UNPARSEABLE",
			`${label}: an incomplete collection record cannot establish absence or uniqueness`,
		);
	const matches = items
		.filter(isJsonObject)
		.filter((item) => optionalString(item, "name") === context.name);
	if (matches.length > 1) {
		throw new ResolverError(
			"RESOLVER_PROVIDER_REJECTED",
			`hetzner ${collection.listKey}: the exact name filter for ${JSON.stringify(context.name)} matched ${matches.length} records. Hetzner enforces name uniqueness per project, so this means the filter did not behave as this resolver believes; choosing one by listing order would make the managed resource depend on the order the API answered in`,
		);
	}
	return matches[0];
}

/**
 * Hetzner answers a mutation with an `Action` that is still running. The id is
 * published so a caller that wants to wait has something to wait on, and the
 * diagnostic says plainly that this resolver did not wait.
 */
function actionDiagnostics(
	created: JsonObject,
	what: string,
): readonly string[] {
	const action = nestedRecord(created, "action");
	const status = optionalString(action, "status");
	if (status === undefined || status === "success") return [];
	return [
		`${what} returned action ${String(action.id ?? "?")} with status ${status}: Hetzner provisions asynchronously and this resolver does not poll, so the call is accepted, not confirmed`,
	];
}

function actionOutputs(created: JsonObject): JsonObject {
	const action = nestedRecord(created, "action");
	const id = optionalInteger(action, "id");
	return id === undefined ? {} : { actionId: id };
}

// ---------------------------------------------------------------------------
// Cloud Servers — /v1/servers
// ---------------------------------------------------------------------------

function serverOutputs(record: JsonObject): JsonObject {
	const publicNet = nestedRecord(record, "public_net");
	const ipv4 = optionalString(nestedRecord(publicNet, "ipv4"), "ip");
	const ipv6 = optionalString(nestedRecord(publicNet, "ipv6"), "ip");
	const serverType = optionalString(
		nestedRecord(record, "server_type"),
		"name",
	);
	const datacenter = nestedRecord(record, "datacenter");
	const location = optionalString(nestedRecord(datacenter, "location"), "name");
	const name = optionalString(record, "name");
	const status = optionalString(record, "status");
	return {
		...observedHostingLabels(record),
		ready: status === "running",
		operationConfirmed: status === "running",
		...(name === undefined ? undefined : { name }),
		...(status === undefined ? undefined : { status }),
		...(ipv4 !== undefined ? { ipv4 } : undefined),
		...(ipv6 !== undefined ? { ipv6 } : undefined),
		...(serverType !== undefined ? { serverType } : undefined),
		...(location !== undefined ? { location } : undefined),
	};
}

function serverDiagnostics(
	context: HetznerResolverContext,
	record: JsonObject,
): readonly string[] {
	const diagnostics: string[] = [];
	const status = optionalString(record, "status");
	if (status !== undefined && status !== "running") {
		diagnostics.push(
			`server is ${status}, not running: Hetzner provisions asynchronously and this resolver does not poll, so the create is accepted, not confirmed`,
		);
	}
	const wanted =
		optionalString(context.desired, "location") ??
		optionalString(context.desired, "region");
	const actual = optionalString(
		nestedRecord(nestedRecord(record, "datacenter"), "location"),
		"name",
	);
	if (wanted !== undefined && actual !== undefined && wanted !== actual) {
		diagnostics.push(
			`server is in ${actual} but the request asks for ${wanted}; a server cannot be moved between locations and this resolver never replaces one, so the drift is reported for a human rather than "fixed" by destroying the machine`,
		);
	}
	const wantedType = optionalString(context.desired, "serverType");
	const actualType = optionalString(
		nestedRecord(record, "server_type"),
		"name",
	);
	if (
		wantedType !== undefined &&
		actualType !== undefined &&
		wantedType !== actualType
	) {
		diagnostics.push(
			`server is type ${actualType} but the request asks for ${wantedType}; rescaling requires a power-off, which this resolver will not do to a running machine on its own — action left for a human`,
		);
	}
	return diagnostics;
}

const CLOUD_SERVER_SPEC: Omit<HetznerResolverSpec, "productId"> = {
	async read(context) {
		const observed = await findByName(context, SERVERS);
		return observed === undefined
			? undefined
			: outcome(
					settledAction(context),
					identityOf(observed, `hetzner read server ${context.name}`),
					serverOutputs(observed),
					serverDiagnostics(context, observed),
				);
	},
	async reconcile(context) {
		const observed = await findByName(context, SERVERS);
		if (observed !== undefined) {
			// Every mutable difference on a server (type, image) needs a power-off
			// or a rebuild, so there is no in-place update path here. Reporting the
			// drift is the honest outcome; "converging" it would mean taking a
			// running machine down without being asked.
			return outcome(
				settledAction(context),
				identityOf(observed, `hetzner read server ${context.name}`),
				serverOutputs(observed),
				serverDiagnostics(context, observed),
			);
		}
		const productId = HETZNER_CLOUD_SERVER_PRODUCT_ID;
		const label = `hetzner create server ${context.name}`;
		const created = expectOk(
			await send(context, {
				method: "POST",
				path: SERVERS.path,
				json: {
					name: context.name,
					server_type: requiredString(context, "serverType", productId, "cx22"),
					image: requiredString(context, "image", productId, "ubuntu-24.04"),
					location: requiredLocation(context, productId),
					labels: hostingLabels(context),
					...(optionalString(context.desired, "userData") !== undefined
						? { user_data: optionalString(context.desired, "userData") }
						: undefined),
					...(optionalBoolean(context.desired, "backups") !== undefined
						? { backups: optionalBoolean(context.desired, "backups") }
						: undefined),
					...(optionalString(context.desired, "placementGroup") !== undefined
						? {
								placement_group: optionalString(
									context.desired,
									"placementGroup",
								),
							}
						: undefined),
				},
			}),
			label,
		);
		const record = nestedRecord(created, SERVERS.itemKey);
		return outcome(
			"create",
			identityOf(record, label),
			{ ...serverOutputs(record), ...actionOutputs(created) },
			[
				...serverDiagnostics(context, record),
				...actionDiagnostics(created, "server create"),
			],
		);
	},
	async remove(context) {
		const observed = await findByName(context, SERVERS);
		if (observed === undefined) return;
		const label = `hetzner delete server ${context.name}`;
		const id = identityOf(observed, label);
		const response = await send(context, {
			method: "DELETE",
			path: `${SERVERS.path}/${encodeURIComponent(id)}`,
		});
		if (isNotFound(response)) return;
		expectOk(response, label);
	},
};

// ---------------------------------------------------------------------------
// Load Balancers — /v1/load_balancers
// ---------------------------------------------------------------------------

function loadBalancerOutputs(record: JsonObject): JsonObject {
	const publicNet = nestedRecord(record, "public_net");
	const ipv4 = optionalString(nestedRecord(publicNet, "ipv4"), "ip");
	const type = optionalString(
		nestedRecord(record, "load_balancer_type"),
		"name",
	);
	const algorithm = optionalString(nestedRecord(record, "algorithm"), "type");
	const location = optionalString(nestedRecord(record, "location"), "name");
	const name = optionalString(record, "name");
	const targets = isJsonArray(record.targets)
		? record.targets.filter(isJsonObject)
		: [];
	const hasHealthyTarget = targets.some(
		(target) =>
			isJsonArray(target.health_status) &&
			target.health_status.some(
				(health) => isJsonObject(health) && health.status === "healthy",
			),
	);
	return {
		ready: ipv4 !== undefined && hasHealthyTarget,
		...(name === undefined ? undefined : { name }),
		...(ipv4 !== undefined ? { ipv4 } : undefined),
		...(type !== undefined ? { loadBalancerType: type } : undefined),
		...(algorithm !== undefined ? { algorithm } : undefined),
		...(location !== undefined ? { location } : undefined),
	};
}

const LOAD_BALANCER_SPEC: Omit<HetznerResolverSpec, "productId"> = {
	async read(context) {
		const observed = await findByName(context, LOAD_BALANCERS);
		return observed === undefined
			? undefined
			: outcome(
					settledAction(context),
					identityOf(observed, `hetzner read load balancer ${context.name}`),
					loadBalancerOutputs(observed),
					[],
				);
	},
	async reconcile(context) {
		const productId = HETZNER_LOAD_BALANCER_PRODUCT_ID;
		const observed = await findByName(context, LOAD_BALANCERS);
		if (observed === undefined) {
			const label = `hetzner create load balancer ${context.name}`;
			const created = expectOk(
				await send(context, {
					method: "POST",
					path: LOAD_BALANCERS.path,
					json: {
						name: context.name,
						load_balancer_type: requiredString(
							context,
							"loadBalancerType",
							productId,
							"lb11",
						),
						location: requiredLocation(context, productId),
						...(optionalString(context.desired, "algorithm") !== undefined
							? {
									algorithm: {
										type: optionalString(context.desired, "algorithm"),
									},
								}
							: undefined),
						...(optionalBoolean(context.desired, "publicInterface") !==
						undefined
							? {
									public_interface: optionalBoolean(
										context.desired,
										"publicInterface",
									),
								}
							: undefined),
					},
				}),
				label,
			);
			const record = nestedRecord(created, LOAD_BALANCERS.itemKey);
			return outcome(
				"create",
				identityOf(record, label),
				{ ...loadBalancerOutputs(record), ...actionOutputs(created) },
				actionDiagnostics(created, "load balancer create"),
			);
		}
		const id = identityOf(
			observed,
			`hetzner read load balancer ${context.name}`,
		);
		const wanted = optionalString(context.desired, "algorithm");
		const current = optionalString(nestedRecord(observed, "algorithm"), "type");
		if (wanted === undefined || wanted === current) {
			return outcome(
				settledAction(context),
				id,
				loadBalancerOutputs(observed),
				[],
			);
		}
		// The algorithm has its own action endpoint; the top-level PUT only
		// changes name and labels, so sending the algorithm there would silently
		// do nothing.
		const label = `hetzner change load balancer algorithm ${context.name}`;
		const changed = expectOk(
			await send(context, {
				method: "POST",
				path: `${LOAD_BALANCERS.path}/${encodeURIComponent(id)}/actions/change_algorithm`,
				json: { type: wanted },
			}),
			label,
		);
		const refreshed = (await findByName(context, LOAD_BALANCERS)) ?? observed;
		return outcome(
			"update",
			id,
			{ ...loadBalancerOutputs(refreshed), ...actionOutputs(changed) },
			actionDiagnostics(changed, "load balancer algorithm change"),
		);
	},
	async remove(context) {
		const observed = await findByName(context, LOAD_BALANCERS);
		if (observed === undefined) return;
		const label = `hetzner delete load balancer ${context.name}`;
		const id = identityOf(observed, label);
		const response = await send(context, {
			method: "DELETE",
			path: `${LOAD_BALANCERS.path}/${encodeURIComponent(id)}`,
		});
		if (isNotFound(response)) return;
		expectOk(response, label);
	},
};

// ---------------------------------------------------------------------------
// Volumes — /v1/volumes
// ---------------------------------------------------------------------------

function volumeOutputs(record: JsonObject): JsonObject {
	const size = optionalInteger(record, "size");
	const location = optionalString(nestedRecord(record, "location"), "name");
	const linuxDevice = optionalString(record, "linux_device");
	const name = optionalString(record, "name");
	const status = optionalString(record, "status");
	return {
		ready: size !== undefined && size > 0 && linuxDevice !== undefined,
		...(name === undefined ? undefined : { name }),
		...(status === undefined ? undefined : { status }),
		...(size !== undefined ? { sizeGb: size } : undefined),
		...(location !== undefined ? { location } : undefined),
		...(linuxDevice !== undefined ? { linuxDevice } : undefined),
	};
}

function volumeDiagnostics(
	context: HetznerResolverContext,
	record: JsonObject,
): readonly string[] {
	const diagnostics: string[] = [];
	const wantedSize = optionalInteger(context.desired, "sizeGb");
	const actualSize = optionalInteger(record, "size");
	if (
		wantedSize !== undefined &&
		actualSize !== undefined &&
		wantedSize < actualSize
	) {
		diagnostics.push(
			`volume is ${actualSize} GB but the request asks for ${wantedSize} GB; Hetzner volumes only grow, so shrinking is reported for a human rather than "fixed" by replacing the volume and destroying the data on it`,
		);
	}
	const wantedLocation =
		optionalString(context.desired, "location") ??
		optionalString(context.desired, "region");
	const actualLocation = optionalString(
		nestedRecord(record, "location"),
		"name",
	);
	if (
		wantedLocation !== undefined &&
		actualLocation !== undefined &&
		wantedLocation !== actualLocation
	) {
		diagnostics.push(
			`volume is in ${actualLocation} but the request asks for ${wantedLocation}; a volume's location is immutable and this resolver never replaces one, so the drift is reported for a human`,
		);
	}
	return diagnostics;
}

const VOLUME_SPEC: Omit<HetznerResolverSpec, "productId"> = {
	async read(context) {
		const observed = await findByName(context, VOLUMES);
		return observed === undefined
			? undefined
			: outcome(
					settledAction(context),
					identityOf(observed, `hetzner read volume ${context.name}`),
					volumeOutputs(observed),
					volumeDiagnostics(context, observed),
				);
	},
	async reconcile(context) {
		const productId = HETZNER_VOLUME_PRODUCT_ID;
		const observed = await findByName(context, VOLUMES);
		if (observed === undefined) {
			const size = optionalInteger(context.desired, "sizeGb");
			if (size === undefined) {
				throw new ResolverError(
					"RESOLVER_PRODUCT_UNSUPPORTED",
					`${productId}: the request names no sizeGb — set desired.sizeGb, for example 10. A volume billed at a size nobody asked for is a cost incident, so no size is invented here`,
				);
			}
			const label = `hetzner create volume ${context.name}`;
			const created = expectOk(
				await send(context, {
					method: "POST",
					path: VOLUMES.path,
					json: {
						name: context.name,
						size,
						location: requiredLocation(context, productId),
						...(optionalString(context.desired, "format") !== undefined
							? { format: optionalString(context.desired, "format") }
							: undefined),
						...(optionalBoolean(context.desired, "automount") !== undefined
							? { automount: optionalBoolean(context.desired, "automount") }
							: undefined),
					},
				}),
				label,
			);
			const record = nestedRecord(created, VOLUMES.itemKey);
			return outcome(
				"create",
				identityOf(record, label),
				{ ...volumeOutputs(record), ...actionOutputs(created) },
				[
					...volumeDiagnostics(context, record),
					...actionDiagnostics(created, "volume create"),
				],
			);
		}
		const id = identityOf(observed, `hetzner read volume ${context.name}`);
		const wantedSize = optionalInteger(context.desired, "sizeGb");
		const actualSize = optionalInteger(observed, "size");
		if (
			wantedSize === undefined ||
			actualSize === undefined ||
			wantedSize <= actualSize
		) {
			return outcome(
				settledAction(context),
				id,
				volumeOutputs(observed),
				volumeDiagnostics(context, observed),
			);
		}
		const label = `hetzner resize volume ${context.name}`;
		const resized = expectOk(
			await send(context, {
				method: "POST",
				path: `${VOLUMES.path}/${encodeURIComponent(id)}/actions/resize`,
				json: { size: wantedSize },
			}),
			label,
		);
		const refreshed = (await findByName(context, VOLUMES)) ?? observed;
		return outcome(
			"update",
			id,
			{ ...volumeOutputs(refreshed), ...actionOutputs(resized) },
			[
				...volumeDiagnostics(context, refreshed),
				...actionDiagnostics(resized, "volume resize"),
				"a grown volume still needs its filesystem extended inside the guest; this resolver does not run commands on a machine, so that step is left to the workload",
			],
		);
	},
	async remove(context) {
		const observed = await findByName(context, VOLUMES);
		if (observed === undefined) return;
		const label = `hetzner delete volume ${context.name}`;
		const id = identityOf(observed, label);
		const response = await send(context, {
			method: "DELETE",
			path: `${VOLUMES.path}/${encodeURIComponent(id)}`,
		});
		if (isNotFound(response)) return;
		expectOk(response, label);
	},
};

// ---------------------------------------------------------------------------
// Storage Box — the unified API, and a password that is never in `desired`
// ---------------------------------------------------------------------------

/**
 * A Storage Box create needs a password, and a password is material.
 *
 * It does not come from `desired`, and there is no locator in `desired` either.
 * Core's `parseResolveRequest` refuses *any* credential-shaped key in a
 * property bag — `password`, `passwordRef`, `secret`, `token` alike — because
 * `desired` is recorded in the event log, the plan digest, and every diagnostic
 * printed from them, and a key named `passwordRef` in a log is one bad host
 * implementation away from being a password in a log. So the material arrives
 * the way the Object Storage key pair does: through an injected function the
 * host wires to its own custody, keyed by the logical id the request already
 * carries. The request names the resource; the host decides what secret belongs
 * to it; this package holds neither for longer than the call.
 */
async function storageBoxPassword(
	context: HetznerResolverContext,
): Promise<string> {
	const resolve = context.resolveStorageBoxPassword;
	if (resolve === undefined) {
		throw new ResolverError(
			"RESOLVER_CREDENTIAL_MISSING",
			`${HETZNER_STORAGE_BOX_PRODUCT_ID}: no Storage Box password resolver was injected. Construct the resolvers with resolveStorageBoxPassword(logicalId) — Hetzner requires a password at create time, it cannot travel in desired (core refuses credential-shaped keys in a property bag, because desired is recorded in the event log), and this resolver will not invent one, because a password nobody chose is a credential nobody can rotate`,
			HETZNER_STORAGE_BOX_PRODUCT_ID,
		);
	}
	const material = await resolve(context.request.ref.logicalId);
	if (material.length === 0) {
		throw new ResolverError(
			"RESOLVER_CREDENTIAL_MISSING",
			`${HETZNER_STORAGE_BOX_PRODUCT_ID}: resolveStorageBoxPassword produced no material for ${JSON.stringify(context.request.ref.logicalId)}. A create sent with an empty password would either be refused by Hetzner or, worse, accepted`,
			HETZNER_STORAGE_BOX_PRODUCT_ID,
		);
	}
	return material;
}

/** The `name` inside a nested `{ name, … }` reference object, if there is one. */
function nestedName(record: JsonObject, key: string): string | undefined {
	const nested = record[key];
	if (isJsonString(nested)) return nested;
	if (!isJsonObject(nested)) return undefined;
	return optionalString(nested, "name");
}

function storageBoxOutputs(observed: JsonObject): JsonObject {
	const type = nestedName(observed, "storage_box_type");
	const location = nestedName(observed, "location");
	const username = optionalString(observed, "username");
	const server = optionalString(observed, "server");
	return {
		ready:
			optionalString(observed, "status") === "active" && server !== undefined,
		name: optionalString(observed, "name") ?? "",
		status: optionalString(observed, "status") ?? "",
		...(type === undefined ? undefined : { storageBoxType: type }),
		...(location === undefined ? undefined : { location }),
		...(username === undefined ? undefined : { username }),
		...(server === undefined ? undefined : { server }),
		// The mount surfaces a workload actually uses. Published as outputs
		// because a binding needs them and should not have to reconstruct a
		// hostname from the record.
		...(server === undefined
			? undefined
			: {
					sftpEndpoint: `sftp://${server}`,
					sambaEndpoint: `//${server}/backup`,
				}),
	};
}

function storageBoxDiagnostics(observed: JsonObject): readonly string[] {
	const status = optionalString(observed, "status");
	const diagnostics: string[] = [];
	if (status === "initializing") {
		diagnostics.push(
			"the Storage Box is still initializing; it is not mountable until Hetzner reports status active, and this resolver does not wait",
		);
	}
	if (status === "locked") {
		diagnostics.push(
			"the Storage Box is locked, which Hetzner reports for an unpaid or administratively suspended box; a write against it will fail for a reason no code change here can fix",
		);
	}
	return Object.freeze(diagnostics);
}

const STORAGE_BOX_SPEC: Omit<HetznerResolverSpec, "productId"> = {
	async read(context) {
		const observed = await findByName(context, STORAGE_BOXES);
		return observed === undefined
			? undefined
			: outcome(
					settledAction(context),
					identityOf(observed, `hetzner read storage box ${context.name}`),
					storageBoxOutputs(observed),
					storageBoxDiagnostics(observed),
				);
	},
	async reconcile(context) {
		const productId = HETZNER_STORAGE_BOX_PRODUCT_ID;
		const observed = await findByName(context, STORAGE_BOXES);
		const wantedType = requiredString(
			context,
			"storageBoxType",
			productId,
			"bx11",
		);
		if (observed === undefined) {
			const label = `hetzner create storage box ${context.name}`;
			const created = expectOk(
				await send(context, {
					method: "POST",
					path: STORAGE_BOXES.path,
					surface: STORAGE_BOXES.surface,
					json: {
						name: context.name,
						location: requiredLocation(context, productId),
						storage_box_type: wantedType,
						// Resolved from the host's custody immediately before the
						// call, and never written back to an output or a diagnostic.
						password: await storageBoxPassword(context),
						...(isJsonObject(context.desired.labels)
							? { labels: context.desired.labels }
							: undefined),
						...(Array.isArray(context.desired.sshKeys)
							? { ssh_keys: context.desired.sshKeys }
							: undefined),
						...(isJsonObject(context.desired.accessSettings)
							? { access_settings: context.desired.accessSettings }
							: undefined),
					},
				}),
				label,
			);
			// A create answers with an Action and the box; the box is what the
			// caller needs, and the action id is published so a caller that wants
			// to wait has something to wait on.
			const record = isJsonObject(created[STORAGE_BOXES.itemKey])
				? nestedRecord(created, STORAGE_BOXES.itemKey)
				: ((await findByName(context, STORAGE_BOXES)) ??
					nestedRecord(created, STORAGE_BOXES.itemKey));
			return outcome(
				"create",
				identityOf(record, label),
				{ ...storageBoxOutputs(record), ...actionOutputs(created) },
				[
					...storageBoxDiagnostics(record),
					...actionDiagnostics(created, "storage box create"),
					"the create password came from the injected resolveStorageBoxPassword and is not in desired, in an output, or in this diagnostic; rotate it through Hetzner's reset_password action, not by re-running this resolver",
				],
			);
		}
		const id = identityOf(observed, `hetzner read storage box ${context.name}`);
		const actualType = nestedName(observed, "storage_box_type");
		if (actualType === undefined || actualType === wantedType) {
			return outcome(
				settledAction(context),
				id,
				storageBoxOutputs(observed),
				storageBoxDiagnostics(observed),
			);
		}
		const label = `hetzner change storage box type ${context.name}`;
		const changed = expectOk(
			await send(context, {
				method: "POST",
				path: `${STORAGE_BOXES.path}/${encodeURIComponent(id)}/actions/change_type`,
				surface: STORAGE_BOXES.surface,
				json: { storage_box_type: wantedType },
			}),
			label,
		);
		const refreshed = (await findByName(context, STORAGE_BOXES)) ?? observed;
		return outcome(
			"update",
			id,
			{ ...storageBoxOutputs(refreshed), ...actionOutputs(changed) },
			[
				...storageBoxDiagnostics(refreshed),
				...actionDiagnostics(changed, "storage box change_type"),
				`the type moved from ${JSON.stringify(actualType)} to ${JSON.stringify(wantedType)}; Hetzner does not shrink a Storage Box, so a smaller type is refused by the provider rather than silently ignored here`,
			],
		);
	},
	async remove(context) {
		const observed = await findByName(context, STORAGE_BOXES);
		if (observed === undefined) return;
		const label = `hetzner delete storage box ${context.name}`;
		const id = identityOf(observed, label);
		const response = await send(context, {
			method: "DELETE",
			path: `${STORAGE_BOXES.path}/${encodeURIComponent(id)}`,
			surface: STORAGE_BOXES.surface,
		});
		if (isNotFound(response)) return;
		expectOk(response, label);
	},
};

// ---------------------------------------------------------------------------
// Object Storage — S3 on <location>.your-objectstorage.com, signed with SigV4
// ---------------------------------------------------------------------------

/**
 * The one product here that does not speak to the Cloud API. It is an S3
 * surface on its own host with its own key pair, so it has its own guard
 * policy, its own credential, and its own send path — which is what makes
 * "the project token cannot reach this origin" a property of construction
 * rather than of care.
 *
 * Convergence is a plain read-or-create against S3's own documented existence
 * check: `HEAD /{bucket}` answers 200 or 404, and 404 is the only signal that
 * a create is needed.
 */
async function sendObjectStorage(
	context: HetznerResolverContext,
	call: {
		readonly method: TransportMethod;
		readonly path: string;
		readonly body?: string;
	},
): Promise<TransportResponse> {
	const location = requiredLocation(context, HETZNER_OBJECT_STORAGE_PRODUCT_ID);
	const keys = context.objectStorageKeys;
	if (keys === undefined) {
		throw new ResolverError(
			"RESOLVER_CREDENTIAL_MISSING",
			`${HETZNER_OBJECT_STORAGE_PRODUCT_ID}: no Object Storage credential was resolved. Construct the resolvers with resolveObjectStorageCredential(ref) — Object Storage uses an access key pair, not the project API token, and this package will not send one where the other belongs`,
		);
	}
	const url = objectStorageUrl(location, call.path);
	const credentials: AwsCredentials = {
		accessKeyId: keys.accessKeyId,
		secretAccessKey: keys.secretAccessKey,
	};
	const signed = signAwsRequest({
		method: call.method,
		url,
		...(call.body === undefined ? undefined : { body: call.body }),
		// Hetzner's S3 surface verifies a signature scoped to the location.
		region: location,
		service: "s3",
		credentials,
		now: new Date(context.nowMs()),
	});
	const guarded = guardedObjectStorageTransport(context.transport, location);
	return guarded({
		method: call.method,
		url,
		headers: lowerCaseHeaders(signed.headers),
		...(call.body === undefined ? undefined : { body: call.body }),
		timeoutMs: HETZNER_MAX_TIMEOUT_MS,
		maxResponseBytes: HETZNER_MAX_RESPONSE_BYTES,
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

function objectStorageOutputs(
	context: HetznerResolverContext,
	location: string,
): JsonObject {
	return {
		ready: true,
		bucketName: context.name,
		location,
		endpoint: `https://${context.name}.${location}.your-objectstorage.com`,
		s3Endpoint: `https://${location}.your-objectstorage.com`,
	};
}

const OBJECT_STORAGE_SPEC: Omit<HetznerResolverSpec, "productId"> = {
	async read(context) {
		const location = requiredLocation(
			context,
			HETZNER_OBJECT_STORAGE_PRODUCT_ID,
		);
		const response = await sendObjectStorage(context, {
			method: "HEAD",
			path: `/${encodeURIComponent(context.name)}`,
		});
		if (response.status === 404) return undefined;
		if (response.status >= 400) {
			throw providerRejection(
				response,
				`object storage read bucket ${context.name}`,
			);
		}
		return outcome(
			settledAction(context),
			context.name,
			objectStorageOutputs(context, location),
			[],
		);
	},
	async reconcile(context) {
		const location = requiredLocation(
			context,
			HETZNER_OBJECT_STORAGE_PRODUCT_ID,
		);
		const path = `/${encodeURIComponent(context.name)}`;
		const head = await sendObjectStorage(context, { method: "HEAD", path });
		if (head.status !== 404) {
			if (head.status >= 400) {
				throw providerRejection(
					head,
					`object storage read bucket ${context.name}`,
				);
			}
			return outcome(
				settledAction(context),
				context.name,
				objectStorageOutputs(context, location),
				[],
			);
		}
		const label = `object storage create bucket ${context.name}`;
		const created = await sendObjectStorage(context, { method: "PUT", path });
		if (created.status === 409) {
			throw new ResolverError(
				"RESOLVER_PROVIDER_REJECTED",
				`${label}: the bucket name is already taken. S3 bucket names are global within a location, so this is somebody else's bucket — it is reported rather than adopted, because adopting a bucket you do not own is worse than failing`,
			);
		}
		if (created.status >= 400) throw providerRejection(created, label);
		return outcome(
			"create",
			context.name,
			objectStorageOutputs(context, location),
			[
				"the bucket was created private; this resolver sets no ACL, so a bucket meant to be public still needs one applied deliberately",
			],
		);
	},
	async remove(context) {
		const label = `object storage delete bucket ${context.name}`;
		const response = await sendObjectStorage(context, {
			method: "DELETE",
			path: `/${encodeURIComponent(context.name)}`,
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
// Wrapper and registry
// ---------------------------------------------------------------------------

/** Per-product behaviour; the wrapper owns credentials, naming, and refusals. */
interface HetznerResolverSpec {
	readonly productId: string;
	reconcile(context: HetznerResolverContext): Promise<ResolveOutcome>;
	read(context: HetznerResolverContext): Promise<ResolveOutcome | undefined>;
	remove(context: HetznerResolverContext): Promise<void>;
}

/**
 * The SigV4 clock, refused rather than defaulted. A signer that reads the
 * ambient clock cannot be pinned by a test.
 */
function clockOf(nowMs: HetznerResolverOptions["nowMs"]): () => number {
	if (nowMs === undefined) {
		throw new ResolverError(
			"RESOLVER_PRODUCT_UNSUPPORTED",
			"the hetzner object storage resolver needs an injected nowMs (a number or a () => number). SigV4 signs a timestamp, and reading the clock inside the resolver would make a signed request untestable",
		);
	}
	if (nowMs instanceof Function) return nowMs;
	if (Number.isFinite(nowMs)) return () => nowMs;
	throw new ResolverError(
		"RESOLVER_PRODUCT_UNSUPPORTED",
		"the hetzner object storage resolver needs an injected nowMs (a number or a () => number). SigV4 signs a timestamp, and reading the clock inside the resolver would make a signed request untestable",
	);
}

function createResolver(
	spec: HetznerResolverSpec,
	options: HetznerResolverOptions,
): ResourceResolver {
	const signsRequests = spec.productId === HETZNER_OBJECT_STORAGE_PRODUCT_ID;
	if (options.resolveCredential === undefined) {
		throw new ResolverError(
			"RESOLVER_CREDENTIAL_MISSING",
			"hetzner resolvers need an injected resolveCredential(ref): the resolver never reads an environment variable or a credential file itself",
		);
	}

	async function contextFor(
		request: ResolveRequest,
		transport: HttpTransport,
	): Promise<HetznerResolverContext> {
		if (request.ref.productId !== spec.productId) {
			throw new ResolverError(
				"RESOLVER_PRODUCT_UNSUPPORTED",
				`hetzner resolver for ${spec.productId} was handed a request for ${JSON.stringify(request.ref.productId)}; route the request through the registry rather than picking a resolver by hand`,
				spec.productId,
			);
		}
		// The two credentials are mutually exclusive by construction: the S3
		// path never resolves the project token, and the Cloud API path never
		// resolves the S3 keys.
		// The Object Storage prerequisites are demanded when that resolver is
		// actually used, not when the registry is built. A registry is a
		// catalog: building one to reconcile a Cloud Server must not fail for
		// want of an S3 key pair that will never be sent.
		const nowMs = signsRequests ? clockOf(options.nowMs) : () => 0;
		const token = signsRequests
			? ""
			: await resolveToken(request, options.resolveCredential);
		const objectStorageKeys = signsRequests
			? await resolveObjectStorageKeys(
					request,
					options.resolveObjectStorageCredential,
				)
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
			desired: parseJsonObject(JSON.stringify(request.desired)),
			knownPhysicalId: knownPhysicalId(request),
			objectStorageKeys,
			nowMs,
			resolveStorageBoxPassword:
				spec.productId === HETZNER_STORAGE_BOX_PRODUCT_ID
					? options.resolveStorageBoxPassword
					: undefined,
		};
	}

	return {
		providerId: HETZNER_PROVIDER_TARGET,
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
	context: HetznerResolverContext,
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
 * Every Hetzner resolver, id-sorted so the list is a function of the code
 * rather than of construction order. Every catalogued product has one;
 * {@link HETZNER_UNRESOLVED_PRODUCT_IDS} is empty and stays exported so that
 * stops being true loudly rather than quietly.
 */
export function hetznerResolvers(
	options: HetznerResolverOptions,
): readonly ResourceResolver[] {
	const specs: readonly HetznerResolverSpec[] = [
		{ productId: HETZNER_CLOUD_SERVER_PRODUCT_ID, ...CLOUD_SERVER_SPEC },
		{ productId: HETZNER_LOAD_BALANCER_PRODUCT_ID, ...LOAD_BALANCER_SPEC },
		{ productId: HETZNER_VOLUME_PRODUCT_ID, ...VOLUME_SPEC },
		{
			productId: HETZNER_OBJECT_STORAGE_PRODUCT_ID,
			...OBJECT_STORAGE_SPEC,
		},
		{ productId: HETZNER_STORAGE_BOX_PRODUCT_ID, ...STORAGE_BOX_SPEC },
	];
	return Object.freeze(
		[...specs]
			.sort((left, right) => compareStrings(left.productId, right.productId))
			.map((spec) => createResolver(spec, options)),
	);
}

/** The same resolvers, behind core's product-id lookup. */
export function hetznerResolverRegistry(options: HetznerResolverOptions): {
	get(productId: string): ResourceResolver | undefined;
	list(): readonly ResourceResolver[];
} {
	return createResolverRegistry(hetznerResolvers(options));
}
