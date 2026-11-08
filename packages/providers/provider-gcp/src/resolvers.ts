/**
 * Direct Google Cloud REST resource resolvers — the default deployment path.
 *
 * Why this module exists: `@hobo/provider-gcp` published an allocatable Yard
 * catalog and no way to realize any of it, so a deploy against a GCP Yard
 * failed closed for want of a resolver. These resolvers close that gap the way
 * Cloudflare and Vercel already do: a `ResourceResolver` per product, talking to
 * Google's REST APIs over an injected, per-service-guarded transport, with no
 * IaC engine and no state file in the middle.
 *
 * The property that makes that safe is convergence. Every `reconcile()` here is
 * read-or-create: it GETs the deterministically named resource *before* it
 * creates anything, creates only when the read says absent, then applies the
 * mutable deltas. Running it twice yields the same `physicalId`, exactly one
 * resource, and exactly one create call — which is what makes a crashed
 * half-apply safe to re-run instead of something an operator reconciles by
 * hand. `delete()` treats "already gone" as success for the same reason.
 * `"replace"` is never emitted: replacing a bucket or a SQL instance destroys
 * data, so drift on an immutable field is reported as a diagnostic for a human.
 *
 * Long-running Operations are the honesty problem specific to GCP. Cloud SQL
 * and Cloud Run answer a create with an `Operation` whose `done` is `false`;
 * the resource is *not* ready, and reading that as a finished create is the
 * worst failure mode available here. So this module polls the operation to a
 * terminal state through the same injected transport, under a **bounded,
 * injected** poll budget (`operationPoll`) — no clock, no unbounded loop — and
 * when the budget runs out without a terminal answer it says so in
 * `diagnostics`: accepted, not confirmed. A `delete()` that cannot be confirmed
 * raises rather than returning quietly, because on that path silence *is* the
 * success report and there is no diagnostics channel to qualify it.
 *
 * Pub/Sub, Secret Manager and Cloud Tasks answer a second create with
 * `409 ALREADY_EXISTS`. That is a usable convergence signal, but only *after* a
 * GET: create-and-swallow-409 would hide a real conflict (someone else's
 * resource under our name) behind a shrug, so the 409 path re-reads and adopts
 * what it finds instead of assuming it is ours.
 *
 * Credentials are locators, never material. A resolver is constructed with an
 * injected `resolveCredential(ref)`; `ResolveRequest.credentialRef` must be a
 * `scheme://…` locator — the grammar core's `parseResolveRequest` enforces — and
 * a value that looks like the OAuth2 access token itself is refused, because a
 * raw token in a request record is a token in the event log. The token reaches
 * exactly one place: the `authorization` header. It is never logged, never put
 * in `outputs`, and Google's error text is redacted before it reaches a message.
 *
 * Nothing here reaches for a global `fetch`, a clock, or a random source.
 *
 * HONEST SCOPE (also in the README):
 *   - These resolvers are exercised against an *injected fake* transport.
 *     Nothing in this package proves a live deploy: that additionally needs
 *     real credentials, real network egress, and a real Google Cloud project,
 *     none of which a unit test supplies.
 *   - The endpoint paths, request bodies and response field names below are
 *     written from Google's published REST documentation. They have not been
 *     replayed against the running services, so a field Google has since
 *     renamed would fail at deploy time, not here.
 *   - Coverage is a slice of each product's API — enough to allocate, observe,
 *     converge and remove — and explicitly not the whole surface. Products with
 *     no convergent path ship no resolver at all; they are named in
 *     {@link GCP_UNRESOLVED_PRODUCT_IDS} with the reason.
 *   - The `productId` strings are read off the `./slots.js` factories, so the
 *     registry and the Yard catalog cannot drift apart. Whether a matching
 *     Resource Definition is registered is still checked at resolution time
 *     (`YARD_BINDING_PRODUCT_UNKNOWN`), not here.
 */

import {
	createResolverRegistry,
	type HttpTransport,
	parseResolveRequest,
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
import { GCP_PROVIDER_TARGET } from "./options.js";
import {
	apiGateway,
	appEngine,
	cloudFunctions,
	cloudRun,
	cloudRunJob,
	cloudSqlMysql,
	cloudSqlPostgres,
	cloudStorage,
	cloudStorageSite,
	cloudTasks,
	firestore,
	memorystoreRedis,
	pubsub,
	secretManager,
} from "./slots.js";
import {
	GCP_MAX_RESPONSE_BYTES,
	GCP_MAX_TIMEOUT_MS,
	type GcpApiService,
	gcpApiUrl,
	guardedGcpTransport,
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

export const GCP_CLOUD_RUN_PRODUCT_ID = productIdOf(cloudRun(), "cloudRun");
export const GCP_CLOUD_RUN_JOB_PRODUCT_ID = productIdOf(
	cloudRunJob(),
	"cloudRunJob",
);
export const GCP_CLOUD_SQL_MYSQL_PRODUCT_ID = productIdOf(
	cloudSqlMysql(),
	"cloudSqlMysql",
);
export const GCP_CLOUD_SQL_POSTGRES_PRODUCT_ID = productIdOf(
	cloudSqlPostgres(),
	"cloudSqlPostgres",
);
export const GCP_CLOUD_STORAGE_PRODUCT_ID = productIdOf(
	cloudStorage(),
	"cloudStorage",
);
export const GCP_CLOUD_TASKS_PRODUCT_ID = productIdOf(
	cloudTasks(),
	"cloudTasks",
);
export const GCP_MEMORYSTORE_REDIS_PRODUCT_ID = productIdOf(
	memorystoreRedis(),
	"memorystoreRedis",
);
export const GCP_PUBSUB_TOPIC_PRODUCT_ID = productIdOf(pubsub(), "pubsub");
export const GCP_SECRET_MANAGER_PRODUCT_ID = productIdOf(
	secretManager(),
	"secretManager",
);

/** Every product this module resolves, id-sorted for a deterministic registry. */
export const GCP_RESOLVED_PRODUCT_IDS: readonly string[] = Object.freeze(
	[
		GCP_CLOUD_RUN_JOB_PRODUCT_ID,
		GCP_CLOUD_RUN_PRODUCT_ID,
		GCP_CLOUD_SQL_MYSQL_PRODUCT_ID,
		GCP_CLOUD_SQL_POSTGRES_PRODUCT_ID,
		GCP_CLOUD_STORAGE_PRODUCT_ID,
		GCP_CLOUD_TASKS_PRODUCT_ID,
		GCP_MEMORYSTORE_REDIS_PRODUCT_ID,
		GCP_PUBSUB_TOPIC_PRODUCT_ID,
		GCP_SECRET_MANAGER_PRODUCT_ID,
	].sort(compareStrings),
);

/**
 * Product ids this package catalogs but deliberately cannot resolve. A
 * non-convergent resolver that duplicates a resource on every retry is worse
 * than an absent one, so these are absent and declared.
 *
 * `gcp.api-gateway/v1`: a gateway needs an `api`, an `apiConfig` and a
 * `gateway` — three long-running creates — and an `apiConfig` is immutable, so
 * changing the OpenAPI document means minting a *new* config id. `reconcile`
 * would have to invent names to converge, which is the opposite of convergence.
 *
 * `gcp.app-engine/v1`: an App Engine service exists only once a *version* is
 * deployed, versions carry server-assigned ids, and the artifact is staged
 * outside this record. There is no deterministically named resource to read
 * before creating.
 *
 * `gcp.cloud-functions/v1`: deploying a function requires uploading source to a
 * signed URL minted per call by `generateUploadUrl`. The URL is not
 * deterministic and the source bytes are not part of `desired`.
 *
 * `gcp.cloud-storage-site/v1`: the bucket half is convergent — it is the same
 * `storage.googleapis.com` surface `gcp.cloud-storage/v1` resolves — but the
 * product is a *served site*, and `cdn: true` additionally needs a backend
 * bucket, a URL map, a target proxy and a forwarding rule on
 * `compute.googleapis.com`. Shipping only the bucket half would silently
 * under-deliver the product.
 *
 * `gcp.firestore/v1`: a database's id, location and mode are fixed at creation
 * and deletion is gated on an etag plus a delete-protection override this
 * package does not model, so only half the lifecycle would be expressible.
 */
export const GCP_UNRESOLVED_PRODUCT_IDS: readonly string[] = Object.freeze(
	[
		productIdOf(apiGateway(), "apiGateway"),
		productIdOf(appEngine(), "appEngine"),
		productIdOf(cloudFunctions(), "cloudFunctions"),
		productIdOf(cloudStorageSite(), "cloudStorageSite"),
		productIdOf(firestore(), "firestore"),
	].sort(compareStrings),
);

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

/**
 * How far a resolver may chase a long-running Operation, and what it does
 * between attempts. Both are injected: a poll count that came from nowhere is
 * an unbounded loop waiting to happen, and a wait that reads a clock makes the
 * resolver non-deterministic. The default waits not at all, which is what a
 * test wants; a host that wants real backoff supplies `beforeAttempt`.
 */
export interface GcpOperationPollBudget {
	/** Re-reads of the operation after the initial answer. Never unbounded. */
	readonly attempts: number;
	/** Injected pause before each re-read; omitted means "do not wait". */
	readonly beforeAttempt?: (attempt: number) => Promise<void>;
}

/** What a host must supply to build the resolvers. */
export interface GcpResolverOptions {
	/** The Google Cloud project every path is scoped to. */
	readonly projectId: string;
	/**
	 * Resolves a credential *locator* to an OAuth2 access token. Injected so the
	 * resolver never holds a secret and never decides where secrets live.
	 */
	readonly resolveCredential: (ref: string) => Promise<string>;
	/** Operation poll budget; defaults to {@link DEFAULT_OPERATION_POLL}. */
	readonly operationPoll?: GcpOperationPollBudget;
}

/**
 * Three re-reads, no waiting. Small on purpose: a resolver that blocks a deploy
 * for minutes is worse than one that reports "accepted, not confirmed" and lets
 * the caller decide.
 */
const DEFAULT_OPERATION_POLL: GcpOperationPollBudget = Object.freeze({
	attempts: 3,
});

/**
 * A credential locator, using the same grammar core's `parseResolveRequest`
 * enforces (`scheme://path`, no userinfo). Restated here rather than imported
 * because a resolver must refuse a bad ref even when a caller skipped the parse
 * boundary — and a second grammar would be a second answer.
 */
const CREDENTIAL_REF_PATTERN = /^[a-z][a-z0-9+.-]*:\/\/[^\s@]+$/u;

/**
 * What a Google OAuth2 access token looks like when someone pastes the value
 * into `credentialRef` by mistake. Refusing this shape is the difference
 * between a locator in the event log and a live token in the event log.
 */
const RAW_CREDENTIAL_PATTERN = /^[A-Za-z0-9._~+/-]{20,}=*$/u;

/** Anything long and token-shaped is scrubbed out of provider error text. */
const TOKEN_PATTERN = /[A-Za-z0-9_-]{20,}/gu;

/** A Cloud Run operation name: `projects/…/locations/…/operations/…`. */
const RUN_OPERATION_NAME_PATTERN =
	/^projects\/[A-Za-z0-9._~-]{1,120}\/locations\/[A-Za-z0-9._~-]{1,120}\/operations\/[A-Za-z0-9._~-]{1,120}$/u;

/** A Cloud SQL operation name: one opaque segment, never a path. */
const SQL_OPERATION_NAME_PATTERN = /^[A-Za-z0-9._~-]{1,120}$/u;

/** A Memorystore operation name: `projects/…/locations/…/operations/…`. */
const REDIS_OPERATION_NAME_PATTERN =
	/^projects\/[A-Za-z0-9._~-]{1,120}\/locations\/[A-Za-z0-9._~-]{1,120}\/operations\/[A-Za-z0-9._~-]{1,120}$/u;

/** Google's engine enum, e.g. `POSTGRES_15`. Never composed from a bare "15". */
const DATABASE_VERSION_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/u;

/**
 * Redact provider text before it reaches a message, a diagnostic, or a log.
 * Google echoes request context in `error.message`, and that context has
 * carried resource paths and token fragments before.
 */
export function redactGcpText(text: string, limit = 400): string {
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

function optionalNumber(record: JsonObject, key: string): number | undefined {
	const value = record[key];
	return isJsonNumber(value) && Number.isFinite(value) ? value : undefined;
}

function optionalStringArray(
	record: JsonObject,
	key: string,
): readonly string[] | undefined {
	const value = record[key];
	if (!isJsonArray(value)) return undefined;
	return value.every(isJsonString) ? [...value] : undefined;
}

function nestedRecord(record: JsonObject, key: string): JsonObject {
	const value = record[key];
	return isJsonObject(value) ? value : {};
}

// ---------------------------------------------------------------------------
// The wire
// ---------------------------------------------------------------------------

interface GcpCall {
	readonly method: TransportMethod;
	/** Host-relative, with every dynamic segment already encoded. */
	readonly path: string;
	readonly json?: unknown;
}

/**
 * Send one call to one service, through that service's guard. The guard is
 * applied here rather than left to the caller: a per-service policy is the
 * whole reason a Cloud SQL path cannot be sent to the Cloud Storage host, and
 * an unguarded transport slipping through would be a legal-TypeScript security
 * defect.
 */
async function send(
	service: GcpApiService,
	context: GcpResolverContext,
	call: GcpCall,
): Promise<TransportResponse> {
	const body = call.json === undefined ? undefined : JSON.stringify(call.json);
	const guarded = guardedGcpTransport(context.transport, service);
	return guarded({
		method: call.method,
		url: gcpApiUrl(service, call.path),
		headers: {
			accept: "application/json",
			authorization: `Bearer ${context.token}`,
			...(body !== undefined
				? { "content-type": "application/json" }
				: undefined),
		},
		...(body !== undefined ? { body } : undefined),
		timeoutMs: GCP_MAX_TIMEOUT_MS,
		maxResponseBytes: GCP_MAX_RESPONSE_BYTES,
	});
}

/** 404 means "not there", which every read-or-create path needs to tell apart. */
function isNotFound(response: TransportResponse): boolean {
	return response.status === 404;
}

/** 409 means "someone got there first", which is a re-read, not a failure. */
function isAlreadyExists(response: TransportResponse): boolean {
	return response.status === 409;
}

/**
 * Parse a JSON body. An empty body on a success status is `{}` — Google answers
 * some deletes with `204 No Content` — and anything else that is not a JSON
 * object is `RESOLVER_OUTPUT_UNPARSEABLE`, because a body this code cannot read
 * leaves the outcome of the call unknown, and an unknown outcome is refused
 * rather than assumed.
 */
function parseJson(response: TransportResponse, label: string): JsonValue {
	if (response.body.trim().length === 0) return {};
	try {
		// SAFETY: JSON.parse yields a JSON value at this document boundary.
		return JSON.parse(response.body) as JsonValue;
	} catch {
		throw new ResolverError(
			"RESOLVER_OUTPUT_UNPARSEABLE",
			`${label}: Google returned a status ${response.status} body that is not JSON, so the outcome of the call is unknown and it is refused rather than assumed`,
		);
	}
}

function parseJsonRecord(
	response: TransportResponse,
	label: string,
): JsonObject {
	const parsed = parseJson(response, label);
	if (!isJsonObject(parsed)) {
		throw new ResolverError(
			"RESOLVER_OUTPUT_UNPARSEABLE",
			`${label}: Google returned JSON that is not an object (status ${response.status}), so the resource it describes cannot be identified`,
		);
	}
	return parsed;
}

/**
 * The refusal path. Google's error envelope is
 * `{"error":{"code":403,"message":"…","status":"PERMISSION_DENIED"}}`; the
 * message is redacted before it is quoted, because provider text is the most
 * common way a token fragment or a caller's private path reaches a log.
 */
function providerRejection(
	response: TransportResponse,
	label: string,
): ResolverError {
	let detail = "no error detail was returned";
	try {
		const record = parseJsonRecord(response, label);
		const error = nestedRecord(record, "error");
		const message = optionalString(error, "message");
		const status = optionalString(error, "status");
		const parts = [status, message].filter(
			(part): part is string => part !== undefined,
		);
		if (parts.length > 0) detail = redactGcpText(parts.join(": "));
	} catch {
		const snippet = response.body.trim();
		if (snippet.length > 0) detail = redactGcpText(snippet, 160);
	}
	return new ResolverError(
		"RESOLVER_PROVIDER_REJECTED",
		`${label}: Google refused the call with status ${response.status}: ${detail}`,
	);
}

/** A successful response as a record; any 4xx/5xx is a typed refusal. */
function expectOk(response: TransportResponse, label: string): JsonObject {
	if (response.status >= 400) throw providerRejection(response, label);
	return parseJsonRecord(response, label);
}

function requireString(record: JsonObject, key: string, label: string): string {
	const value = optionalString(record, key);
	if (value === undefined) {
		throw new ResolverError(
			"RESOLVER_OUTPUT_UNPARSEABLE",
			`${label}: Google returned a record without a usable ${JSON.stringify(key)}, so the resource cannot be addressed`,
		);
	}
	return value;
}

// ---------------------------------------------------------------------------
// Long-running Operations
// ---------------------------------------------------------------------------

/** A `google.longrunning.Operation`, or Cloud SQL's `status`-shaped cousin. */
interface GcpOperation {
	readonly name: string;
	readonly done: boolean;
	readonly errorText: string | undefined;
}

/**
 * Read an operation. Two vocabularies, one meaning: the standard LRO says
 * `done: true`, and Cloud SQL says `status: "DONE"`. Anything else — including
 * a missing `done` — is *not* finished, which is the whole point: silently
 * reading a running operation as a finished create is the failure this module
 * exists to avoid.
 */
function parseOperation(
	record: JsonObject,
	label: string,
	namePattern: RegExp,
): GcpOperation {
	const name = requireString(record, "name", label);
	if (!namePattern.test(name)) {
		throw new ResolverError(
			"RESOLVER_OUTPUT_UNPARSEABLE",
			`${label}: Google returned an operation name that is not the documented shape, so it cannot be polled and the call's outcome is unknown`,
		);
	}
	const status = optionalString(record, "status");
	return {
		name,
		done: record.done === true || status === "DONE",
		errorText: operationErrorText(record),
	};
}

/** `{error:{message}}` (LRO) and `{error:{errors:[{message}]}}` (Cloud SQL). */
function operationErrorText(record: JsonObject): string | undefined {
	const error = record.error;
	if (!isJsonObject(error)) return undefined;
	const direct = optionalString(error, "message");
	if (direct !== undefined) return redactGcpText(direct);
	const errors = error.errors;
	if (isJsonArray(errors)) {
		const messages = errors
			.filter(isJsonObject)
			.map((entry) => optionalString(entry, "message"))
			.filter((entry): entry is string => entry !== undefined);
		if (messages.length > 0) return redactGcpText(messages.join("; "));
	}
	const code = optionalInteger(error, "code");
	return code === undefined
		? "the operation failed without a message"
		: `the operation failed with code ${code}`;
}

/**
 * Chase an operation to a terminal state, within the injected budget. Returns
 * the last state seen: a caller that gets `done: false` back must report that
 * honestly rather than treating the resource as ready.
 */
async function awaitOperation(
	service: GcpApiService,
	context: GcpResolverContext,
	operation: GcpOperation,
	pollPath: (name: string) => string,
	namePattern: RegExp,
	label: string,
): Promise<GcpOperation> {
	let current = operation;
	const attempts = Math.max(0, Math.trunc(context.poll.attempts));
	for (let attempt = 1; attempt <= attempts && !current.done; attempt += 1) {
		const wait = context.poll.beforeAttempt;
		if (wait !== undefined) await wait(attempt);
		const response = await send(service, context, {
			method: "GET",
			path: pollPath(current.name),
		});
		current = parseOperation(
			expectOk(response, `${label} (poll ${attempt})`),
			`${label} (poll ${attempt})`,
			namePattern,
		);
		if (current.name !== operation.name) {
			throw new ResolverError(
				"RESOLVER_OUTPUT_UNPARSEABLE",
				`${label}: operation identity changed while polling; a foreign operation cannot confirm this resource`,
			);
		}
	}
	if (current.errorText !== undefined) {
		throw new ResolverError(
			"RESOLVER_PROVIDER_REJECTED",
			`${label}: the operation finished with an error: ${current.errorText}`,
		);
	}
	return current;
}

/** The diagnostic an unconfirmed operation earns. Never silence. */
function unconfirmedDiagnostic(
	context: GcpResolverContext,
	label: string,
): string {
	return `${label}: Google accepted the request but the operation was still running after ${context.poll.attempts} poll(s); the resource is NOT confirmed ready — re-run reconcile to converge, or raise the operationPoll budget`;
}

// ---------------------------------------------------------------------------
// Resolver plumbing
// ---------------------------------------------------------------------------

/** Everything a resolver body needs, with the credential already resolved. */
interface GcpResolverContext {
	readonly request: ResolveRequest;
	readonly transport: HttpTransport;
	readonly token: string;
	readonly projectId: string;
	/** The deterministic resource name: `desired.name`, else the logical id. */
	readonly name: string;
	readonly desired: JsonObject;
	/** True when the caller already knows the physical id (adopt vs noop). */
	readonly knownPhysicalId: string | undefined;
	readonly poll: GcpOperationPollBudget;
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
function settledAction(context: GcpResolverContext): ResolverAction {
	return context.knownPhysicalId === undefined ? "adopt" : "noop";
}

function assertProjectId(projectId: string): string {
	// `typeof` first: this is called with option-bag input, so the annotation is
	// a claim about the caller rather than a fact about the value, and
	// `.trim()` on a non-string throws a TypeError instead of naming the field.
	if (
		!isJsonString(projectId) ||
		!/^[a-z0-9][a-z0-9-]{0,62}$/u.test(projectId)
	) {
		throw new ResolverError(
			"RESOLVER_PRODUCT_UNSUPPORTED",
			"gcp resolvers need a projectId: every Google API path is project-scoped, and guessing one would target the wrong project",
		);
	}
	return projectId;
}

function assertPollBudget(
	budget: GcpOperationPollBudget | undefined,
): GcpOperationPollBudget {
	if (budget === undefined) return DEFAULT_OPERATION_POLL;
	const { attempts } = budget;
	if (!Number.isSafeInteger(attempts) || attempts < 0 || attempts > 100) {
		throw new ResolverError(
			"RESOLVER_PRODUCT_UNSUPPORTED",
			`gcp resolvers need a bounded operationPoll.attempts between 0 and 100, received ${JSON.stringify(attempts)}; an unbounded poll is an unbounded deploy`,
		);
	}
	return budget;
}

/**
 * The credential parse boundary. A blank ref is `RESOLVER_CREDENTIAL_MISSING`
 * (with remediation), a token-shaped one is `RESOLVER_CREDENTIAL_NOT_A_REF` — a
 * raw secret in a request record has already leaked by the time it is used —
 * and a host that hands back nothing is missing, never "carry on
 * unauthenticated", which would surface at Google as a confusing 401.
 */
async function resolveToken(
	request: ResolveRequest,
	resolve: (ref: string) => Promise<string>,
): Promise<string> {
	const ref = request.credentialRef;
	if (ref.trim().length === 0) {
		throw new ResolverError(
			"RESOLVER_CREDENTIAL_MISSING",
			'gcp resolver: credentialRef is empty. Supply a locator such as "env://GOOGLE_OAUTH_ACCESS_TOKEN" or "secret://camp/gcp-access-token" and register it with the host credential resolver; the resolver never accepts inline credential material',
		);
	}
	const trimmed = ref.trim();
	if (RAW_CREDENTIAL_PATTERN.test(trimmed)) {
		throw new ResolverError(
			"RESOLVER_CREDENTIAL_NOT_A_REF",
			"gcp resolver: credentialRef looks like credential material rather than a locator. Store the access token with the host secret custody and pass its reference (scheme://path); a raw token in a ResolveRequest is a token in the event log",
		);
	}
	if (!CREDENTIAL_REF_PATTERN.test(trimmed)) {
		throw new ResolverError(
			"RESOLVER_CREDENTIAL_NOT_A_REF",
			`gcp resolver: credentialRef ${JSON.stringify(redactGcpText(trimmed, 60))} is not a locator. Expected "<scheme>://<path>", for example "env://GOOGLE_OAUTH_ACCESS_TOKEN"`,
		);
	}
	let material: string;
	try {
		material = await resolve(trimmed);
	} catch (cause) {
		throw new ResolverError(
			"RESOLVER_CREDENTIAL_MISSING",
			`gcp resolver: the host could not resolve credentialRef ${JSON.stringify(trimmed)}: ${redactGcpText(
				cause instanceof Error ? cause.message : String(cause),
				160,
			)}. Register the reference with the credential resolver before deploying`,
		);
	}
	if (material.trim().length === 0) {
		throw new ResolverError(
			"RESOLVER_CREDENTIAL_MISSING",
			`gcp resolver: credentialRef ${JSON.stringify(trimmed)} resolved to nothing. A missing credential is refused rather than retried unauthenticated, which would look like a permissions error at Google`,
		);
	}
	return material.trim();
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
 * The region a regional product needs. Never defaulted: a resource silently
 * created in `us-central1` because nobody said otherwise is a residency
 * incident, not a convenience.
 */
function requiredLocation(
	context: GcpResolverContext,
	productId: string,
): string {
	const location =
		optionalString(context.desired, "location") ??
		optionalString(context.desired, "region");
	if (location === undefined) {
		throw new ResolverError(
			"RESOLVER_PRODUCT_UNSUPPORTED",
			`${productId}: the request names no location — set desired.location (or desired.region), for example "us-central1". A region is never chosen here, because a resource placed in an unrequested region is a residency decision this resolver may not take`,
		);
	}
	return location;
}

/** Per-product behaviour; the wrapper owns credentials, naming, and refusals. */
interface GcpResolverSpec {
	readonly productId: string;
	reconcile(context: GcpResolverContext): Promise<ResolveOutcome>;
	read(context: GcpResolverContext): Promise<ResolveOutcome | undefined>;
	remove(context: GcpResolverContext): Promise<void>;
}

function createResolver(
	spec: GcpResolverSpec,
	options: GcpResolverOptions,
): ResourceResolver {
	const projectId = assertProjectId(options.projectId);
	const poll = assertPollBudget(options.operationPoll);

	async function contextFor(
		input: ResolveRequest,
		transport: HttpTransport,
	): Promise<GcpResolverContext> {
		const request = parseResolveRequest(parseJsonObject(JSON.stringify(input)));
		if (request.ref.productId !== spec.productId) {
			throw new ResolverError(
				"RESOLVER_PRODUCT_UNSUPPORTED",
				`gcp resolver for ${spec.productId} was handed a request for ${JSON.stringify(request.ref.productId)}; route the request through the registry rather than picking a resolver by hand`,
			);
		}
		const token = await resolveToken(request, options.resolveCredential);
		return {
			request,
			transport,
			token,
			projectId,
			name: resourceName(request, spec.productId),
			desired: parseJsonObject(JSON.stringify(request.desired)),
			knownPhysicalId: knownPhysicalId(request),
			poll,
		};
	}

	return {
		providerId: GCP_PROVIDER_TARGET,
		productId: spec.productId,
		async reconcile(request, transport) {
			return spec.reconcile(await contextFor(request, transport));
		},
		async read(request, transport) {
			return spec.read(await contextFor(request, transport));
		},
		async delete(request, transport) {
			await spec.remove(await contextFor(request, transport));
		},
	};
}

// ---------------------------------------------------------------------------
// Cloud Storage buckets — storage.googleapis.com/storage/v1/b
// ---------------------------------------------------------------------------

function bucketPath(context: GcpResolverContext): string {
	return `/storage/v1/b/${encodeURIComponent(context.name)}`;
}

function bucketCreatePath(context: GcpResolverContext): string {
	return `/storage/v1/b?project=${encodeURIComponent(context.projectId)}`;
}

/** GCS reports `storageClass` upper-cased; a case-sensitive compare would
 *  report permanent drift on a bucket that is exactly as requested. */
function desiredStorageClass(context: GcpResolverContext): string | undefined {
	const value = optionalString(context.desired, "storageClass");
	return value === undefined ? undefined : value.toUpperCase();
}

function desiredPublicAccessPrevention(
	context: GcpResolverContext,
): string | undefined {
	const blocked = optionalBoolean(context.desired, "publicAccessBlocked");
	if (blocked === undefined) return undefined;
	return blocked ? "enforced" : "inherited";
}

function bucketOutputs(
	context: GcpResolverContext,
	record: JsonObject,
): JsonObject {
	const location = optionalString(record, "location");
	const storageClass = optionalString(record, "storageClass");
	const iam = nestedRecord(record, "iamConfiguration");
	const uniform = optionalBoolean(
		nestedRecord(iam, "uniformBucketLevelAccess"),
		"enabled",
	);
	return {
		bucketName: context.name,
		...(location !== undefined ? { location } : undefined),
		...(storageClass !== undefined ? { storageClass } : undefined),
		...(uniform !== undefined
			? { uniformBucketLevelAccess: uniform }
			: undefined),
	};
}

function bucketDiagnostics(
	context: GcpResolverContext,
	record: JsonObject,
): readonly string[] {
	const diagnostics: string[] = [];
	const wanted =
		optionalString(context.desired, "location") ??
		optionalString(context.desired, "region");
	const actual = optionalString(record, "location");
	if (
		wanted !== undefined &&
		actual !== undefined &&
		wanted.toUpperCase() !== actual.toUpperCase()
	) {
		diagnostics.push(
			`bucket location is ${actual} but the request asks for ${wanted}; a bucket's location is immutable and this resolver never replaces a bucket, so the drift is reported for a human rather than "fixed" by destroying the data`,
		);
	}
	return diagnostics;
}

/** The mutable deltas, as a PATCH body; `undefined` when nothing drifted. */
function bucketPatch(
	context: GcpResolverContext,
	record: JsonObject,
): JsonObject | undefined {
	const patch = {};
	const storageClass = desiredStorageClass(context);
	if (
		storageClass !== undefined &&
		storageClass !== optionalString(record, "storageClass")?.toUpperCase()
	) {
		Object.assign(patch, { storageClass });
	}
	const versioning = optionalBoolean(context.desired, "versioning");
	if (
		versioning !== undefined &&
		versioning !==
			(optionalBoolean(nestedRecord(record, "versioning"), "enabled") ?? false)
	) {
		Object.assign(patch, { versioning: { enabled: versioning } });
	}
	const iam = nestedRecord(record, "iamConfiguration");
	const iamPatch = {};
	const uniform = optionalBoolean(context.desired, "uniformBucketLevelAccess");
	if (
		uniform !== undefined &&
		uniform !==
			(optionalBoolean(
				nestedRecord(iam, "uniformBucketLevelAccess"),
				"enabled",
			) ?? false)
	) {
		Object.assign(iamPatch, {
			uniformBucketLevelAccess: { enabled: uniform },
		});
	}
	const prevention = desiredPublicAccessPrevention(context);
	if (
		prevention !== undefined &&
		prevention !== optionalString(iam, "publicAccessPrevention")
	) {
		Object.assign(iamPatch, { publicAccessPrevention: prevention });
	}
	if (Object.keys(iamPatch).length > 0) {
		Object.assign(patch, { iamConfiguration: iamPatch });
	}
	return Object.keys(patch).length > 0 ? patch : undefined;
}

async function readBucket(
	context: GcpResolverContext,
): Promise<JsonObject | undefined> {
	const label = `cloud storage read bucket ${context.name}`;
	const response = await send("cloudStorage", context, {
		method: "GET",
		path: bucketPath(context),
	});
	if (isNotFound(response)) return undefined;
	return expectOk(response, label);
}

const CLOUD_STORAGE_SPEC: Omit<GcpResolverSpec, "productId"> = {
	async read(context) {
		const observed = await readBucket(context);
		return observed === undefined
			? undefined
			: outcome(
					settledAction(context),
					context.name,
					bucketOutputs(context, observed),
					bucketDiagnostics(context, observed),
				);
	},
	async reconcile(context) {
		const observed = await readBucket(context);
		if (observed === undefined) {
			const label = `cloud storage create bucket ${context.name}`;
			const location =
				optionalString(context.desired, "location") ??
				optionalString(context.desired, "region");
			const storageClass = desiredStorageClass(context);
			const versioning = optionalBoolean(context.desired, "versioning");
			const uniform = optionalBoolean(
				context.desired,
				"uniformBucketLevelAccess",
			);
			const prevention = desiredPublicAccessPrevention(context);
			const iamConfiguration = {
				...(uniform !== undefined
					? { uniformBucketLevelAccess: { enabled: uniform } }
					: undefined),
				...(prevention !== undefined
					? { publicAccessPrevention: prevention }
					: undefined),
			};
			const created = expectOk(
				await send("cloudStorage", context, {
					method: "POST",
					path: bucketCreatePath(context),
					json: {
						name: context.name,
						...(location !== undefined ? { location } : undefined),
						...(storageClass !== undefined ? { storageClass } : undefined),
						...(versioning !== undefined
							? { versioning: { enabled: versioning } }
							: undefined),
						...(Object.keys(iamConfiguration).length > 0
							? { iamConfiguration }
							: undefined),
					},
				}),
				label,
			);
			return outcome(
				"create",
				context.name,
				bucketOutputs(context, created),
				bucketDiagnostics(context, created),
			);
		}
		const patch = bucketPatch(context, observed);
		if (patch === undefined) {
			return outcome(
				settledAction(context),
				context.name,
				bucketOutputs(context, observed),
				bucketDiagnostics(context, observed),
			);
		}
		const label = `cloud storage update bucket ${context.name}`;
		const updated = expectOk(
			await send("cloudStorage", context, {
				method: "PATCH",
				path: bucketPath(context),
				json: patch,
			}),
			label,
		);
		return outcome("update", context.name, bucketOutputs(context, updated), [
			`applied bucket settings: ${Object.keys(patch).sort(compareStrings).join(", ")}`,
			...bucketDiagnostics(context, updated),
		]);
	},
	async remove(context) {
		const response = await send("cloudStorage", context, {
			method: "DELETE",
			path: bucketPath(context),
		});
		if (isNotFound(response)) return;
		expectOk(response, `cloud storage delete bucket ${context.name}`);
	},
};

// ---------------------------------------------------------------------------
// Pub/Sub topics — pubsub.googleapis.com/v1/projects/{project}/topics/{topic}
// ---------------------------------------------------------------------------

function topicResourceName(context: GcpResolverContext): string {
	return `projects/${context.projectId}/topics/${context.name}`;
}

function topicPath(context: GcpResolverContext): string {
	return `/v1/projects/${encodeURIComponent(context.projectId)}/topics/${encodeURIComponent(context.name)}`;
}

function retentionDuration(context: GcpResolverContext): string | undefined {
	const seconds = optionalNumber(context.desired, "messageRetentionSeconds");
	return seconds === undefined ? undefined : `${seconds}s`;
}

function topicOutputs(
	context: GcpResolverContext,
	record: JsonObject,
): JsonObject {
	const retention = optionalString(record, "messageRetentionDuration");
	return {
		resourceName: topicResourceName(context),
		topicId: context.name,
		...(retention !== undefined
			? { messageRetentionDuration: retention }
			: undefined),
	};
}

function topicDiagnostics(context: GcpResolverContext): readonly string[] {
	const diagnostics: string[] = [];
	if (optionalBoolean(context.desired, "messageOrdering") === true) {
		diagnostics.push(
			"messageOrdering is declared but not applied: Pub/Sub ordering is set per publish request and per subscription, not on the topic resource",
		);
	}
	if (optionalString(context.desired, "schemaId") !== undefined) {
		diagnostics.push(
			"schemaId is declared but not applied: attaching a schema additionally requires a message encoding this record does not carry, and guessing one would attach the wrong contract to the topic",
		);
	}
	return diagnostics;
}

async function readTopic(
	context: GcpResolverContext,
): Promise<JsonObject | undefined> {
	const response = await send("pubsub", context, {
		method: "GET",
		path: topicPath(context),
	});
	if (isNotFound(response)) return undefined;
	return expectOk(response, `pubsub read topic ${context.name}`);
}

const PUBSUB_TOPIC_SPEC: Omit<GcpResolverSpec, "productId"> = {
	async read(context) {
		const observed = await readTopic(context);
		return observed === undefined
			? undefined
			: outcome(
					settledAction(context),
					topicResourceName(context),
					topicOutputs(context, observed),
					topicDiagnostics(context),
				);
	},
	async reconcile(context) {
		const retention = retentionDuration(context);
		const observed = await readTopic(context);
		if (observed === undefined) {
			const label = `pubsub create topic ${context.name}`;
			const response = await send("pubsub", context, {
				method: "PUT",
				path: topicPath(context),
				json: {
					...(retention !== undefined
						? { messageRetentionDuration: retention }
						: undefined),
				},
			});
			if (isAlreadyExists(response)) {
				// A create raced another writer. The 409 alone would not say whose
				// topic won, so the answer comes from a re-read, not a shrug.
				const raced = await readTopic(context);
				if (raced === undefined) {
					throw new ResolverError(
						"RESOLVER_PROVIDER_REJECTED",
						`${label}: Pub/Sub reported the topic already exists but a re-read found nothing, so the resource cannot be identified and creating another would risk a duplicate`,
					);
				}
				return outcome(
					"adopt",
					topicResourceName(context),
					topicOutputs(context, raced),
					[
						"adopted a topic created concurrently: the create returned 409 ALREADY_EXISTS and the re-read found it",
						...topicDiagnostics(context),
					],
				);
			}
			const created = expectOk(response, label);
			return outcome(
				"create",
				topicResourceName(context),
				topicOutputs(context, created),
				topicDiagnostics(context),
			);
		}
		if (
			retention !== undefined &&
			retention !== optionalString(observed, "messageRetentionDuration")
		) {
			const label = `pubsub update topic ${context.name}`;
			const updated = expectOk(
				await send("pubsub", context, {
					method: "PATCH",
					path: `${topicPath(context)}?updateMask=messageRetentionDuration`,
					json: {
						topic: {
							name: topicResourceName(context),
							messageRetentionDuration: retention,
						},
						updateMask: "messageRetentionDuration",
					},
				}),
				label,
			);
			return outcome(
				"update",
				topicResourceName(context),
				topicOutputs(context, updated),
				[`message retention set to ${retention}`, ...topicDiagnostics(context)],
			);
		}
		return outcome(
			settledAction(context),
			topicResourceName(context),
			topicOutputs(context, observed),
			topicDiagnostics(context),
		);
	},
	async remove(context) {
		const response = await send("pubsub", context, {
			method: "DELETE",
			path: topicPath(context),
		});
		if (isNotFound(response)) return;
		expectOk(response, `pubsub delete topic ${context.name}`);
	},
};

// ---------------------------------------------------------------------------
// Secret Manager — secretmanager.googleapis.com/v1/projects/{project}/secrets
// ---------------------------------------------------------------------------

function vaultResourceName(context: GcpResolverContext): string {
	return `projects/${context.projectId}/secrets/${context.name}`;
}

function vaultPath(context: GcpResolverContext): string {
	return `/v1/projects/${encodeURIComponent(context.projectId)}/secrets/${encodeURIComponent(context.name)}`;
}

function vaultCreatePath(context: GcpResolverContext): string {
	return `/v1/projects/${encodeURIComponent(context.projectId)}/secrets?secretId=${encodeURIComponent(context.name)}`;
}

/**
 * The replication policy, which Secret Manager requires at create and can never
 * change afterwards. Not defaulted: picking `automatic` for a caller who asked
 * for user-managed replicas would place their data in regions they did not ask
 * for, which is a residency decision this resolver may not take.
 */
function replicationPolicy(context: GcpResolverContext) {
	const mode = optionalString(context.desired, "replication");
	if (mode === undefined) {
		throw new ResolverError(
			"RESOLVER_PRODUCT_UNSUPPORTED",
			'gcp.secret-manager: the request names no replication policy — set desired.replication to "automatic" or "user-managed" (with desired.replicaLocations). Secret Manager requires it at creation and it can never be changed, so it is never chosen here',
		);
	}
	if (mode === "automatic") {
		return { mode, body: { automatic: {} } };
	}
	if (mode === "user-managed") {
		const locations = optionalStringArray(context.desired, "replicaLocations");
		if (locations === undefined || locations.length === 0) {
			throw new ResolverError(
				"RESOLVER_PRODUCT_UNSUPPORTED",
				'gcp.secret-manager: desired.replication is "user-managed" but desired.replicaLocations is empty — name at least one location, for example ["us-central1"]',
			);
		}
		return {
			mode,
			body: {
				userManaged: {
					replicas: locations.map((location) => ({ location })),
				},
			},
		};
	}
	throw new ResolverError(
		"RESOLVER_PRODUCT_UNSUPPORTED",
		`gcp.secret-manager: desired.replication ${JSON.stringify(mode)} is not a Secret Manager replication policy — expected "automatic" or "user-managed"`,
	);
}

/** What Google says the replication is, in the same vocabulary the request uses. */
function observedReplication(record: JsonObject): string | undefined {
	const replication = nestedRecord(record, "replication");
	if (isJsonObject(replication.automatic)) return "automatic";
	if (isJsonObject(replication.userManaged)) return "user-managed";
	return undefined;
}

function vaultOutputs(
	context: GcpResolverContext,
	record: JsonObject,
): JsonObject {
	const replication = observedReplication(record);
	return {
		resourceName: vaultResourceName(context),
		// Deliberately the *locator*, never a version payload: this resolver
		// creates the container and never reads or writes material into it.
		latestVersionRef: `${vaultResourceName(context)}/versions/latest`,
		...(replication !== undefined ? { replication } : undefined),
	};
}

function vaultDiagnostics(
	context: GcpResolverContext,
	record: JsonObject | undefined,
): readonly string[] {
	const diagnostics: string[] = [
		"this resolver creates the secret container only; no version is ever written, because a resolver that handled material would put it in the deploy record",
	];
	if (optionalNumber(context.desired, "rotationPeriodSeconds") !== undefined) {
		diagnostics.push(
			"rotationPeriodSeconds is declared but not applied: Secret Manager rotation additionally requires a nextRotationTime timestamp and a Pub/Sub topic, and this resolver reads no clock and invents no topic",
		);
	}
	const wanted = optionalString(context.desired, "replication");
	const actual = record === undefined ? undefined : observedReplication(record);
	if (wanted !== undefined && actual !== undefined && wanted !== actual) {
		diagnostics.push(
			`secret replication is ${actual} but the request asks for ${wanted}; replication is fixed at creation and this resolver never replaces a secret, so the drift is reported for a human`,
		);
	}
	return diagnostics;
}

async function readVault(
	context: GcpResolverContext,
): Promise<JsonObject | undefined> {
	const response = await send("secretManager", context, {
		method: "GET",
		path: vaultPath(context),
	});
	if (isNotFound(response)) return undefined;
	return expectOk(response, `secret manager read ${context.name}`);
}

const SECRET_MANAGER_SPEC: Omit<GcpResolverSpec, "productId"> = {
	async read(context) {
		const observed = await readVault(context);
		return observed === undefined
			? undefined
			: outcome(
					settledAction(context),
					vaultResourceName(context),
					vaultOutputs(context, observed),
					vaultDiagnostics(context, observed),
				);
	},
	async reconcile(context) {
		const observed = await readVault(context);
		if (observed !== undefined) {
			return outcome(
				settledAction(context),
				vaultResourceName(context),
				vaultOutputs(context, observed),
				vaultDiagnostics(context, observed),
			);
		}
		const label = `secret manager create ${context.name}`;
		const policy = replicationPolicy(context);
		const response = await send("secretManager", context, {
			method: "POST",
			path: vaultCreatePath(context),
			json: { replication: policy.body },
		});
		if (isAlreadyExists(response)) {
			const raced = await readVault(context);
			if (raced === undefined) {
				throw new ResolverError(
					"RESOLVER_PROVIDER_REJECTED",
					`${label}: Secret Manager reported the secret already exists but a re-read found nothing, so the resource cannot be identified and creating another would risk a duplicate`,
				);
			}
			return outcome(
				"adopt",
				vaultResourceName(context),
				vaultOutputs(context, raced),
				[
					"adopted a secret created concurrently: the create returned 409 ALREADY_EXISTS and the re-read found it",
					...vaultDiagnostics(context, raced),
				],
			);
		}
		const created = expectOk(response, label);
		return outcome(
			"create",
			vaultResourceName(context),
			vaultOutputs(context, created),
			vaultDiagnostics(context, created),
		);
	},
	async remove(context) {
		const response = await send("secretManager", context, {
			method: "DELETE",
			path: vaultPath(context),
		});
		if (isNotFound(response)) return;
		expectOk(response, `secret manager delete ${context.name}`);
	},
};

// ---------------------------------------------------------------------------
// Cloud Tasks queues — cloudtasks.googleapis.com/v2/projects/…/queues
// ---------------------------------------------------------------------------

function queueResourceName(
	context: GcpResolverContext,
	location: string,
): string {
	return `projects/${context.projectId}/locations/${location}/queues/${context.name}`;
}

function queueCollectionPath(
	context: GcpResolverContext,
	location: string,
): string {
	return `/v2/projects/${encodeURIComponent(context.projectId)}/locations/${encodeURIComponent(location)}/queues`;
}

function queuePath(context: GcpResolverContext, location: string): string {
	return `${queueCollectionPath(context, location)}/${encodeURIComponent(context.name)}`;
}

function queueRateLimits(context: GcpResolverContext): JsonObject | undefined {
	const perSecond = optionalNumber(context.desired, "maxDispatchesPerSecond");
	const concurrent = optionalInteger(
		context.desired,
		"maxConcurrentDispatches",
	);
	const limits = {
		...(perSecond !== undefined
			? { maxDispatchesPerSecond: perSecond }
			: undefined),
		...(concurrent !== undefined
			? { maxConcurrentDispatches: concurrent }
			: undefined),
	};
	return Object.keys(limits).length > 0 ? limits : undefined;
}

function queueRetryConfig(context: GcpResolverContext): JsonObject | undefined {
	const maxAttempts = optionalInteger(context.desired, "maxAttempts");
	return maxAttempts === undefined ? undefined : { maxAttempts };
}

function queueOutputs(
	context: GcpResolverContext,
	location: string,
	record: JsonObject,
): JsonObject {
	const state = optionalString(record, "state");
	return {
		resourceName: queueResourceName(context, location),
		queueId: context.name,
		location,
		...(state !== undefined ? { state } : undefined),
	};
}

/** Which mutable fields drifted, as `(updateMask, body)`; `undefined` if none. */
function queueDelta(
	context: GcpResolverContext,
	record: JsonObject,
): { readonly mask: readonly string[]; readonly body: JsonObject } | undefined {
	const mask: string[] = [];
	const body = {};
	const rateLimits = queueRateLimits(context);
	if (rateLimits !== undefined) {
		const observed = nestedRecord(record, "rateLimits");
		const drifted = Object.entries(rateLimits).filter(
			([key, value]) => observed[key] !== value,
		);
		if (drifted.length > 0) {
			Object.assign(body, { rateLimits });
			for (const [key] of drifted) mask.push(`rateLimits.${key}`);
		}
	}
	const retryConfig = queueRetryConfig(context);
	if (retryConfig !== undefined) {
		const observed = nestedRecord(record, "retryConfig");
		const drifted = Object.entries(retryConfig).filter(
			([key, value]) => observed[key] !== value,
		);
		if (drifted.length > 0) {
			Object.assign(body, { retryConfig });
			for (const [key] of drifted) mask.push(`retryConfig.${key}`);
		}
	}
	return mask.length > 0
		? { mask: mask.sort(compareStrings), body }
		: undefined;
}

async function readQueue(
	context: GcpResolverContext,
	location: string,
): Promise<JsonObject | undefined> {
	const response = await send("cloudTasks", context, {
		method: "GET",
		path: queuePath(context, location),
	});
	if (isNotFound(response)) return undefined;
	return expectOk(response, `cloud tasks read queue ${context.name}`);
}

const CLOUD_TASKS_SPEC: Omit<GcpResolverSpec, "productId"> = {
	async read(context) {
		const location = requiredLocation(context, GCP_CLOUD_TASKS_PRODUCT_ID);
		const observed = await readQueue(context, location);
		return observed === undefined
			? undefined
			: outcome(
					settledAction(context),
					queueResourceName(context, location),
					queueOutputs(context, location, observed),
					[],
				);
	},
	async reconcile(context) {
		const location = requiredLocation(context, GCP_CLOUD_TASKS_PRODUCT_ID);
		const observed = await readQueue(context, location);
		if (observed === undefined) {
			const label = `cloud tasks create queue ${context.name}`;
			const rateLimits = queueRateLimits(context);
			const retryConfig = queueRetryConfig(context);
			const response = await send("cloudTasks", context, {
				method: "POST",
				path: queueCollectionPath(context, location),
				json: {
					name: queueResourceName(context, location),
					...(rateLimits !== undefined ? { rateLimits } : undefined),
					...(retryConfig !== undefined ? { retryConfig } : undefined),
				},
			});
			if (isAlreadyExists(response)) {
				const raced = await readQueue(context, location);
				if (raced === undefined) {
					throw new ResolverError(
						"RESOLVER_PROVIDER_REJECTED",
						`${label}: Cloud Tasks reported the queue already exists but a re-read found nothing, so the resource cannot be identified and creating another would risk a duplicate`,
					);
				}
				return outcome(
					"adopt",
					queueResourceName(context, location),
					queueOutputs(context, location, raced),
					[
						"adopted a queue created concurrently: the create returned 409 ALREADY_EXISTS and the re-read found it",
					],
				);
			}
			const created = expectOk(response, label);
			return outcome(
				"create",
				queueResourceName(context, location),
				queueOutputs(context, location, created),
				[],
			);
		}
		const delta = queueDelta(context, observed);
		if (delta === undefined) {
			return outcome(
				settledAction(context),
				queueResourceName(context, location),
				queueOutputs(context, location, observed),
				[],
			);
		}
		const label = `cloud tasks update queue ${context.name}`;
		const updated = expectOk(
			await send("cloudTasks", context, {
				method: "PATCH",
				path: `${queuePath(context, location)}?updateMask=${encodeURIComponent(delta.mask.join(","))}`,
				json: delta.body,
			}),
			label,
		);
		return outcome(
			"update",
			queueResourceName(context, location),
			queueOutputs(context, location, updated),
			[`applied queue settings: ${delta.mask.join(", ")}`],
		);
	},
	async remove(context) {
		const location = requiredLocation(context, GCP_CLOUD_TASKS_PRODUCT_ID);
		const response = await send("cloudTasks", context, {
			method: "DELETE",
			path: queuePath(context, location),
		});
		if (isNotFound(response)) return;
		expectOk(response, `cloud tasks delete queue ${context.name}`);
	},
};

// ---------------------------------------------------------------------------
// Cloud SQL instances — sqladmin.googleapis.com/v1/projects/{project}/instances
// ---------------------------------------------------------------------------

function sqlInstancePath(context: GcpResolverContext): string {
	return `/v1/projects/${encodeURIComponent(context.projectId)}/instances/${encodeURIComponent(context.name)}`;
}

function sqlCollectionPath(context: GcpResolverContext): string {
	return `/v1/projects/${encodeURIComponent(context.projectId)}/instances`;
}

function sqlOperationPath(context: GcpResolverContext, name: string): string {
	return `/v1/projects/${encodeURIComponent(context.projectId)}/operations/${encodeURIComponent(name)}`;
}

function sqlResourceName(context: GcpResolverContext): string {
	return `projects/${context.projectId}/instances/${context.name}`;
}

/**
 * The engine enum Cloud SQL expects (`POSTGRES_15`, `MYSQL_8_0`). A bare "15"
 * is refused rather than composed into an enum: guessing the engine prefix is
 * how a Postgres request becomes a MySQL instance.
 */
function databaseVersion(
	context: GcpResolverContext,
	productId: string,
	example: string,
): string | undefined {
	const value = optionalString(context.desired, "engineVersion");
	if (value === undefined) return undefined;
	if (!DATABASE_VERSION_PATTERN.test(value)) {
		throw new ResolverError(
			"RESOLVER_PRODUCT_UNSUPPORTED",
			`${productId}: desired.engineVersion ${JSON.stringify(value)} is not a Cloud SQL database version enum — pass the full enum, for example ${JSON.stringify(example)}`,
		);
	}
	return value;
}

function sqlSettings(context: GcpResolverContext): JsonObject {
	const tier = optionalString(context.desired, "tier");
	const storageGb = optionalInteger(context.desired, "storageGb");
	const highAvailability = optionalBoolean(context.desired, "highAvailability");
	return {
		...(tier !== undefined ? { tier } : undefined),
		...(storageGb !== undefined ? { dataDiskSizeGb: storageGb } : undefined),
		...(highAvailability !== undefined
			? { availabilityType: highAvailability ? "REGIONAL" : "ZONAL" }
			: undefined),
	};
}

function sqlOutputs(
	context: GcpResolverContext,
	record: JsonObject,
): JsonObject {
	const settings = nestedRecord(record, "settings");
	const region = optionalString(record, "region");
	const version = optionalString(record, "databaseVersion");
	const state = optionalString(record, "state");
	const connectionName = optionalString(record, "connectionName");
	const tier = optionalString(settings, "tier");
	return {
		instanceId: context.name,
		resourceName: sqlResourceName(context),
		...(region !== undefined ? { region } : undefined),
		...(version !== undefined ? { databaseVersion: version } : undefined),
		...(state !== undefined ? { state } : undefined),
		...(connectionName !== undefined ? { connectionName } : undefined),
		...(tier !== undefined ? { tier } : undefined),
	};
}

function sqlImmutableDiagnostics(
	context: GcpResolverContext,
	record: JsonObject,
	productId: string,
	example: string,
): readonly string[] {
	const diagnostics: string[] = [];
	const wantedRegion =
		optionalString(context.desired, "region") ??
		optionalString(context.desired, "location");
	const actualRegion = optionalString(record, "region");
	if (
		wantedRegion !== undefined &&
		actualRegion !== undefined &&
		wantedRegion !== actualRegion
	) {
		diagnostics.push(
			`instance region is ${actualRegion} but the request asks for ${wantedRegion}; a Cloud SQL instance cannot move and this resolver never replaces one, so the drift is reported for a human rather than "fixed" by destroying the database`,
		);
	}
	const wantedVersion = databaseVersion(context, productId, example);
	const actualVersion = optionalString(record, "databaseVersion");
	if (
		wantedVersion !== undefined &&
		actualVersion !== undefined &&
		wantedVersion !== actualVersion
	) {
		diagnostics.push(
			`instance databaseVersion is ${actualVersion} but the request asks for ${wantedVersion}; a major-version change is a migration, not a field write, so it is reported rather than applied`,
		);
	}
	return diagnostics;
}

function sqlSettingsDelta(
	context: GcpResolverContext,
	record: JsonObject,
): JsonObject | undefined {
	const wanted = sqlSettings(context);
	const observed = nestedRecord(record, "settings");
	const delta = Object.fromEntries(
		Object.entries(wanted).filter(([key, value]) => observed[key] !== value),
	);
	return Object.keys(delta).length > 0 ? delta : undefined;
}

async function readSqlInstance(
	context: GcpResolverContext,
): Promise<JsonObject | undefined> {
	const response = await send("cloudSql", context, {
		method: "GET",
		path: sqlInstancePath(context),
	});
	if (isNotFound(response)) return undefined;
	return expectOk(response, `cloud sql read instance ${context.name}`);
}

/** Run one Cloud SQL mutation and chase its operation within the budget. */
async function runSqlOperation(
	context: GcpResolverContext,
	call: GcpCall,
	label: string,
): Promise<GcpOperation> {
	const accepted = parseOperation(
		expectOk(await send("cloudSql", context, call), label),
		label,
		SQL_OPERATION_NAME_PATTERN,
	);
	return awaitOperation(
		"cloudSql",
		context,
		accepted,
		(name) => sqlOperationPath(context, name),
		SQL_OPERATION_NAME_PATTERN,
		label,
	);
}

function cloudSqlSpec(
	productId: string,
	versionExample: string,
): Omit<GcpResolverSpec, "productId"> {
	return {
		async read(context) {
			const observed = await readSqlInstance(context);
			return observed === undefined
				? undefined
				: outcome(
						settledAction(context),
						sqlResourceName(context),
						sqlOutputs(context, observed),
						sqlImmutableDiagnostics(
							context,
							observed,
							productId,
							versionExample,
						),
					);
		},
		async reconcile(context) {
			const observed = await readSqlInstance(context);
			if (observed === undefined) {
				const label = `cloud sql create instance ${context.name}`;
				const region = requiredLocation(context, productId);
				const settings = sqlSettings(context);
				if (optionalString(settings, "tier") === undefined) {
					throw new ResolverError(
						"RESOLVER_PRODUCT_UNSUPPORTED",
						`${productId}: Cloud SQL requires settings.tier at creation — set desired.tier, for example "db-custom-1-3840". No machine size is chosen here, because a guessed tier is a guessed bill`,
					);
				}
				const version = databaseVersion(context, productId, versionExample);
				const operation = await runSqlOperation(
					context,
					{
						method: "POST",
						path: sqlCollectionPath(context),
						json: {
							name: context.name,
							region,
							...(version !== undefined
								? { databaseVersion: version }
								: undefined),
							settings,
						},
					},
					label,
				);
				if (!operation.done) {
					// Honest: the instance is not ready, so the outcome says so
					// instead of reporting a create that has not happened yet.
					return outcome(
						"create",
						sqlResourceName(context),
						{
							instanceId: context.name,
							resourceName: sqlResourceName(context),
							operationConfirmed: false,
						},
						[unconfirmedDiagnostic(context, label)],
					);
				}
				const created = await readSqlInstance(context);
				return outcome(
					"create",
					sqlResourceName(context),
					created === undefined
						? {
								instanceId: context.name,
								resourceName: sqlResourceName(context),
								operationConfirmed: true,
							}
						: { ...sqlOutputs(context, created), operationConfirmed: true },
					created === undefined
						? [
								`${label}: the operation completed but the instance read that follows it found nothing; the create is reported without provider outputs rather than with invented ones`,
							]
						: sqlImmutableDiagnostics(
								context,
								created,
								productId,
								versionExample,
							),
				);
			}
			const drift = sqlSettingsDelta(context, observed);
			const immutable = sqlImmutableDiagnostics(
				context,
				observed,
				productId,
				versionExample,
			);
			if (drift === undefined) {
				return outcome(
					settledAction(context),
					sqlResourceName(context),
					sqlOutputs(context, observed),
					immutable,
				);
			}
			const label = `cloud sql update instance ${context.name}`;
			const operation = await runSqlOperation(
				context,
				{
					method: "PATCH",
					path: sqlInstancePath(context),
					json: { name: context.name, settings: drift },
				},
				label,
			);
			const applied = `applied instance settings: ${Object.keys(drift).sort(compareStrings).join(", ")}`;
			if (!operation.done) {
				return outcome(
					"update",
					sqlResourceName(context),
					{ ...sqlOutputs(context, observed), operationConfirmed: false },
					[applied, unconfirmedDiagnostic(context, label), ...immutable],
				);
			}
			const updated = (await readSqlInstance(context)) ?? observed;
			return outcome(
				"update",
				sqlResourceName(context),
				{ ...sqlOutputs(context, updated), operationConfirmed: true },
				[applied, ...immutable],
			);
		},
		async remove(context) {
			const label = `cloud sql delete instance ${context.name}`;
			const response = await send("cloudSql", context, {
				method: "DELETE",
				path: sqlInstancePath(context),
			});
			if (isNotFound(response)) return;
			const accepted = parseOperation(
				expectOk(response, label),
				label,
				SQL_OPERATION_NAME_PATTERN,
			);
			const operation = await awaitOperation(
				"cloudSql",
				context,
				accepted,
				(name) => sqlOperationPath(context, name),
				SQL_OPERATION_NAME_PATTERN,
				label,
			);
			if (!operation.done) {
				// `delete()` reports success by returning, and there is no
				// diagnostics channel to qualify it — so an unconfirmed delete
				// raises. Re-running it is safe: a second delete of a removed
				// instance is a 404, which this path treats as success.
				throw new ResolverError(
					"RESOLVER_PROVIDER_REJECTED",
					`${label}: Google accepted the delete but the operation was still running after ${context.poll.attempts} poll(s). A delete reports success by returning, so an unconfirmed one is refused instead; re-run delete (a second delete of an already-removed instance succeeds) or raise the operationPoll budget`,
				);
			}
		},
	};
}

// ---------------------------------------------------------------------------
// Cloud Run services and jobs — run.googleapis.com/v2/projects/…
// ---------------------------------------------------------------------------

function runCollectionPath(
	context: GcpResolverContext,
	location: string,
	kind: "services" | "jobs",
): string {
	return `/v2/projects/${encodeURIComponent(context.projectId)}/locations/${encodeURIComponent(location)}/${kind}`;
}

function runResourcePath(
	context: GcpResolverContext,
	location: string,
	kind: "services" | "jobs",
): string {
	return `${runCollectionPath(context, location, kind)}/${encodeURIComponent(context.name)}`;
}

function runResourceName(
	context: GcpResolverContext,
	location: string,
	kind: "services" | "jobs",
): string {
	return `projects/${context.projectId}/locations/${location}/${kind}/${context.name}`;
}

/** Cloud Run operation names are full resource paths; `/v2/{name}` polls them. */
function runOperationPath(name: string): string {
	return `/v2/${name}`;
}

const RUN_INGRESS_BY_OPTION: Readonly<Record<string, string>> = Object.freeze({
	all: "INGRESS_TRAFFIC_ALL",
	internal: "INGRESS_TRAFFIC_INTERNAL_ONLY",
	"internal-and-cloud-load-balancing": "INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER",
});

function runIngress(context: GcpResolverContext): string | undefined {
	const value = optionalString(context.desired, "ingress");
	if (value === undefined) return undefined;
	const mapped = RUN_INGRESS_BY_OPTION[value];
	if (mapped === undefined) {
		throw new ResolverError(
			"RESOLVER_PRODUCT_UNSUPPORTED",
			`gcp.cloud-run: desired.ingress ${JSON.stringify(value)} is not one of ${Object.keys(RUN_INGRESS_BY_OPTION).sort(compareStrings).join(", ")}`,
		);
	}
	return mapped;
}

function requiredImage(context: GcpResolverContext, productId: string): string {
	const image = optionalString(context.desired, "image");
	if (image === undefined) {
		throw new ResolverError(
			"RESOLVER_PRODUCT_UNSUPPORTED",
			`${productId}: the request names no container image — set desired.image, for example "us-docker.pkg.dev/project/repo/app:sha256-…". Cloud Run has nothing to run without one, and an image is never guessed here`,
		);
	}
	return image;
}

function runContainer(context: GcpResolverContext, image: string): JsonObject {
	const cpu = optionalString(context.desired, "cpu");
	const memory = optionalString(context.desired, "memory");
	const limits = {
		...(cpu !== undefined ? { cpu } : undefined),
		...(memory !== undefined ? { memory } : undefined),
	};
	return {
		image,
		...(Object.keys(limits).length > 0 ? { resources: { limits } } : undefined),
	};
}

function serviceBody(context: GcpResolverContext, image: string): JsonObject {
	const minInstances = optionalInteger(context.desired, "minInstances");
	const maxInstances = optionalInteger(context.desired, "maxInstances");
	const concurrency = optionalInteger(context.desired, "concurrency");
	const ingress = runIngress(context);
	const scaling = {
		...(minInstances !== undefined
			? { minInstanceCount: minInstances }
			: undefined),
		...(maxInstances !== undefined
			? { maxInstanceCount: maxInstances }
			: undefined),
	};
	return {
		...(ingress !== undefined ? { ingress } : undefined),
		template: {
			...(optionalString(context.desired, "serviceAccount") !== undefined
				? { serviceAccount: context.desired.serviceAccount }
				: undefined),
			containers: [runContainer(context, image)],
			...(Object.keys(scaling).length > 0 ? { scaling } : undefined),
			...(concurrency !== undefined
				? { maxInstanceRequestConcurrency: concurrency }
				: undefined),
		},
	};
}

function jobBody(context: GcpResolverContext, image: string): JsonObject {
	const tasks = optionalInteger(context.desired, "tasks");
	const parallelism = optionalInteger(context.desired, "parallelism");
	const maxRetries = optionalInteger(context.desired, "maxRetries");
	const timeoutSeconds = optionalInteger(context.desired, "taskTimeoutSeconds");
	return {
		template: {
			...(tasks !== undefined ? { taskCount: tasks } : undefined),
			...(parallelism !== undefined ? { parallelism } : undefined),
			template: {
				...(optionalString(context.desired, "serviceAccount") !== undefined
					? { serviceAccount: context.desired.serviceAccount }
					: undefined),
				containers: [runContainer(context, image)],
				...(maxRetries !== undefined ? { maxRetries } : undefined),
				...(timeoutSeconds !== undefined
					? { timeout: `${timeoutSeconds}s` }
					: undefined),
			},
		},
	};
}

/** The image Cloud Run reports for the first container, if it reports one. */
function observedImage(
	record: JsonObject,
	path: readonly string[],
): string | undefined {
	let cursor: JsonObject = record;
	for (const key of path) cursor = nestedRecord(cursor, key);
	const containers = cursor.containers;
	if (!Array.isArray(containers)) return undefined;
	const first = containers[0];
	return isJsonObject(first) ? optionalString(first, "image") : undefined;
}

function serviceOutputs(
	context: GcpResolverContext,
	location: string,
	record: JsonObject,
): JsonObject {
	const uri = optionalString(record, "uri");
	const ingress = optionalString(record, "ingress");
	const image = observedImage(record, ["template"]);
	const lifecycle = runLifecycle(context, record, ["template"]);
	const result: JsonObject = {
		...lifecycle,
		resourceName: runResourceName(context, location, "services"),
		serviceId: context.name,
		location,
		...(uri !== undefined ? { uri } : undefined),
		...(ingress !== undefined ? { ingress } : undefined),
		...(image !== undefined ? { image } : undefined),
	};
	if (lifecycle.ready === true && uri) {
		try {
			const endpoint = new URL(uri);
			if (
				endpoint.protocol === "https:" &&
				endpoint.hostname.endsWith(".run.app") &&
				!endpoint.username &&
				!endpoint.password &&
				!endpoint.port &&
				!endpoint.search &&
				!endpoint.hash &&
				endpoint.pathname === "/"
			)
				Object.assign(result, { servingEndpoint: endpoint.href });
		} catch {
			/* An invalid native URL supplies no endpoint evidence. */
		}
	}
	return result;
}

function jobOutputs(
	context: GcpResolverContext,
	location: string,
	record: JsonObject,
): JsonObject {
	const image = observedImage(record, ["template", "template"]);
	return {
		...runLifecycle(context, record, ["template", "template"]),
		resourceName: runResourceName(context, location, "jobs"),
		jobId: context.name,
		location,
		...(image !== undefined ? { image } : undefined),
	};
}

/** Cloud Run serves the observed generation only after its terminal condition settles. */
function runLifecycle(
	context: GcpResolverContext,
	record: JsonObject,
	templatePath: readonly string[],
): JsonObject {
	const generation = runGeneration(record.generation);
	const current =
		generation !== undefined &&
		runGeneration(record.observedGeneration) === generation &&
		record.reconciling !== true;
	const condition = optionalString(
		nestedRecord(record, "terminalCondition"),
		"state",
	);
	const terminal =
		current &&
		(condition === "CONDITION_SUCCEEDED" || condition === "CONDITION_FAILED");
	const wanted = optionalString(context.desired, "image");
	const owner = runOwnership(context);
	const artifact = runArtifact(context);
	const ready =
		owner !== undefined &&
		artifact !== undefined &&
		nestedRecord(record, "annotations")["hobo.dev/artifact"] === artifact &&
		nestedRecord(record, "annotations")["hobo.dev/owner"] === owner &&
		terminal &&
		condition === "CONDITION_SUCCEEDED" &&
		wanted !== undefined &&
		observedImage(record, templatePath) === wanted &&
		runSettingsMatch(context, record, templatePath);
	const result: JsonObject = {
		ready,
		operationConfirmed: terminal,
		lifecycleStatus: ready ? "ready" : terminal ? "failed" : "pending",
	};
	const nativeArtifact = nestedRecord(record, "annotations")[
		"hobo.dev/artifact"
	];
	const contentDigest = observedImage(record, templatePath)?.match(
		/@(sha256:[a-f0-9]{64})$/u,
	)?.[1];
	if (contentDigest !== undefined)
		Object.assign(result, { artifactDigest: contentDigest });
	if (isJsonString(nativeArtifact))
		Object.assign(result, { artifactMarker: nativeArtifact });
	return result;
}

function runGeneration(value: JsonValue | undefined): string | undefined {
	if (isJsonNumber(value) && Number.isSafeInteger(value) && value > 0)
		return String(value);
	return isJsonString(value) &&
		/^[1-9][0-9]{0,18}$/u.test(value) &&
		BigInt(value) <= 9223372036854775807n
		? value
		: undefined;
}

function cpuQuantity(value: JsonValue | undefined): number | undefined {
	if (!isJsonString(value) || !/^[0-9]+(?:\.[0-9]+)?m?$/u.test(value))
		return undefined;
	const amount =
		Number(value.endsWith("m") ? value.slice(0, -1) : value) *
		(value.endsWith("m") ? 1 : 1000);
	return Number.isSafeInteger(amount) && amount > 0 ? amount : undefined;
}

function memoryQuantity(value: JsonValue | undefined): number | undefined {
	if (!isJsonString(value)) return undefined;
	const match = value.match(/^([0-9]+(?:\.[0-9]+)?)(Ki|Mi|Gi|Ti|K|M|G|T)?$/u);
	if (!match) return undefined;
	const units = new Map([
		["Ki", 1024],
		["Mi", 1024 ** 2],
		["Gi", 1024 ** 3],
		["Ti", 1024 ** 4],
		["K", 1000],
		["M", 1000 ** 2],
		["G", 1000 ** 3],
		["T", 1000 ** 4],
	]);
	const amount = Number(match[1]) * (units.get(match[2] ?? "") ?? 1);
	return Number.isSafeInteger(amount) && amount > 0 ? amount : undefined;
}

function validateRunSettings(
	context: GcpResolverContext,
	kind: "services" | "jobs",
): void {
	const serviceAccount = optionalString(context.desired, "serviceAccount");
	if (
		context.desired.serviceAccount !== undefined &&
		(!serviceAccount ||
			!/^[A-Za-z0-9._-]+@[a-z0-9-]+\.iam\.gserviceaccount\.com$/u.test(
				serviceAccount,
			))
	)
		throw new ResolverError(
			"RESOLVER_PRODUCT_UNSUPPORTED",
			"Cloud Run serviceAccount must name an explicit workload service account",
		);
	for (const [key, parse] of [
		["cpu", cpuQuantity],
		["memory", memoryQuantity],
	] as const)
		if (
			context.desired[key] !== undefined &&
			parse(context.desired[key]) === undefined
		)
			throw new ResolverError(
				"RESOLVER_PRODUCT_UNSUPPORTED",
				`Cloud Run ${key} must be an explicit positive bounded quantity`,
			);
	const names =
		kind === "services"
			? ["minInstances", "maxInstances", "concurrency"]
			: ["tasks", "parallelism", "maxRetries", "taskTimeoutSeconds"];
	if (runOwnership(context) !== undefined) {
		const allowed = new Set([
			"name",
			"image",
			"region",
			"location",
			"cpu",
			"memory",
			"ownershipRef",
			"artifactDigest",
			"serviceAccount",
			...(kind === "services" ? ["ingress", ...names] : names),
		]);
		for (const key of Object.keys(context.desired))
			if (!allowed.has(key))
				throw new ResolverError(
					"RESOLVER_PRODUCT_UNSUPPORTED",
					`Budgeted Cloud Run does not implement desired.${key}; unhandled bindings cannot be silently omitted`,
				);
		if (
			!["cpu", "memory", "serviceAccount", ...names].every(
				(key) => context.desired[key] !== undefined,
			)
		)
			throw new ResolverError(
				"RESOLVER_PRODUCT_UNSUPPORTED",
				"Budgeted Cloud Run requires explicit workload identity, CPU, memory and all replica/concurrency/retry bounds",
			);
		if (
			!/^[A-Za-z0-9][A-Za-z0-9._:/-]*@sha256:[a-f0-9]{64}$/u.test(
				optionalString(context.desired, "image") ?? "",
			)
		)
			throw new ResolverError(
				"RESOLVER_PRODUCT_UNSUPPORTED",
				"Budgeted Cloud Run requires an immutable sha256 container image",
			);
		if (
			context.desired.region !== undefined &&
			context.desired.location !== undefined &&
			context.desired.region !== context.desired.location
		)
			throw new ResolverError(
				"RESOLVER_PRODUCT_UNSUPPORTED",
				"Cloud Run region and location disagree",
			);
	}
	for (const key of names) {
		const value = optionalInteger(context.desired, key);
		if (
			context.desired[key] !== undefined &&
			(value === undefined ||
				value < (["minInstances", "maxRetries"].includes(key) ? 0 : 1))
		)
			throw new ResolverError(
				"RESOLVER_PRODUCT_UNSUPPORTED",
				`Cloud Run ${key} must be a bounded integer`,
			);
	}
	if (kind === "services") {
		const min = optionalInteger(context.desired, "minInstances"),
			max = optionalInteger(context.desired, "maxInstances");
		if (min !== undefined && max !== undefined && min > max)
			throw new ResolverError(
				"RESOLVER_PRODUCT_UNSUPPORTED",
				"Cloud Run minimum instances exceeds its bounded maximum",
			);
		if (
			runOwnership(context) !== undefined &&
			["cpu", "memory", ...names].some(
				(key) => context.desired[key] === undefined,
			)
		)
			throw new ResolverError(
				"RESOLVER_PRODUCT_UNSUPPORTED",
				"Budgeted Cloud Run requires explicit CPU, memory, minInstances, maxInstances and concurrency bounds",
			);
	}
}

function runSettingsMatch(
	context: GcpResolverContext,
	record: JsonObject,
	templatePath: readonly string[],
): boolean {
	let template = record;
	for (const key of templatePath) template = nestedRecord(template, key);
	const containers = template.containers;
	if (
		runOwnership(context) !== undefined &&
		(!isJsonArray(containers) || containers.length !== 1)
	)
		return false;
	const container =
		isJsonArray(containers) && isJsonObject(containers[0]) ? containers[0] : {};
	const limits = nestedRecord(nestedRecord(container, "resources"), "limits");
	if (
		context.desired.serviceAccount !== undefined &&
		context.desired.serviceAccount !== template.serviceAccount
	)
		return false;
	if (
		context.desired.cpu !== undefined &&
		cpuQuantity(context.desired.cpu) !== cpuQuantity(limits.cpu)
	)
		return false;
	if (
		context.desired.memory !== undefined &&
		memoryQuantity(context.desired.memory) !== memoryQuantity(limits.memory)
	)
		return false;
	if (templatePath.length === 1) {
		const scaling = nestedRecord(template, "scaling");
		if (
			context.desired.minInstances !== undefined &&
			context.desired.minInstances !== scaling.minInstanceCount
		)
			return false;
		if (
			context.desired.maxInstances !== undefined &&
			context.desired.maxInstances !== scaling.maxInstanceCount
		)
			return false;
		if (
			context.desired.concurrency !== undefined &&
			context.desired.concurrency !== template.maxInstanceRequestConcurrency
		)
			return false;
		const ingress = runIngress(context);
		if (ingress !== undefined && record.ingress !== ingress) return false;
	} else {
		const jobTemplate = nestedRecord(record, "template");
		if (
			context.desired.tasks !== undefined &&
			context.desired.tasks !== jobTemplate.taskCount
		)
			return false;
		if (
			context.desired.parallelism !== undefined &&
			context.desired.parallelism !== jobTemplate.parallelism
		)
			return false;
		if (
			context.desired.maxRetries !== undefined &&
			context.desired.maxRetries !== template.maxRetries
		)
			return false;
		if (
			context.desired.taskTimeoutSeconds !== undefined &&
			`${context.desired.taskTimeoutSeconds}s` !== template.timeout
		)
			return false;
	}
	return true;
}

function runOwnership(context: GcpResolverContext): string | undefined {
	const owner = optionalString(context.desired, "ownershipRef");
	if (
		context.desired.ownershipRef !== undefined &&
		(!owner || !/^sha256:[a-f0-9]{64}$/u.test(owner))
	)
		throw new ResolverError(
			"RESOLVER_PRODUCT_UNSUPPORTED",
			"Cloud Run ownershipRef must be a complete sha256 ownership identity",
		);
	return owner;
}

function runArtifact(context: GcpResolverContext): string | undefined {
	const artifact = optionalString(context.desired, "artifactDigest");
	if (
		(context.desired.artifactDigest !== undefined ||
			context.desired.ownershipRef !== undefined) &&
		(!artifact || !/^sha256:[a-f0-9]{64}$/u.test(artifact))
	)
		throw new ResolverError(
			"RESOLVER_PRODUCT_UNSUPPORTED",
			"Cloud Run artifactDigest must pin the complete approved sha256 artifact",
		);
	return artifact;
}

function assertRunScope(
	context: GcpResolverContext,
	location: string,
	kind: "services" | "jobs",
): string {
	const expected = runResourceName(context, location, kind);
	validateRunSettings(context, kind);
	runOwnership(context);
	runArtifact(context);
	if (
		context.knownPhysicalId !== undefined &&
		context.knownPhysicalId !== expected
	)
		throw new ResolverError(
			"RESOLVER_PRODUCT_UNSUPPORTED",
			"Cloud Run physical identity belongs to a different resource or scope",
		);
	return expected;
}

async function readRunResource(
	context: GcpResolverContext,
	location: string,
	kind: "services" | "jobs",
): Promise<JsonObject | undefined> {
	const expected = assertRunScope(context, location, kind);
	const response = await send("cloudRun", context, {
		method: "GET",
		path: runResourcePath(context, location, kind),
	});
	if (isNotFound(response)) return undefined;
	const observed = expectOk(response, `cloud run read ${kind} ${context.name}`);
	if (observed.name !== expected)
		throw new ResolverError(
			"RESOLVER_OUTPUT_UNPARSEABLE",
			"Cloud Run response identity differs from the requested scope",
		);
	const owner = runOwnership(context);
	if (
		owner !== undefined &&
		nestedRecord(observed, "annotations")["hobo.dev/owner"] !== owner
	)
		throw new ResolverError(
			"RESOLVER_PROVIDER_REJECTED",
			"Cloud Run resource has different or missing ownership metadata; implicit adoption is forbidden",
		);
	return observed;
}

/** Run one Cloud Run mutation and chase its operation within the budget. */
async function runRunOperation(
	context: GcpResolverContext,
	call: GcpCall,
	label: string,
): Promise<GcpOperation> {
	const accepted = parseOperation(
		expectOk(await send("cloudRun", context, call), label),
		label,
		RUN_OPERATION_NAME_PATTERN,
	);
	assertRunOperationScope(context, accepted);
	return awaitOperation(
		"cloudRun",
		context,
		accepted,
		runOperationPath,
		RUN_OPERATION_NAME_PATTERN,
		label,
	);
}

function assertRunOperationScope(
	context: GcpResolverContext,
	operation: GcpOperation,
): void {
	const location = requiredLocation(context, GCP_CLOUD_RUN_PRODUCT_ID);
	if (
		!operation.name.startsWith(
			`projects/${context.projectId}/locations/${location}/operations/`,
		)
	)
		throw new ResolverError(
			"RESOLVER_OUTPUT_UNPARSEABLE",
			"Cloud Run operation belongs to another project or location scope",
		);
}

/**
 * Services and jobs differ only in the collection name, the request body, and
 * which nested template holds the container — so they share one spec factory
 * rather than two near-copies that drift apart.
 */
function cloudRunSpec(
	productId: string,
	kind: "services" | "jobs",
	buildBody: (context: GcpResolverContext, image: string) => JsonObject,
	buildOutputs: (
		context: GcpResolverContext,
		location: string,
		record: JsonObject,
	) => JsonObject,
	templatePath: readonly string[],
): Omit<GcpResolverSpec, "productId"> {
	const idQuery = kind === "services" ? "serviceId" : "jobId";

	function drifted(
		context: GcpResolverContext,
		record: JsonObject,
	): readonly string[] {
		const changes: string[] = [];
		const image = optionalString(context.desired, "image");
		const artifact = runArtifact(context);
		if (!runSettingsMatch(context, record, templatePath))
			changes.push("capacity or ingress bounds");
		if (
			artifact !== undefined &&
			nestedRecord(record, "annotations")["hobo.dev/artifact"] !== artifact
		)
			changes.push("artifactDigest");
		if (image !== undefined && image !== observedImage(record, templatePath)) {
			changes.push("image");
		}
		if (kind === "services") {
			const ingress = runIngress(context);
			if (
				ingress !== undefined &&
				ingress !== optionalString(record, "ingress")
			) {
				changes.push("ingress");
			}
		}
		return changes.sort(compareStrings);
	}

	return {
		async read(context) {
			const location = requiredLocation(context, productId);
			const observed = await readRunResource(context, location, kind);
			return observed === undefined
				? undefined
				: outcome(
						settledAction(context),
						runResourceName(context, location, kind),
						buildOutputs(context, location, observed),
						[],
					);
		},
		async reconcile(context) {
			const location = requiredLocation(context, productId);
			const observed = await readRunResource(context, location, kind);
			const resourceName = runResourceName(context, location, kind);
			if (
				observed !== undefined &&
				runArtifact(context) !== undefined &&
				nestedRecord(observed, "annotations")["hobo.dev/artifact"] !==
					runArtifact(context)
			)
				throw new ResolverError(
					"RESOLVER_PRODUCT_UNSUPPORTED",
					"Cloud Run artifact differs; use a new immutable target name rather than overwriting an older deployment",
				);
			if (observed === undefined) {
				const label = `cloud run create ${kind} ${context.name}`;
				const image = requiredImage(context, productId);
				const body = buildBody(context, image);
				const owner = runOwnership(context);
				if (owner !== undefined)
					Object.assign(body, {
						annotations: {
							"hobo.dev/owner": owner,
							"hobo.dev/artifact": runArtifact(context),
						},
					});
				const operation = await runRunOperation(
					context,
					{
						method: "POST",
						path: `${runCollectionPath(context, location, kind)}?${idQuery}=${encodeURIComponent(context.name)}`,
						json: body,
					},
					label,
				);
				if (!operation.done) {
					return outcome(
						"create",
						resourceName,
						{
							resourceName,
							location,
							operationConfirmed: false,
							operationName: operation.name,
							ready: false,
						},
						[unconfirmedDiagnostic(context, label)],
					);
				}
				const created = await readRunResource(context, location, kind);
				return outcome(
					"create",
					resourceName,
					created === undefined
						? {
								resourceName,
								location,
								operationConfirmed: false,
								ready: false,
							}
						: {
								...buildOutputs(context, location, created),
								operationConfirmed: true,
							},
					created === undefined
						? [
								`${label}: the operation completed but the read that follows it found nothing; the create is reported without provider outputs rather than with invented ones`,
							]
						: [],
				);
			}
			const changes = drifted(context, observed);
			if (changes.length === 0) {
				return outcome(
					settledAction(context),
					resourceName,
					buildOutputs(context, location, observed),
					[],
				);
			}
			const label = `cloud run update ${kind} ${context.name}`;
			// A Cloud Run PATCH carries the whole template, so an update that
			// changes only ingress still needs an image: the observed one, when
			// the request does not name a new one.
			const image =
				optionalString(context.desired, "image") ??
				observedImage(observed, templatePath);
			if (image === undefined) {
				throw new ResolverError(
					"RESOLVER_OUTPUT_UNPARSEABLE",
					`${label}: neither the request nor the observed ${kind === "services" ? "service" : "job"} names a container image, so the update body cannot be composed without inventing one`,
				);
			}
			const operation = await runRunOperation(
				context,
				{
					method: "PATCH",
					path: `${runResourcePath(context, location, kind)}?updateMask=${kind === "services" ? "template,ingress,annotations" : "template,annotations"}`,
					json: runUpdateBody(context, observed, buildBody(context, image)),
				},
				label,
			);
			const applied = `applied ${kind === "services" ? "service" : "job"} settings: ${changes.join(", ")}`;
			if (!operation.done) {
				return outcome(
					"update",
					resourceName,
					{
						...buildOutputs(context, location, observed),
						operationConfirmed: false,
						operationName: operation.name,
					},
					[applied, unconfirmedDiagnostic(context, label)],
				);
			}
			const updated = await readRunResource(context, location, kind);
			return outcome(
				"update",
				resourceName,
				{
					...(updated === undefined
						? {
								resourceName,
								location,
								operationConfirmed: false,
								ready: false,
							}
						: buildOutputs(context, location, updated)),
					operationConfirmed: updated !== undefined,
				},
				updated === undefined
					? [
							applied,
							"updated resource is absent from the final read; update is not confirmed",
						]
					: [applied],
			);
		},
		async remove(context) {
			const location = requiredLocation(context, productId);
			assertRunScope(context, location, kind);
			const existing = await readRunResource(context, location, kind);
			if (existing === undefined) return;
			if (
				runArtifact(context) !== undefined &&
				nestedRecord(existing, "annotations")["hobo.dev/artifact"] !==
					runArtifact(context)
			)
				throw new ResolverError(
					"RESOLVER_PROVIDER_REJECTED",
					"Cloud Run retirement artifact no longer matches the approved source",
				);
			const label = `cloud run delete ${kind} ${context.name}`;
			const response = await send("cloudRun", context, {
				method: "DELETE",
				path: runResourcePath(context, location, kind),
			});
			if (isNotFound(response)) return;
			const accepted = parseOperation(
				expectOk(response, label),
				label,
				RUN_OPERATION_NAME_PATTERN,
			);
			assertRunOperationScope(context, accepted);
			const operation = await awaitOperation(
				"cloudRun",
				context,
				accepted,
				runOperationPath,
				RUN_OPERATION_NAME_PATTERN,
				label,
			);
			if (!operation.done) {
				throw new ResolverError(
					"RESOLVER_PROVIDER_REJECTED",
					`${label}: Google accepted the delete but the operation was still running after ${context.poll.attempts} poll(s). A delete reports success by returning, so an unconfirmed one is refused instead; re-run delete (a second delete of an already-removed resource succeeds) or raise the operationPoll budget`,
				);
			}
			if ((await readRunResource(context, location, kind)) !== undefined)
				throw new ResolverError(
					"RESOLVER_PROVIDER_REJECTED",
					`${label}: resource still exists after terminal deletion; absence is not confirmed`,
				);
		},
	};
}

function runUpdateBody(
	context: GcpResolverContext,
	observed: JsonObject,
	body: JsonObject,
): JsonObject {
	const owner = runOwnership(context);
	if (owner !== undefined) {
		const etag = optionalString(observed, "etag");
		if (!etag)
			throw new ResolverError(
				"RESOLVER_OUTPUT_UNPARSEABLE",
				"Cloud Run update needs an observed etag fence",
			);
		Object.assign(body, {
			etag,
			annotations: {
				...nestedRecord(observed, "annotations"),
				"hobo.dev/owner": owner,
				"hobo.dev/artifact": runArtifact(context),
			},
		});
	}
	return body;
}

// ---------------------------------------------------------------------------
// Memorystore for Redis — redis.googleapis.com/v1/projects/…
// ---------------------------------------------------------------------------

function redisCollectionPath(
	context: GcpResolverContext,
	location: string,
): string {
	return `/v1/projects/${encodeURIComponent(context.projectId)}/locations/${encodeURIComponent(location)}/instances`;
}

function redisInstancePath(
	context: GcpResolverContext,
	location: string,
): string {
	return `${redisCollectionPath(context, location)}/${encodeURIComponent(context.name)}`;
}

function redisResourceName(
	context: GcpResolverContext,
	location: string,
): string {
	return `projects/${context.projectId}/locations/${location}/instances/${context.name}`;
}

/** Memorystore operation names are full resource paths; `/v1/{name}` polls them. */
function redisOperationPath(name: string): string {
	return `/v1/${name}`;
}

/**
 * The binding's tier vocabulary to Google's enum. Explicit rather than
 * upper-cased, because `standard-ha` does not upper-case to `STANDARD_HA` and a
 * silently mistranslated tier is a silently different availability guarantee.
 */
const REDIS_TIER_BY_BINDING: Readonly<Record<string, string>> = Object.freeze({
	basic: "BASIC",
	"standard-ha": "STANDARD_HA",
});

function redisTier(context: GcpResolverContext): string | undefined {
	const value = optionalString(context.desired, "tier");
	if (value === undefined) return undefined;
	const mapped = REDIS_TIER_BY_BINDING[value];
	if (mapped === undefined) {
		throw new ResolverError(
			"RESOLVER_PRODUCT_UNSUPPORTED",
			`${GCP_MEMORYSTORE_REDIS_PRODUCT_ID}: desired.tier ${JSON.stringify(value)} is not one of ${Object.keys(REDIS_TIER_BY_BINDING).sort(compareStrings).join(", ")}`,
		);
	}
	return mapped;
}

/** Google's engine enum, e.g. `REDIS_7_0`. Never composed from a bare "7". */
function redisVersion(context: GcpResolverContext): string | undefined {
	const value = optionalString(context.desired, "engineVersion");
	if (value === undefined) return undefined;
	if (!DATABASE_VERSION_PATTERN.test(value)) {
		throw new ResolverError(
			"RESOLVER_PRODUCT_UNSUPPORTED",
			`${GCP_MEMORYSTORE_REDIS_PRODUCT_ID}: desired.engineVersion ${JSON.stringify(value)} is not a Memorystore redisVersion enum — pass the full enum, for example "REDIS_7_0"`,
		);
	}
	return value;
}

/**
 * The size, which Google requires and this resolver will not choose.
 *
 * A guessed `memorySizeGb` is a guessed bill *and* a guessed capacity ceiling,
 * and the smallest legal value differs by tier (1 GB on Basic, 5 GB on
 * Standard HA), so there is no single "harmless" default to fall back to.
 */
function redisMemoryGb(context: GcpResolverContext): number {
	const value = optionalInteger(context.desired, "memoryGb");
	if (value === undefined || value < 1) {
		throw new ResolverError(
			"RESOLVER_PRODUCT_UNSUPPORTED",
			`${GCP_MEMORYSTORE_REDIS_PRODUCT_ID}: Memorystore requires memorySizeGb at creation — set desired.memoryGb to a whole number of gigabytes, for example 1. No size is chosen here, because a guessed size is a guessed bill and the tier's own minimum differs (1 GB Basic, 5 GB Standard HA)`,
		);
	}
	return value;
}

function redisOutputs(
	context: GcpResolverContext,
	location: string,
	record: JsonObject,
): JsonObject {
	const host = optionalString(record, "host");
	const port = optionalInteger(record, "port");
	const state = optionalString(record, "state");
	const tier = optionalString(record, "tier");
	const memorySizeGb = optionalInteger(record, "memorySizeGb");
	const version = optionalString(record, "redisVersion");
	return {
		instanceId: context.name,
		resourceName: redisResourceName(context, location),
		...(host !== undefined ? { host } : undefined),
		...(port !== undefined ? { port } : undefined),
		...(state !== undefined ? { state } : undefined),
		...(tier !== undefined ? { tier } : undefined),
		...(memorySizeGb !== undefined ? { memorySizeGb } : undefined),
		...(version !== undefined ? { redisVersion: version } : undefined),
	};
}

/**
 * The fields Google fixes at creation, reported rather than corrected.
 *
 * Memorystore's documented `updateMask` covers `displayName`, `labels`,
 * `memorySizeGb`, `redisConfig` and `replicaCount` — and nothing else. `tier`
 * and `redisVersion` are therefore *not* patchable: the tier is fixed for the
 * instance's life, and a version move is the separate `upgrade` method, which
 * restarts the instance and is not something to trigger from a drift check.
 */
function redisImmutableDiagnostics(
	context: GcpResolverContext,
	location: string,
	record: JsonObject,
): readonly string[] {
	const diagnostics: string[] = [];
	const wantedTier = redisTier(context);
	const actualTier = optionalString(record, "tier");
	if (
		wantedTier !== undefined &&
		actualTier !== undefined &&
		wantedTier !== actualTier
	) {
		diagnostics.push(
			`instance tier is ${actualTier} but the request asks for ${wantedTier}; Memorystore fixes the tier at creation and this resolver never replaces an instance, so the drift is reported for a human rather than "fixed" by destroying the cache`,
		);
	}
	const wantedVersion = redisVersion(context);
	const actualVersion = optionalString(record, "redisVersion");
	if (
		wantedVersion !== undefined &&
		actualVersion !== undefined &&
		wantedVersion !== actualVersion
	) {
		diagnostics.push(
			`instance redisVersion is ${actualVersion} but the request asks for ${wantedVersion}; a version move is Memorystore's separate upgrade method and restarts the instance, so it is reported rather than applied`,
		);
	}
	const actualLocation = optionalString(record, "locationId");
	if (actualLocation !== undefined && !actualLocation.startsWith(location)) {
		diagnostics.push(
			`instance locationId is ${actualLocation} but the request places it in ${location}; a Memorystore instance cannot move and this resolver never replaces one, so the drift is reported for a human`,
		);
	}
	return diagnostics;
}

async function readRedisInstance(
	context: GcpResolverContext,
	location: string,
): Promise<JsonObject | undefined> {
	const response = await send("memorystore", context, {
		method: "GET",
		path: redisInstancePath(context, location),
	});
	if (isNotFound(response)) return undefined;
	return expectOk(response, `memorystore read instance ${context.name}`);
}

/** Run one Memorystore mutation and chase its operation within the budget. */
async function runRedisOperation(
	context: GcpResolverContext,
	call: GcpCall,
	label: string,
): Promise<GcpOperation> {
	const accepted = parseOperation(
		expectOk(await send("memorystore", context, call), label),
		label,
		REDIS_OPERATION_NAME_PATTERN,
	);
	return awaitOperation(
		"memorystore",
		context,
		accepted,
		redisOperationPath,
		REDIS_OPERATION_NAME_PATTERN,
		label,
	);
}

const MEMORYSTORE_REDIS_SPEC: Omit<GcpResolverSpec, "productId"> = {
	async read(context) {
		const location = requiredLocation(
			context,
			GCP_MEMORYSTORE_REDIS_PRODUCT_ID,
		);
		const observed = await readRedisInstance(context, location);
		return observed === undefined
			? undefined
			: outcome(
					settledAction(context),
					redisResourceName(context, location),
					redisOutputs(context, location, observed),
					redisImmutableDiagnostics(context, location, observed),
				);
	},
	async reconcile(context) {
		const location = requiredLocation(
			context,
			GCP_MEMORYSTORE_REDIS_PRODUCT_ID,
		);
		const resourceName = redisResourceName(context, location);
		const observed = await readRedisInstance(context, location);

		if (observed === undefined) {
			const label = `memorystore create instance ${context.name}`;
			const tier = redisTier(context);
			const version = redisVersion(context);
			// `instanceId` is a query parameter, not a body field: Memorystore's
			// create is `POST …/instances?instanceId={id}`, and the id is what makes
			// the following GET address the same instance.
			const operation = await runRedisOperation(
				context,
				{
					method: "POST",
					path: `${redisCollectionPath(context, location)}?instanceId=${encodeURIComponent(context.name)}`,
					json: {
						memorySizeGb: redisMemoryGb(context),
						...(tier !== undefined ? { tier } : undefined),
						...(version !== undefined ? { redisVersion: version } : undefined),
					},
				},
				label,
			);
			const tierDiagnostic =
				tier === undefined
					? [
							`tier was not declared, so Memorystore applied its own default (BASIC, a single node with no replica and no failover). Declare desired.tier to choose deliberately — the tier is fixed at creation and this resolver never replaces an instance`,
						]
					: [];
			if (!operation.done) {
				// Honest: the instance is not serving, so the outcome says so
				// instead of reporting a create that has not finished.
				return outcome(
					"create",
					resourceName,
					{
						instanceId: context.name,
						resourceName,
						operationConfirmed: false,
					},
					[...tierDiagnostic, unconfirmedDiagnostic(context, label)],
				);
			}
			const created = await readRedisInstance(context, location);
			return outcome(
				"create",
				resourceName,
				created === undefined
					? { instanceId: context.name, resourceName, operationConfirmed: true }
					: {
							...redisOutputs(context, location, created),
							operationConfirmed: true,
						},
				created === undefined
					? [
							...tierDiagnostic,
							`${label}: the operation completed but the instance read that follows it found nothing; the create is reported without provider outputs rather than with invented ones`,
						]
					: [
							...tierDiagnostic,
							...redisImmutableDiagnostics(context, location, created),
						],
			);
		}

		const immutable = redisImmutableDiagnostics(context, location, observed);
		// `memorySizeGb` is the one field the binding names that Memorystore's
		// updateMask accepts. Everything else the binding carries is either fixed
		// at creation or a different API method, and is reported above.
		const wantedMemory = optionalInteger(context.desired, "memoryGb");
		if (
			wantedMemory === undefined ||
			wantedMemory === optionalInteger(observed, "memorySizeGb")
		) {
			return outcome(
				settledAction(context),
				resourceName,
				redisOutputs(context, location, observed),
				immutable,
			);
		}
		const label = `memorystore update instance ${context.name}`;
		const operation = await runRedisOperation(
			context,
			{
				method: "PATCH",
				path: `${redisInstancePath(context, location)}?updateMask=memorySizeGb`,
				json: { memorySizeGb: wantedMemory },
			},
			label,
		);
		const applied = `applied instance settings: memorySizeGb`;
		if (!operation.done) {
			return outcome(
				"update",
				resourceName,
				{
					...redisOutputs(context, location, observed),
					operationConfirmed: false,
				},
				[applied, unconfirmedDiagnostic(context, label), ...immutable],
			);
		}
		const updated = (await readRedisInstance(context, location)) ?? observed;
		return outcome(
			"update",
			resourceName,
			{ ...redisOutputs(context, location, updated), operationConfirmed: true },
			[applied, ...immutable],
		);
	},
	async remove(context) {
		const location = requiredLocation(
			context,
			GCP_MEMORYSTORE_REDIS_PRODUCT_ID,
		);
		const label = `memorystore delete instance ${context.name}`;
		const response = await send("memorystore", context, {
			method: "DELETE",
			path: redisInstancePath(context, location),
		});
		if (isNotFound(response)) return;
		const accepted = parseOperation(
			expectOk(response, label),
			label,
			REDIS_OPERATION_NAME_PATTERN,
		);
		const operation = await awaitOperation(
			"memorystore",
			context,
			accepted,
			redisOperationPath,
			REDIS_OPERATION_NAME_PATTERN,
			label,
		);
		if (!operation.done) {
			// `delete()` reports success by returning, and there is no diagnostics
			// channel to qualify it — so an unconfirmed delete raises. Re-running is
			// safe: a second delete of a removed instance is a 404, which is success.
			throw new ResolverError(
				"RESOLVER_PROVIDER_REJECTED",
				`${label}: Google accepted the delete but the operation was still running after ${context.poll.attempts} poll(s). A delete reports success by returning, so an unconfirmed one is refused instead; re-run delete (a second delete of an already-removed instance succeeds) or raise the operationPoll budget`,
			);
		}
	},
};

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/**
 * Every GCP resolver, id-sorted so the list is a function of the code rather
 * than of construction order. The five catalogued products that are absent are
 * named in {@link GCP_UNRESOLVED_PRODUCT_IDS}, with the reason.
 */
export function gcpResolvers(
	options: GcpResolverOptions,
): readonly ResourceResolver[] {
	const specs: readonly GcpResolverSpec[] = [
		{
			productId: GCP_CLOUD_RUN_PRODUCT_ID,
			...cloudRunSpec(
				GCP_CLOUD_RUN_PRODUCT_ID,
				"services",
				serviceBody,
				serviceOutputs,
				["template"],
			),
		},
		{
			productId: GCP_CLOUD_RUN_JOB_PRODUCT_ID,
			...cloudRunSpec(
				GCP_CLOUD_RUN_JOB_PRODUCT_ID,
				"jobs",
				jobBody,
				jobOutputs,
				["template", "template"],
			),
		},
		{
			productId: GCP_CLOUD_SQL_POSTGRES_PRODUCT_ID,
			...cloudSqlSpec(GCP_CLOUD_SQL_POSTGRES_PRODUCT_ID, "POSTGRES_15"),
		},
		{
			productId: GCP_CLOUD_SQL_MYSQL_PRODUCT_ID,
			...cloudSqlSpec(GCP_CLOUD_SQL_MYSQL_PRODUCT_ID, "MYSQL_8_0"),
		},
		{ productId: GCP_CLOUD_STORAGE_PRODUCT_ID, ...CLOUD_STORAGE_SPEC },
		{ productId: GCP_CLOUD_TASKS_PRODUCT_ID, ...CLOUD_TASKS_SPEC },
		{
			productId: GCP_MEMORYSTORE_REDIS_PRODUCT_ID,
			...MEMORYSTORE_REDIS_SPEC,
		},
		{ productId: GCP_PUBSUB_TOPIC_PRODUCT_ID, ...PUBSUB_TOPIC_SPEC },
		{ productId: GCP_SECRET_MANAGER_PRODUCT_ID, ...SECRET_MANAGER_SPEC },
	];
	return Object.freeze(
		[...specs]
			.sort((left, right) => compareStrings(left.productId, right.productId))
			.map((spec) => createResolver(spec, options)),
	);
}

/** The same resolvers, behind core's product-id lookup. */
export function gcpResolverRegistry(options: GcpResolverOptions): {
	get(productId: string): ResourceResolver | undefined;
	list(): readonly ResourceResolver[];
} {
	return createResolverRegistry(gcpResolvers(options));
}
