/**
 * Direct Azure Resource Manager resource resolvers — the default deployment
 * path for the Azure Yard.
 *
 * Why this module exists: `./default-yard.ts` publishes an allocatable Azure
 * catalog, but a Yard that nothing can deploy against is a catalog with a
 * closed door behind it. These resolvers open the door for the products whose
 * ARM surface is genuinely convergent: a `ResourceResolver` talks to
 * `https://management.azure.com` over an injected, guarded transport and
 * reconciles one product at a time. There is no IaC engine, no state file, and
 * no plan/apply round trip in between.
 *
 * The property that makes that safe is convergence. Every `reconcile()` here is
 * read-or-create: it `GET`s the *deterministically named* ARM resource id
 * before it writes anything, `PUT`s only when the resource is absent, and then
 * applies only the mutable deltas. Running it twice produces the same
 * `physicalId` and exactly one resource, which is what makes a crashed
 * half-apply safe to re-run instead of something an operator reconciles by
 * hand. `delete()` treats "already gone" as success for the same reason.
 *
 * ARM helps here in a way most REST APIs do not: `PUT` on a resource id is
 * declarative and idempotent. That is *only* worth anything because the name is
 * deterministic — `desired.name` falling back to `ref.logicalId`, never a
 * generated one — so the second `PUT` addresses the same id as the first. Where
 * this module leans on idempotent-PUT it is leaning on that pairing, not on
 * PUT alone.
 *
 * Two ARM specifics shape almost every line below:
 *
 *  1. **`api-version` is mandatory and load-bearing.** ARM refuses a call
 *     without one and silently serializes a *different* resource model for the
 *     wrong one — which is how a declared field quietly stops being applied.
 *     So every version is pinned as a named constant per resource type, with
 *     the reason on the declaration, and `azureArmUrl()` takes it as a required
 *     argument rather than defaulting one.
 *  2. **Most ARM writes are long-running operations.** A `PUT` answers `201`
 *     or `202` with an `Azure-AsyncOperation` or `Location` header, or a `200`
 *     whose body says `provisioningState: "Creating"`, and the resource does
 *     not exist yet. This module never reports such a response as a finished
 *     create. It follows the operation to a terminal state through the same
 *     injected transport, bounded by an injected poll budget (no clock, no
 *     unbounded loop); and when the budget runs out with the operation still
 *     running, the outcome says so in `diagnostics` — accepted, not confirmed —
 *     rather than reading as done.
 *
 * Credentials are locators, never material. A resolver is constructed with an
 * injected `resolveCredential(ref)`; `ResolveRequest.credentialRef` must look
 * like a reference (`env://AZURE_ARM_ACCESS_TOKEN`, `secret://…`) and a value
 * that looks like the bearer token itself is refused, because a raw token in a
 * request record is a token in the event log. The resolved token appears in
 * exactly one place — the `authorization` request header — and never in an
 * outcome, a diagnostic, or a message.
 *
 * Nothing here reaches for a global `fetch`, and nothing reads a clock, an
 * environment variable, or a random source: request bodies are a pure function
 * of the request.
 *
 * HONEST SCOPE (also in the README):
 *   - These resolvers are exercised in tests against an *injected fake*
 *     transport. Nothing in this package proves a live deploy: that
 *     additionally needs real credentials, real network egress, a real
 *     subscription, and a real resource group, none of which a unit test
 *     supplies.
 *   - The pinned `api-version` values were written from Azure's published REST
 *     documentation. They have not been verified against the running service
 *     by this package, and a version that has been retired would fail at the
 *     first call rather than silently.
 *   - Coverage is a slice of each product's ARM surface — enough to allocate,
 *     observe, converge, and remove the resource — and explicitly not the whole
 *     surface. Products whose ARM surface is not convergent under this contract
 *     ship *no* resolver and are named in {@link AZURE_UNRESOLVED_PRODUCT_IDS}.
 *   - `"replace"` is never emitted. Replacing a storage container, a database
 *     account, or a vault destroys data, so drift on an immutable field is
 *     reported as a diagnostic for a human and never silently "fixed".
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
import { AZURE_PROVIDER_TARGET } from "./options.js";
import {
	aks,
	apiManagement,
	appService,
	blobStorage,
	containerApps,
	cosmosDb,
	cosmosTable,
	functions,
	keyVault,
	postgresFlexible,
	redisCache,
	serviceBusQueue,
	serviceBusTopic,
	sqlDatabase,
	staticWebApps,
	storageQueue,
} from "./slots.js";
import {
	AZURE_ARM_BASE_PATH,
	AZURE_MAX_RESPONSE_BYTES,
	AZURE_MAX_TIMEOUT_MS,
	azureArmUrl,
	azureOperationUrl,
	guardedAzureTransport,
} from "./transport.js";

// ---------------------------------------------------------------------------
// Pinned api-versions
// ---------------------------------------------------------------------------

// public-contract: pinned ARM api-version for Microsoft.Storage; the 2023-05-01 stable release serializes storageAccounts, blobServices/containers and queueServices/queues with the fields this resolver reads and writes, and pinning it is what stops a declared field from quietly ceasing to apply when ARM's default model moves on.
export const AZURE_STORAGE_API_VERSION = "2023-05-01";

// public-contract: pinned ARM api-version for Microsoft.ServiceBus; the 2021-11-01 stable release is the one that documents queue and topic sub-resources with requiresSession, lockDuration, requiresDuplicateDetection and enablePartitioning, which are exactly the properties this resolver converges and reports drift on.
export const AZURE_SERVICE_BUS_API_VERSION = "2021-11-01";

// public-contract: pinned ARM api-version for Microsoft.KeyVault; the 2023-07-01 stable release serializes vaults with enableRbacAuthorization and enablePurgeProtection, the two mutable properties this resolver applies, and with the provisioningState this resolver polls for.
export const AZURE_KEY_VAULT_API_VERSION = "2023-07-01";

// public-contract: pinned ARM api-version for Microsoft.DocumentDB; the 2024-05-15 stable release serializes databaseAccounts with consistencyPolicy, capabilities and enableMultipleWriteLocations, the properties this resolver either applies or reports as immutable drift.
export const AZURE_COSMOS_API_VERSION = "2024-05-15";

// public-contract: pinned ARM api-version for Microsoft.Cache; the 2023-08-01 stable release serializes redis resources with sku (name/family/capacity), shardCount and the hostName/sslPort this resolver reports, and pinning it is what stops a declared sku field from quietly ceasing to apply.
export const AZURE_CACHE_API_VERSION = "2023-08-01";

// public-contract: pinned ARM api-version for Microsoft.App; the 2024-03-01 stable release serializes containerApps with managedEnvironmentId, configuration.ingress and template.containers/scale, which is the whole shape this resolver owns.
export const AZURE_CONTAINER_APPS_API_VERSION = "2024-03-01";

// ---------------------------------------------------------------------------
// Product ids
// ---------------------------------------------------------------------------

/**
 * Product ids are read off the slot factories rather than retyped, so the
 * registry cannot silently stop covering a product the Yard still offers, and
 * the unresolved declaration cannot name an id the catalog does not emit.
 */
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

export const AZURE_BLOB_STORAGE_PRODUCT_ID = productIdOf(
	blobStorage(),
	"blobStorage",
);
export const AZURE_STORAGE_QUEUE_PRODUCT_ID = productIdOf(
	storageQueue(),
	"storageQueue",
);
export const AZURE_SERVICE_BUS_QUEUE_PRODUCT_ID = productIdOf(
	serviceBusQueue(),
	"serviceBusQueue",
);
export const AZURE_SERVICE_BUS_TOPIC_PRODUCT_ID = productIdOf(
	serviceBusTopic(),
	"serviceBusTopic",
);
export const AZURE_KEY_VAULT_PRODUCT_ID = productIdOf(keyVault(), "keyVault");
export const AZURE_COSMOS_DB_PRODUCT_ID = productIdOf(cosmosDb(), "cosmosDb");
export const AZURE_CONTAINER_APPS_PRODUCT_ID = productIdOf(
	containerApps(),
	"containerApps",
);
export const AZURE_COSMOS_TABLE_PRODUCT_ID = productIdOf(
	cosmosTable(),
	"cosmosTable",
);
export const AZURE_REDIS_CACHE_PRODUCT_ID = productIdOf(
	redisCache(),
	"redisCache",
);

/** Every product this module resolves, id-sorted for a deterministic registry. */
export const AZURE_RESOLVED_PRODUCT_IDS = Object.freeze(
	[
		AZURE_BLOB_STORAGE_PRODUCT_ID,
		AZURE_CONTAINER_APPS_PRODUCT_ID,
		AZURE_COSMOS_DB_PRODUCT_ID,
		AZURE_COSMOS_TABLE_PRODUCT_ID,
		AZURE_KEY_VAULT_PRODUCT_ID,
		AZURE_REDIS_CACHE_PRODUCT_ID,
		AZURE_SERVICE_BUS_QUEUE_PRODUCT_ID,
		AZURE_SERVICE_BUS_TOPIC_PRODUCT_ID,
		AZURE_STORAGE_QUEUE_PRODUCT_ID,
	].sort(compareStrings),
);

/**
 * Product ids this package catalogs but deliberately does **not** resolve.
 *
 * A non-convergent resolver is worse than an absent one — it creates a second
 * resource on every retry — so the absences are declared here and asserted by a
 * test rather than left to be discovered at deploy time. Two kinds of absence
 * are mixed in this list on purpose, and each id says which it is:
 *
 * `azure.aks/v1` — **no convergent ARM path.** The binding's options (replicas,
 * service type, resource limits, image) describe a Kubernetes Deployment and
 * Service, which live behind the *cluster's* Kubernetes API, not ARM. The ARM
 * `managedClusters` PUT would create a different resource than the binding
 * describes, so there is nothing here for an ARM resolver to converge.
 *
 * `azure.api-management/v1` — **no honestly bounded operation.** `PUT
 * …/Microsoft.ApiManagement/service/{name}` is routinely a 30–45 minute
 * long-running operation. No poll budget a deploy call can carry reaches its
 * terminal state, so every outcome would be "accepted, not confirmed"; and the
 * create additionally requires `publisherEmail`/`publisherName` that the
 * binding does not name.
 *
 * `azure.postgres-flexible/v1` — **the create needs credential material.** A
 * Flexible Server create under the default password authentication requires
 * `administratorLogin` and `administratorLoginPassword` in the request body,
 * and a `ResolveRequest.desired` bag may not carry either (core refuses
 * credential-shaped keys, correctly). The Entra-only alternative
 * (`authConfig.passwordAuth: "Disabled"`) additionally needs an administrator
 * assignment through a separate sub-resource, so it is not one convergent PUT.
 *
 * `azure.sql-database/v1` — **the same credential problem, one level up.** The
 * database PUT is convergent, but it needs a logical server parent whose own
 * create requires an administrator login and password.
 *
 * `azure.app-service/v1` and `azure.functions/v1` — **the binding names no
 * parent.** A site needs a `Microsoft.Web/serverfarms` plan (and a Functions app
 * additionally needs a storage account whose *connection string* is credential
 * material). The bindings name a plan sku but no plan, and inventing one would
 * make the resolver own a resource the request never described.
 *
 * `azure.static-web-apps/v1` — **a coverage gap, not a design limit.** The ARM
 * surface is convergent, but a Static Web App created without a repository and
 * repository token is an empty site, which is a half-truth this package would
 * rather not ship than ship silently.
 */
export const AZURE_UNRESOLVED_PRODUCT_IDS = Object.freeze(
	[
		productIdOf(aks(), "aks"),
		productIdOf(apiManagement(), "apiManagement"),
		productIdOf(appService(), "appService"),
		productIdOf(functions(), "functions"),
		productIdOf(postgresFlexible(), "postgresFlexible"),
		productIdOf(sqlDatabase(), "sqlDatabase"),
		productIdOf(staticWebApps(), "staticWebApps"),
	].sort(compareStrings),
);

// ---------------------------------------------------------------------------
// Construction options
// ---------------------------------------------------------------------------

/** How many polls a long-running operation gets before it is reported
 *  unconfirmed. Bounded by construction: an unbounded loop against a stuck ARM
 *  operation is a deploy that never returns. */
export const AZURE_DEFAULT_POLL_BUDGET = 20;

/** Ceiling on the injected budget, so a config typo cannot restore the
 *  unbounded loop the budget exists to rule out. */
export const AZURE_MAX_POLL_BUDGET = 200;

/** What a host must supply to build the resolvers. */
export interface AzureResolverOptions {
	/** The subscription every ARM path is scoped to. */
	readonly subscriptionId: string;
	/** The resource group every resource is created in. */
	readonly resourceGroup: string;
	/**
	 * Resolves a credential *locator* to an ARM bearer token. Injected so the
	 * resolver never holds a secret and never decides where secrets live.
	 */
	readonly resolveCredential: (ref: string) => Promise<string>;
	/** Polls a long-running operation gets before it is reported unconfirmed. */
	readonly pollBudget?: number;
	/**
	 * Spacing between polls. Injected because a resolver may not read a clock:
	 * the default resolves immediately, which is what keeps tests deterministic,
	 * and a host that wants real backoff supplies it here.
	 */
	readonly waitBetweenPolls?: (attempt: number) => Promise<void>;
}

/** ARM subscription ids are GUIDs. Anything else would land in a URL path. */
const SUBSCRIPTION_ID_PATTERN =
	/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/u;

/** ARM resource-group grammar: alphanumerics, underscore, parentheses, hyphen
 *  and period, up to 90 characters, not ending in a period. */
const RESOURCE_GROUP_PATTERN = /^[A-Za-z0-9._()-]{1,89}[A-Za-z0-9_()-]$/u;

/**
 * A credential locator, using the same grammar core's `parseResolveRequest`
 * enforces (`scheme://path`, no userinfo). Restated here rather than imported
 * because a resolver must refuse a bad ref even when a caller skipped the parse
 * boundary — and a second grammar would be a second answer.
 */
const CREDENTIAL_REF_PATTERN = /^[a-z][a-z0-9+.-]*:\/\/[^\s@]+$/u;

/**
 * What an ARM bearer token looks like when someone pastes the value into the
 * `credentialRef` field by mistake. Refusing this shape is the difference
 * between a locator in the event log and a live token in the event log.
 */
const RAW_CREDENTIAL_PATTERN = /^[A-Za-z0-9_.-]{16,}$/u;

/** Anything long and token-shaped is scrubbed out of provider error text. */
const TOKEN_PATTERN = /[A-Za-z0-9_-]{20,}/gu;

// ---------------------------------------------------------------------------
// Small pure helpers
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

function optionalNumber(
	record: JsonObject | undefined,
	key: string,
): number | undefined {
	if (record === undefined) return undefined;
	const value = record[key];
	return isJsonNumber(value) && Number.isFinite(value) ? value : undefined;
}

function optionalInteger(
	record: JsonObject | undefined,
	key: string,
): number | undefined {
	const value = optionalNumber(record, key);
	return value !== undefined && Number.isSafeInteger(value) ? value : undefined;
}

function nestedRecord(record: JsonObject | undefined, key: string): JsonObject {
	if (record === undefined) return {};
	const value = record[key];
	return isJsonObject(value) ? value : {};
}

/** Case-insensitive header lookup: header names are not case-significant. */
function headerValue(
	headers: Readonly<Record<string, string>>,
	name: string,
): string | undefined {
	const lower = name.toLowerCase();
	for (const [key, value] of Object.entries(headers)) {
		if (key.toLowerCase() === lower) return value;
	}
	return undefined;
}

/**
 * Redact provider text before it reaches a message, a diagnostic, or a log.
 * ARM echoes request context in `error.message`, and that context has carried
 * subscription GUIDs and token fragments; an AAD bearer token is a JWT whose
 * every segment is long and token-shaped, so this catches it too.
 */
export function redactAzureText(text: string, limit = 400): string {
	const scrubbed = text.replace(TOKEN_PATTERN, "[redacted]");
	return scrubbed.length > limit ? `${scrubbed.slice(0, limit)}…` : scrubbed;
}

/**
 * ISO-8601 duration to seconds, for the handful of ARM properties (Service Bus
 * lock duration) that round-trip as a duration string. Comparing the strings
 * instead would report permanent drift on a queue that is exactly as configured
 * — ARM may answer `PT1M` to a `PT60S` request — and a diagnostic that fires
 * every reconcile teaches operators to ignore diagnostics.
 */
function iso8601DurationSeconds(value: string): number | undefined {
	const match =
		/^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/u.exec(
			value,
		);
	if (match === null) return undefined;
	const [, days, hours, minutes, seconds] = match;
	if (
		days === undefined &&
		hours === undefined &&
		minutes === undefined &&
		seconds === undefined
	) {
		return undefined;
	}
	return (
		Number(days ?? 0) * 86_400 +
		Number(hours ?? 0) * 3_600 +
		Number(minutes ?? 0) * 60 +
		Number(seconds ?? 0)
	);
}

function secondsToIso8601Duration(seconds: number): string {
	return `PT${String(seconds)}S`;
}

// ---------------------------------------------------------------------------
// ARM wire boundary
// ---------------------------------------------------------------------------

/** Everything a resolver body needs, with the credential already resolved. */
interface AzureResolverContext {
	readonly request: ResolveRequest;
	readonly transport: HttpTransport;
	/** LIVE MATERIAL. Only ever placed in the `authorization` request header. */
	readonly token: string;
	readonly subscriptionId: string;
	readonly resourceGroup: string;
	/** The deterministic resource name: `desired.<nameKey>`, else the logical id. */
	readonly name: string;
	readonly desired: JsonObject;
	/** True when the caller already knows the physical id (adopt vs noop). */
	readonly knownPhysicalId: string | undefined;
	readonly pollBudget: number;
	readonly waitBetweenPolls: (attempt: number) => Promise<void>;
}

/**
 * The `/subscriptions`-relative path of a resource in this context's group.
 * `suffix` starts at `/providers/…` and carries already-encoded segments.
 */
function groupPath(context: AzureResolverContext, suffix: string): string {
	return `/${encodeURIComponent(context.subscriptionId)}/resourceGroups/${encodeURIComponent(context.resourceGroup)}${suffix}`;
}

/**
 * The full ARM resource id — the `physicalId` every outcome reports. It is
 * constructed rather than read off the response on purpose: constructing it
 * makes `physicalId` a pure function of (subscription, group, name), which is
 * exactly the determinism a second reconcile has to reproduce.
 */
function resourceId(context: AzureResolverContext, suffix: string): string {
	return `${AZURE_ARM_BASE_PATH}${groupPath(context, suffix)}`;
}

interface AzureCall {
	readonly method: TransportMethod;
	readonly url: string;
	readonly json?: unknown;
}

async function callArm(
	context: AzureResolverContext,
	call: AzureCall,
): Promise<TransportResponse> {
	const path = new URL(call.url).pathname.toLowerCase();
	if (
		!path.startsWith(`/subscriptions/${context.subscriptionId.toLowerCase()}/`)
	)
		throw new ResolverError(
			"RESOLVER_PRODUCT_UNSUPPORTED",
			"ARM operation URL belongs to a different subscription scope",
		);
	const body = call.json === undefined ? undefined : JSON.stringify(call.json);
	return context.transport({
		method: call.method,
		url: call.url,
		headers: {
			accept: "application/json",
			// The single place the resolved material is ever written.
			authorization: `Bearer ${context.token}`,
			...(body !== undefined
				? { "content-type": "application/json" }
				: undefined),
		},
		...(body !== undefined ? { body } : undefined),
		timeoutMs: AZURE_MAX_TIMEOUT_MS,
		maxResponseBytes: AZURE_MAX_RESPONSE_BYTES,
	});
}

/**
 * Parse an ARM response body. An empty body is legitimate (a `202` accept, a
 * `204` delete), so it maps to `undefined` rather than a refusal; a non-empty
 * body that is not a JSON object is `RESOLVER_OUTPUT_UNPARSEABLE`, because the
 * outcome of the call is then unknown and assuming it succeeded is the failure
 * mode this whole module exists to avoid.
 */
function parseArmBody(
	response: TransportResponse,
	label: string,
): JsonObject | undefined {
	const text = response.body.trim();
	if (text.length === 0) return undefined;
	let parsed: JsonValue;
	try {
		// SAFETY: JSON.parse yields a JSON value at this ARM document boundary.
		parsed = JSON.parse(text) as JsonValue;
	} catch {
		throw new ResolverError(
			"RESOLVER_OUTPUT_UNPARSEABLE",
			`${label}: Azure returned a status ${response.status} body that is not JSON, so the outcome of the call is unknown and it is refused rather than assumed; retry, and if it repeats the ARM contract or the pinned api-version has changed`,
		);
	}
	if (!isJsonObject(parsed)) {
		throw new ResolverError(
			"RESOLVER_OUTPUT_UNPARSEABLE",
			`${label}: Azure returned JSON that is not an ARM resource object (status ${response.status})`,
		);
	}
	return parsed;
}

/** Flatten ARM's `{ error: { code, message, details } }` into redacted text. */
function armErrorText(body: JsonObject | undefined): string {
	if (body === undefined) return "no error detail was returned";
	const error = isJsonObject(body.error) ? body.error : body;
	const code = optionalString(error, "code");
	const message = optionalString(error, "message");
	const parts: string[] = [];
	if (code !== undefined) parts.push(code);
	if (message !== undefined) parts.push(message);
	if (parts.length === 0) parts.push(JSON.stringify(error));
	return redactAzureText(parts.join(": "));
}

/** Any 4xx/5xx becomes a typed, redacted refusal. */
function assertArmOk(response: TransportResponse, label: string): void {
	if (response.status < 400) return;
	let body: JsonObject | undefined;
	try {
		body = parseArmBody(response, label);
	} catch {
		// A non-JSON error body is still an error; it just has no detail to
		// quote, and quoting the raw bytes would be quoting unredactable text.
		body = undefined;
	}
	throw new ResolverError(
		"RESOLVER_PROVIDER_REJECTED",
		`${label}: Azure Resource Manager refused the call with status ${response.status}: ${armErrorText(body)}`,
	);
}

/** ARM `provisioningState` / async-operation `status`, terminal-success set. */
const TERMINAL_SUCCESS_STATES = Object.freeze(["succeeded"]);
/** Terminal failures. `Cancelled` and `Canceled` both appear in the wild. */
const TERMINAL_FAILURE_STATES = Object.freeze([
	"canceled",
	"cancelled",
	"failed",
]);

function isTerminalSuccess(state: string | undefined): boolean {
	return state !== undefined && TERMINAL_SUCCESS_STATES.includes(state);
}

function isTerminalFailure(state: string | undefined): boolean {
	return state !== undefined && TERMINAL_FAILURE_STATES.includes(state);
}

/** `properties.provisioningState`, lowercased for comparison. */
function provisioningState(body: JsonObject | undefined): string | undefined {
	if (body === undefined) return undefined;
	const state = optionalString(
		nestedRecord(body, "properties"),
		"provisioningState",
	);
	return state?.toLowerCase();
}

/** The async-operation document's own `status`, lowercased. */
function operationState(body: JsonObject | undefined): string | undefined {
	if (body === undefined) return undefined;
	return optionalString(body, "status")?.toLowerCase();
}

/** What a long-running write settled into. */
interface ArmWriteResult {
	/** The resource as ARM last described it, when a terminal read got one. */
	readonly body: JsonObject | undefined;
	/** Non-empty exactly when the operation was accepted but not confirmed. */
	readonly diagnostics: readonly string[];
	/** `false` means: ARM took the write, and this package cannot say it landed. */
	readonly confirmed: boolean;
}

/** How a long-running operation is being followed. */
type PollKind = "async-operation" | "location" | "resource";

/**
 * The honest report for a write ARM accepted but this package could not see
 * finish. It is a diagnostic and never a silent success, because a `202` read
 * as a completed create is the single worst thing a resolver can do: the deploy
 * says the resource exists, the next step binds to it, and nothing is there.
 */
function acceptedNotConfirmed(label: string, reason: string): string {
	return `${label}: Azure accepted the write but it is NOT confirmed complete — ${reason}. The resource is provisioning; re-run reconcile to converge, and do not treat this outcome as a finished create`;
}

/**
 * Drive an ARM write to a terminal state.
 *
 * The three shapes ARM answers a write with are all handled here rather than at
 * each call site, so no product can accidentally grow its own opinion about
 * what a `202` means:
 *
 *  - `202` (and `201` with an operation header): follow `Azure-AsyncOperation`
 *    if present, else `Location`.
 *  - `200`/`201` whose body carries a non-terminal `provisioningState`: poll the
 *    resource itself.
 *  - `200`/`201` with a terminal or absent `provisioningState`: already done —
 *    a blob container or a Service Bus queue has no provisioning phase at all.
 *
 * Polling is bounded by `context.pollBudget` and spaced by the injected
 * `waitBetweenPolls`; there is no clock read and no unbounded loop. Running out
 * of budget is reported, not swallowed.
 */
async function settleWrite(
	context: AzureResolverContext,
	response: TransportResponse,
	resourcePath: string,
	apiVersion: string,
	label: string,
): Promise<ArmWriteResult> {
	assertArmOk(response, label);
	const initial = parseArmBody(response, label);

	const asyncHeader = headerValue(response.headers, "azure-asyncoperation");
	const locationHeader = headerValue(response.headers, "location");
	const rawFollow = asyncHeader ?? locationHeader;
	const kind: PollKind =
		asyncHeader !== undefined ? "async-operation" : "location";

	if (response.status === 202) {
		if (rawFollow === undefined) {
			return {
				body: initial,
				diagnostics: [
					acceptedNotConfirmed(
						label,
						"ARM answered 202 with neither an Azure-AsyncOperation nor a Location header, so there is no operation to follow",
					),
				],
				confirmed: false,
			};
		}
		const followUrl = azureOperationUrl(rawFollow, apiVersion);
		if (followUrl === undefined) {
			return {
				body: initial,
				diagnostics: [
					acceptedNotConfirmed(
						label,
						"ARM answered 202 with an operation URL outside the allowlisted management.azure.com/subscriptions surface, which this resolver refuses to call rather than follow with the bearer token attached",
					),
				],
				confirmed: false,
			};
		}
		return pollUntilTerminal(
			context,
			followUrl,
			kind,
			resourcePath,
			apiVersion,
			label,
		);
	}

	const state = provisioningState(initial);
	if (isTerminalFailure(state)) {
		throw new ResolverError(
			"RESOLVER_PROVIDER_REJECTED",
			`${label}: the ARM operation reached the terminal state ${JSON.stringify(state)}: ${armErrorText(initial)}`,
		);
	}
	if (state === undefined || isTerminalSuccess(state)) {
		return { body: initial, diagnostics: [], confirmed: true };
	}
	// Still provisioning. Prefer the operation URL ARM offered; otherwise poll
	// the resource, which is the only handle we have.
	const followUrl =
		rawFollow === undefined
			? undefined
			: azureOperationUrl(rawFollow, apiVersion);
	return followUrl === undefined
		? pollUntilTerminal(
				context,
				azureArmUrl(resourcePath, apiVersion),
				"resource",
				resourcePath,
				apiVersion,
				label,
			)
		: pollUntilTerminal(
				context,
				followUrl,
				kind,
				resourcePath,
				apiVersion,
				label,
			);
}

async function pollUntilTerminal(
	context: AzureResolverContext,
	pollUrl: string,
	kind: PollKind,
	resourcePath: string,
	apiVersion: string,
	label: string,
): Promise<ArmWriteResult> {
	for (let attempt = 1; attempt <= context.pollBudget; attempt += 1) {
		await context.waitBetweenPolls(attempt);
		const response = await callArm(context, { method: "GET", url: pollUrl });
		if (kind === "location" && response.status === 202) continue;
		assertArmOk(response, `${label} (operation poll ${attempt})`);
		const body = parseArmBody(response, `${label} (operation poll ${attempt})`);

		if (kind === "async-operation") {
			const state = operationState(body);
			if (isTerminalFailure(state)) {
				throw new ResolverError(
					"RESOLVER_PROVIDER_REJECTED",
					`${label}: the ARM operation reached the terminal state ${JSON.stringify(state)}: ${armErrorText(body)}`,
				);
			}
			if (isTerminalSuccess(state)) {
				return {
					body: await readResourceBody(
						context,
						resourcePath,
						apiVersion,
						label,
					),
					diagnostics: [],
					confirmed: true,
				};
			}
			if (state === undefined) {
				throw new ResolverError(
					"RESOLVER_OUTPUT_UNPARSEABLE",
					`${label}: the ARM async-operation document carries no "status", so whether the write landed is unknown and it is refused rather than assumed`,
				);
			}
			continue;
		}

		// A Location poll answers with the resource once it is done; a resource
		// poll always answers with the resource.
		const state = provisioningState(body);
		if (isTerminalFailure(state)) {
			throw new ResolverError(
				"RESOLVER_PROVIDER_REJECTED",
				`${label}: the ARM operation reached the terminal state ${JSON.stringify(state)}: ${armErrorText(body)}`,
			);
		}
		if (state === undefined || isTerminalSuccess(state)) {
			return { body, diagnostics: [], confirmed: true };
		}
	}
	return {
		body: undefined,
		diagnostics: [
			acceptedNotConfirmed(
				label,
				`the operation was still running after the ${context.pollBudget}-poll budget`,
			),
		],
		confirmed: false,
	};
}

async function readResourceBody(
	context: AzureResolverContext,
	resourcePath: string,
	apiVersion: string,
	label: string,
): Promise<JsonObject | undefined> {
	const response = await callArm(context, {
		method: "GET",
		url: azureArmUrl(resourcePath, apiVersion),
	});
	if (response.status === 404) return undefined;
	assertArmOk(response, `${label} (final read)`);
	const body = parseArmBody(response, `${label} (final read)`);
	if (body === undefined)
		throw new ResolverError(
			"RESOLVER_OUTPUT_UNPARSEABLE",
			`${label}: a successful resource read contained no representation; absence is not confirmed`,
		);
	return body;
}

/** `GET` a resource id. `undefined` means "not there", which every
 *  read-or-create path needs to tell apart from an error. */
async function armGet(
	context: AzureResolverContext,
	resourcePath: string,
	apiVersion: string,
	label: string,
): Promise<JsonObject | undefined> {
	const response = await callArm(context, {
		method: "GET",
		url: azureArmUrl(resourcePath, apiVersion),
	});
	if (response.status === 404) return undefined;
	assertArmOk(response, label);
	const body = parseArmBody(response, label);
	if (body === undefined)
		throw new ResolverError(
			"RESOLVER_OUTPUT_UNPARSEABLE",
			`${label}: a successful resource read contained no representation; absence is not confirmed`,
		);
	return body;
}

/**
 * `DELETE` a resource id, treating "already gone" as success.
 *
 * A long-running delete is followed like any other write. If the budget runs
 * out the call *raises*, because `delete()` returns `void` and has no
 * diagnostics channel: raising with an explicit "accepted, not confirmed"
 * message is the only way to stop a caller reading an unfinished delete as a
 * finished one, and the delete is idempotent so re-running converges.
 */
async function armDelete(
	context: AzureResolverContext,
	resourcePath: string,
	apiVersion: string,
	label: string,
): Promise<void> {
	const response = await callArm(context, {
		method: "DELETE",
		url: azureArmUrl(resourcePath, apiVersion),
	});
	if (response.status === 404) return;
	if (response.status === 204) {
		const observed = await callArm(context, {
			method: "GET",
			url: azureArmUrl(resourcePath, apiVersion),
		});
		if (observed.status === 404) return;
		assertArmOk(observed, `${label} (confirm absence)`);
		throw new ResolverError(
			"RESOLVER_PROVIDER_REJECTED",
			`${label}: resource still exists or its absence is not confirmed after delete acknowledgement`,
		);
	}
	const settled = await settleWrite(
		context,
		response,
		resourcePath,
		apiVersion,
		label,
	);
	if (!settled.confirmed) {
		throw new ResolverError(
			"RESOLVER_PROVIDER_REJECTED",
			`${label}: ${settled.diagnostics.join("; ")} — the resource may still exist, so this delete is reported as unconfirmed rather than as done; re-run delete to converge`,
		);
	}
	const observed = await callArm(context, {
		method: "GET",
		url: azureArmUrl(resourcePath, apiVersion),
	});
	if (observed.status !== 404) {
		assertArmOk(observed, `${label} (confirm absence)`);
		throw new ResolverError(
			"RESOLVER_PROVIDER_REJECTED",
			`${label}: resource still exists or its absence is not confirmed after terminal deletion`,
		);
	}
}

// ---------------------------------------------------------------------------
// Request boundary
// ---------------------------------------------------------------------------

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
 * distinction is the audit record — adoption of an unmanaged resource is a fact
 * an operator should be able to see, not something folded into "nothing
 * happened".
 */
function settledAction(context: AzureResolverContext): ResolverAction {
	return context.knownPhysicalId === undefined ? "adopt" : "noop";
}

function assertSubscriptionId(value: string): string {
	if (!SUBSCRIPTION_ID_PATTERN.test(value)) {
		throw new ResolverError(
			"RESOLVER_PRODUCT_UNSUPPORTED",
			"azure resolvers need a subscriptionId GUID: every ARM path is subscription-scoped, and a malformed one would be pasted straight into a URL path",
		);
	}
	return value;
}

function assertResourceGroup(value: string): string {
	if (!RESOURCE_GROUP_PATTERN.test(value)) {
		throw new ResolverError(
			"RESOLVER_PRODUCT_UNSUPPORTED",
			"azure resolvers need a resourceGroup matching ARM's name grammar (alphanumerics, underscore, parentheses, hyphen and period, up to 90 characters, not ending in a period)",
		);
	}
	return value;
}

function assertPollBudget(value: number | undefined): number {
	if (value === undefined) return AZURE_DEFAULT_POLL_BUDGET;
	if (
		!Number.isSafeInteger(value) ||
		value < 1 ||
		value > AZURE_MAX_POLL_BUDGET
	) {
		throw new ResolverError(
			"RESOLVER_PRODUCT_UNSUPPORTED",
			`azure resolvers need a pollBudget between 1 and ${AZURE_MAX_POLL_BUDGET}; an unbounded budget is the unbounded loop the budget exists to rule out`,
		);
	}
	return value;
}

/**
 * The credential parse boundary.
 *
 * `credentialRef` is a locator. A blank one is `RESOLVER_CREDENTIAL_MISSING`
 * (with the remediation), a token-shaped one is `RESOLVER_CREDENTIAL_NOT_A_REF`
 * — a raw secret in a request record has already leaked by the time it is used
 * — and a resolver that hands back nothing is missing, never "carry on
 * unauthenticated". The offending value is never echoed unredacted.
 */
async function resolveToken(
	request: ResolveRequest,
	resolve: (ref: string) => Promise<string>,
): Promise<string> {
	const ref = request.credentialRef;
	if (ref.trim().length === 0) {
		throw new ResolverError(
			"RESOLVER_CREDENTIAL_MISSING",
			'azure resolver: credentialRef is empty. Supply a locator such as "env://AZURE_ARM_ACCESS_TOKEN" or "secret://camp/azure-arm-token" and register it with the host credential resolver; the resolver never accepts inline credential material',
		);
	}
	const trimmed = ref.trim();
	if (RAW_CREDENTIAL_PATTERN.test(trimmed)) {
		throw new ResolverError(
			"RESOLVER_CREDENTIAL_NOT_A_REF",
			"azure resolver: credentialRef looks like credential material rather than a locator. Store the ARM bearer token with the host secret custody and pass its reference (scheme://path); a raw token in a ResolveRequest is a token in the event log",
		);
	}
	if (!CREDENTIAL_REF_PATTERN.test(trimmed)) {
		throw new ResolverError(
			"RESOLVER_CREDENTIAL_NOT_A_REF",
			`azure resolver: credentialRef ${JSON.stringify(redactAzureText(trimmed, 60))} is not a locator. Expected "<scheme>://<path>", for example "env://AZURE_ARM_ACCESS_TOKEN"`,
		);
	}
	let material: string;
	try {
		material = await resolve(trimmed);
	} catch (cause) {
		throw new ResolverError(
			"RESOLVER_CREDENTIAL_MISSING",
			`azure resolver: the host could not resolve credentialRef ${JSON.stringify(trimmed)}: ${redactAzureText(
				cause instanceof Error ? cause.message : String(cause),
				160,
			)}. Register the reference with the credential resolver before deploying`,
		);
	}
	if (material.trim().length === 0) {
		throw new ResolverError(
			"RESOLVER_CREDENTIAL_MISSING",
			`azure resolver: credentialRef ${JSON.stringify(trimmed)} resolved to nothing. A missing credential is refused rather than retried unauthenticated, which would look like a permissions error at the provider`,
		);
	}
	return material.trim();
}

/**
 * The deterministic resource name. Never generated: the name is what makes
 * reconcile convergent, so a resolver that invented one would create a second
 * resource on every run.
 */
function resourceName(
	request: ResolveRequest,
	productId: string,
	nameKeys: readonly string[],
): string {
	const desired = parseJsonObject(JSON.stringify(request.desired));
	for (const key of nameKeys) {
		const value = optionalString(desired, key);
		if (value !== undefined) return value;
	}
	const logicalId = request.ref.logicalId;
	if (logicalId.trim().length > 0) {
		return logicalId;
	}
	throw new ResolverError(
		"RESOLVER_PRODUCT_UNSUPPORTED",
		`${productId}: the request names no resource — set desired.${nameKeys[0] ?? "name"} or ref.logicalId. The name is what makes reconcile convergent, so it is never generated here`,
	);
}

/** The physical id the caller already knows, if it supplied a usable one. */
function knownPhysicalId(request: ResolveRequest): string | undefined {
	const value = request.ref.physicalId;
	return value !== undefined && value.trim().length > 0 ? value : undefined;
}

/** A required `desired` field, refused by name with what to add. */
function requiredDesired(
	context: AzureResolverContext,
	key: string,
	productId: string,
	why: string,
): string {
	const value = optionalString(context.desired, key);
	if (value === undefined) {
		throw new ResolverError(
			"RESOLVER_PRODUCT_UNSUPPORTED",
			`${productId}: desired.${key} is required — ${why}. Add it to the binding's properties; this resolver never invents one, because the wrong guess would target a resource nobody asked for`,
			productId,
		);
	}
	return value;
}

/** Per-product behaviour; the wrapper owns credentials, naming, and refusals. */
interface AzureResolverSpec {
	readonly productId: string;
	/** Which `desired` keys may name the resource, in precedence order. */
	readonly nameKeys?: readonly string[];
	reconcile(context: AzureResolverContext): Promise<ResolveOutcome>;
	read(context: AzureResolverContext): Promise<ResolveOutcome | undefined>;
	remove(context: AzureResolverContext): Promise<void>;
}

function createResolver(
	spec: AzureResolverSpec,
	options: AzureResolverOptions,
): ResourceResolver {
	const subscriptionId = assertSubscriptionId(options.subscriptionId);
	const resourceGroup = assertResourceGroup(options.resourceGroup);
	const pollBudget = assertPollBudget(options.pollBudget);
	const waitBetweenPolls =
		options.waitBetweenPolls ?? ((): Promise<void> => Promise.resolve());
	const nameKeys = spec.nameKeys ?? ["name"];

	async function contextFor(
		input: ResolveRequest,
		transport: HttpTransport,
	): Promise<AzureResolverContext> {
		// Parse, don't validate: the core boundary canonicalizes the bags, screens
		// credential-shaped keys at any depth, and freezes the record before a
		// single byte of it reaches a URL or a request body.
		//
		// The round-trip is what lets an already-typed `ResolveRequest` back
		// through that boundary: `parseResolveRequest` takes untrusted JSON, and
		// the interface hands this function the domain type. Re-screening a value
		// the caller says is already parsed is deliberate belt-and-braces for the
		// one provider whose requests carry subscription and resource-group
		// identifiers into URLs. The same idiom is used for `desired` below.
		const request = parseResolveRequest(parseJsonObject(JSON.stringify(input)));
		if (request.ref.productId !== spec.productId) {
			throw new ResolverError(
				"RESOLVER_PRODUCT_UNSUPPORTED",
				`azure resolver for ${spec.productId} was handed a request for ${JSON.stringify(request.ref.productId)}; route the request through the registry rather than picking a resolver by hand`,
				spec.productId,
			);
		}
		const token = await resolveToken(request, options.resolveCredential);
		return {
			request,
			transport: guardedAzureTransport(transport),
			token,
			subscriptionId,
			resourceGroup,
			name: resourceName(request, spec.productId, nameKeys),
			desired: parseJsonObject(JSON.stringify(request.desired)),
			knownPhysicalId: knownPhysicalId(request),
			pollBudget,
			waitBetweenPolls,
		};
	}

	return {
		providerId: AZURE_PROVIDER_TARGET,
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
// Storage — Microsoft.Storage
// ---------------------------------------------------------------------------

function storageAccountSuffix(account: string): string {
	return `/providers/Microsoft.Storage/storageAccounts/${encodeURIComponent(account)}`;
}

/**
 * The storage account is a *precondition*, not something this resolver creates.
 *
 * Creating one would mean choosing a globally unique name, a sku, a redundancy
 * mode and a location on the caller's behalf, and then owning the deletion
 * question for every other container in it. Naming an existing account keeps
 * this resolver's blast radius to the one sub-resource the binding describes.
 */
async function requireStorageAccount(
	context: AzureResolverContext,
	productId: string,
): Promise<string> {
	const account = requiredDesired(
		context,
		"storageAccount",
		productId,
		"this resolver owns the sub-resource inside a storage account, not the account itself",
	);
	const path = groupPath(context, storageAccountSuffix(account));
	const observed = await armGet(
		context,
		path,
		AZURE_STORAGE_API_VERSION,
		`storage account ${account}`,
	);
	if (observed === undefined) {
		throw new ResolverError(
			"RESOLVER_PROVIDER_REJECTED",
			`${productId}: storage account ${JSON.stringify(account)} does not exist in resource group ${JSON.stringify(context.resourceGroup)}. Create the account (or point desired.storageAccount at an existing one) before deploying; this resolver never creates a storage account, because it would then own every other container in it`,
			productId,
		);
	}
	return account;
}

/** Account-level and blob-service-level options the container cannot apply. */
function storageAccountLevelDiagnostics(
	context: AzureResolverContext,
): readonly string[] {
	const diagnostics: string[] = [];
	if (optionalString(context.desired, "accessTier") !== undefined) {
		diagnostics.push(
			"accessTier is declared but not applied: the blob access tier is a storage-account property (and a per-blob one), not a container property, so it is left to the account this container lives in",
		);
	}
	if (optionalString(context.desired, "redundancy") !== undefined) {
		diagnostics.push(
			"redundancy is declared but not applied: redundancy is the storage account's sku, fixed when the account was created, and this resolver never creates or replaces an account",
		);
	}
	if (optionalBoolean(context.desired, "versioning") !== undefined) {
		diagnostics.push(
			"versioning is declared but not applied: blob versioning is set on the account's blobServices/default resource, which is shared by every container and therefore not this resolver's to change",
		);
	}
	return diagnostics;
}

function blobContainerSuffix(account: string, name: string): string {
	return `${storageAccountSuffix(account)}/blobServices/default/containers/${encodeURIComponent(name)}`;
}

function blobContainerOutputs(
	account: string,
	name: string,
	body: JsonObject | undefined,
): JsonObject {
	const properties =
		body === undefined ? undefined : nestedRecord(body, "properties");
	const publicAccess = optionalString(properties, "publicAccess");
	return {
		containerName: name,
		storageAccount: account,
		...(publicAccess !== undefined ? { publicAccess } : undefined),
	};
}

/**
 * `publicAccessBlocked: true` is the one container-level property the binding
 * names, and it maps to ARM's `publicAccess: "None"`. `false` is deliberately
 * *not* mapped to a public level: "do not block" states no requirement, and
 * turning a private container public is not something to infer.
 */
function wantedPublicAccess(context: AzureResolverContext): string | undefined {
	return optionalBoolean(context.desired, "publicAccessBlocked") === true
		? "None"
		: undefined;
}

const BLOB_STORAGE_SPEC: Omit<AzureResolverSpec, "productId"> = {
	async read(context) {
		const account = await requireStorageAccount(
			context,
			AZURE_BLOB_STORAGE_PRODUCT_ID,
		);
		const path = groupPath(context, blobContainerSuffix(account, context.name));
		const observed = await armGet(
			context,
			path,
			AZURE_STORAGE_API_VERSION,
			`blob container ${context.name}`,
		);
		if (observed === undefined) return undefined;
		return outcome(
			settledAction(context),
			resourceId(context, blobContainerSuffix(account, context.name)),
			blobContainerOutputs(account, context.name, observed),
			storageAccountLevelDiagnostics(context),
		);
	},
	async reconcile(context) {
		const account = await requireStorageAccount(
			context,
			AZURE_BLOB_STORAGE_PRODUCT_ID,
		);
		const suffix = blobContainerSuffix(account, context.name);
		const path = groupPath(context, suffix);
		const id = resourceId(context, suffix);
		const label = `blob container ${context.name}`;
		const diagnostics = [...storageAccountLevelDiagnostics(context)];
		const publicAccess = wantedPublicAccess(context);

		const observed = await armGet(
			context,
			path,
			AZURE_STORAGE_API_VERSION,
			label,
		);
		if (observed === undefined) {
			const created = await settleWrite(
				context,
				await callArm(context, {
					method: "PUT",
					url: azureArmUrl(path, AZURE_STORAGE_API_VERSION),
					json: {
						properties: {
							...(publicAccess !== undefined ? { publicAccess } : undefined),
						},
					},
				}),
				path,
				AZURE_STORAGE_API_VERSION,
				label,
			);
			return outcome(
				"create",
				id,
				blobContainerOutputs(account, context.name, created.body),
				[...diagnostics, ...created.diagnostics],
			);
		}

		const observedProperties = nestedRecord(observed, "properties");
		const currentAccess = optionalString(observedProperties, "publicAccess");
		if (publicAccess !== undefined && currentAccess !== publicAccess) {
			// The observed properties are carried forward under the delta: an ARM
			// container PUT is a full write, so sending only `publicAccess` would
			// drop metadata a human set out of band.
			const updated = await settleWrite(
				context,
				await callArm(context, {
					method: "PUT",
					url: azureArmUrl(path, AZURE_STORAGE_API_VERSION),
					json: { properties: { ...observedProperties, publicAccess } },
				}),
				path,
				AZURE_STORAGE_API_VERSION,
				label,
			);
			return outcome(
				"update",
				id,
				blobContainerOutputs(account, context.name, updated.body),
				[
					...diagnostics,
					`public access set to ${publicAccess}`,
					...updated.diagnostics,
				],
			);
		}
		return outcome(
			settledAction(context),
			id,
			blobContainerOutputs(account, context.name, observed),
			diagnostics,
		);
	},
	async remove(context) {
		const account = requiredDesired(
			context,
			"storageAccount",
			AZURE_BLOB_STORAGE_PRODUCT_ID,
			"the container is addressed inside a named storage account",
		);
		await armDelete(
			context,
			groupPath(context, blobContainerSuffix(account, context.name)),
			AZURE_STORAGE_API_VERSION,
			`blob container ${context.name}`,
		);
	},
};

function storageQueueSuffix(account: string, name: string): string {
	return `${storageAccountSuffix(account)}/queueServices/default/queues/${encodeURIComponent(name)}`;
}

function storageQueueOutputs(account: string, name: string): JsonObject {
	return { queueName: name, storageAccount: account };
}

/**
 * The binding's queue options are *per-message* parameters on the data plane
 * (`visibilitytimeout` and `messagettl` are query parameters on Put Message),
 * not properties of the queue resource. Applying them here is impossible, so
 * they are reported rather than silently dropped.
 */
function storageQueueDiagnostics(
	context: AzureResolverContext,
): readonly string[] {
	const diagnostics: string[] = [];
	if (
		optionalInteger(context.desired, "visibilityTimeoutSeconds") !== undefined
	) {
		diagnostics.push(
			"visibilityTimeoutSeconds is declared but not applied: Azure Storage queue visibility timeout is a per-message data-plane parameter, not a property of the queue resource",
		);
	}
	if (optionalInteger(context.desired, "messageTtlSeconds") !== undefined) {
		diagnostics.push(
			"messageTtlSeconds is declared but not applied: Azure Storage queue message time-to-live is set per message on the data plane, not on the queue resource",
		);
	}
	return diagnostics;
}

const STORAGE_QUEUE_SPEC: Omit<AzureResolverSpec, "productId"> = {
	async read(context) {
		const account = await requireStorageAccount(
			context,
			AZURE_STORAGE_QUEUE_PRODUCT_ID,
		);
		const suffix = storageQueueSuffix(account, context.name);
		const observed = await armGet(
			context,
			groupPath(context, suffix),
			AZURE_STORAGE_API_VERSION,
			`storage queue ${context.name}`,
		);
		if (observed === undefined) return undefined;
		return outcome(
			settledAction(context),
			resourceId(context, suffix),
			storageQueueOutputs(account, context.name),
			storageQueueDiagnostics(context),
		);
	},
	async reconcile(context) {
		const account = await requireStorageAccount(
			context,
			AZURE_STORAGE_QUEUE_PRODUCT_ID,
		);
		const suffix = storageQueueSuffix(account, context.name);
		const path = groupPath(context, suffix);
		const id = resourceId(context, suffix);
		const label = `storage queue ${context.name}`;
		const diagnostics = storageQueueDiagnostics(context);

		const observed = await armGet(
			context,
			path,
			AZURE_STORAGE_API_VERSION,
			label,
		);
		if (observed !== undefined) {
			return outcome(
				settledAction(context),
				id,
				storageQueueOutputs(account, context.name),
				diagnostics,
			);
		}
		const created = await settleWrite(
			context,
			await callArm(context, {
				method: "PUT",
				url: azureArmUrl(path, AZURE_STORAGE_API_VERSION),
				json: { properties: {} },
			}),
			path,
			AZURE_STORAGE_API_VERSION,
			label,
		);
		return outcome("create", id, storageQueueOutputs(account, context.name), [
			...diagnostics,
			...created.diagnostics,
		]);
	},
	async remove(context) {
		const account = requiredDesired(
			context,
			"storageAccount",
			AZURE_STORAGE_QUEUE_PRODUCT_ID,
			"the queue is addressed inside a named storage account",
		);
		await armDelete(
			context,
			groupPath(context, storageQueueSuffix(account, context.name)),
			AZURE_STORAGE_API_VERSION,
			`storage queue ${context.name}`,
		);
	},
};

// ---------------------------------------------------------------------------
// Service Bus — Microsoft.ServiceBus
// ---------------------------------------------------------------------------

function serviceBusNamespaceSuffix(namespace: string): string {
	return `/providers/Microsoft.ServiceBus/namespaces/${encodeURIComponent(namespace)}`;
}

/**
 * Like the storage account, the Service Bus namespace is a precondition. Its
 * own create is a long-running operation with a sku and a capacity nobody
 * declared, and a namespace this resolver created would then be a namespace it
 * had to reason about deleting.
 */
async function requireServiceBusNamespace(
	context: AzureResolverContext,
	productId: string,
): Promise<string> {
	const namespace = requiredDesired(
		context,
		"namespace",
		productId,
		"a Service Bus queue or topic is a sub-resource of a namespace, and this resolver owns the entity, not the namespace",
	);
	const observed = await armGet(
		context,
		groupPath(context, serviceBusNamespaceSuffix(namespace)),
		AZURE_SERVICE_BUS_API_VERSION,
		`service bus namespace ${namespace}`,
	);
	if (observed === undefined) {
		throw new ResolverError(
			"RESOLVER_PROVIDER_REJECTED",
			`${productId}: Service Bus namespace ${JSON.stringify(namespace)} does not exist in resource group ${JSON.stringify(context.resourceGroup)}. Create the namespace (or point desired.namespace at an existing one) before deploying; this resolver never creates a namespace`,
			productId,
		);
	}
	return namespace;
}

/**
 * Properties ARM reports on a Service Bus entity but refuses (or ignores) on a
 * write. They are stripped before the observed body is carried forward into an
 * update, which is how a mutable delta is applied without resetting every
 * property the binding does not name.
 */
const SERVICE_BUS_READ_ONLY_PROPERTIES = Object.freeze([
	"accessedAt",
	"countDetails",
	"createdAt",
	"messageCount",
	"sizeInBytes",
	"subscriptionCount",
	"updatedAt",
]);

function withoutReadOnly(
	properties: JsonObject,
	readOnly: readonly string[],
): JsonObject {
	const out = {};
	for (const key of Object.keys(properties).sort(compareStrings)) {
		if (readOnly.includes(key)) continue;
		const value = properties[key];
		if (value !== undefined) Object.assign(out, { [key]: value });
	}
	return out;
}

function serviceBusQueueSuffix(namespace: string, name: string): string {
	return `${serviceBusNamespaceSuffix(namespace)}/queues/${encodeURIComponent(name)}`;
}

function serviceBusTopicSuffix(namespace: string, name: string): string {
	return `${serviceBusNamespaceSuffix(namespace)}/topics/${encodeURIComponent(name)}`;
}

/** The mutable slice of a Service Bus queue the binding names. */
function serviceBusQueueDeltas(context: AzureResolverContext): JsonObject {
	const out = {};
	const lockSeconds = optionalInteger(context.desired, "lockDurationSeconds");
	if (lockSeconds !== undefined) {
		Object.assign(out, { lockDuration: secondsToIso8601Duration(lockSeconds) });
	}
	const maxDelivery = optionalInteger(context.desired, "maxDeliveryCount");
	if (maxDelivery !== undefined) {
		Object.assign(out, { maxDeliveryCount: maxDelivery });
	}
	const deadLetter = optionalBoolean(context.desired, "deadLetterOnExpiration");
	if (deadLetter !== undefined) {
		Object.assign(out, { deadLetteringOnMessageExpiration: deadLetter });
	}
	return out;
}

/** True when the observed entity already satisfies every named delta. */
function serviceBusQueueSettled(
	context: AzureResolverContext,
	properties: JsonObject,
): boolean {
	const lockSeconds = optionalInteger(context.desired, "lockDurationSeconds");
	if (lockSeconds !== undefined) {
		const observedLock = optionalString(properties, "lockDuration");
		const observedSeconds =
			observedLock === undefined
				? undefined
				: iso8601DurationSeconds(observedLock);
		if (observedSeconds !== lockSeconds) return false;
	}
	const maxDelivery = optionalInteger(context.desired, "maxDeliveryCount");
	if (
		maxDelivery !== undefined &&
		optionalInteger(properties, "maxDeliveryCount") !== maxDelivery
	) {
		return false;
	}
	const deadLetter = optionalBoolean(context.desired, "deadLetterOnExpiration");
	return !(
		deadLetter !== undefined &&
		optionalBoolean(properties, "deadLetteringOnMessageExpiration") !==
			deadLetter
	);
}

/** `requiresSession` is fixed at create. Drift is reported, never corrected:
 *  correcting it would mean deleting a queue and its messages. */
function serviceBusQueueDiagnostics(
	context: AzureResolverContext,
	properties: JsonObject,
): readonly string[] {
	const wanted = optionalBoolean(context.desired, "sessionsEnabled");
	const actual = optionalBoolean(properties, "requiresSession");
	if (wanted === undefined || actual === undefined || wanted === actual) {
		return [];
	}
	return [
		`queue requiresSession is ${String(actual)} but sessionsEnabled asks for ${String(wanted)}; session support is fixed when a Service Bus queue is created and this resolver never replaces a queue, so the drift is reported for a human rather than corrected`,
	];
}

function serviceBusQueueOutputs(
	namespace: string,
	name: string,
	body: JsonObject | undefined,
): JsonObject {
	const properties =
		body === undefined ? undefined : nestedRecord(body, "properties");
	const status = optionalString(properties, "status");
	const lockDuration = optionalString(properties, "lockDuration");
	const maxDeliveryCount = optionalInteger(properties, "maxDeliveryCount");
	const requiresSession = optionalBoolean(properties, "requiresSession");
	return {
		namespace,
		queueName: name,
		...(lockDuration !== undefined ? { lockDuration } : undefined),
		...(maxDeliveryCount !== undefined ? { maxDeliveryCount } : undefined),
		...(requiresSession !== undefined ? { requiresSession } : undefined),
		...(status !== undefined ? { status } : undefined),
	};
}

const SERVICE_BUS_QUEUE_SPEC: Omit<AzureResolverSpec, "productId"> = {
	async read(context) {
		const namespace = await requireServiceBusNamespace(
			context,
			AZURE_SERVICE_BUS_QUEUE_PRODUCT_ID,
		);
		const suffix = serviceBusQueueSuffix(namespace, context.name);
		const observed = await armGet(
			context,
			groupPath(context, suffix),
			AZURE_SERVICE_BUS_API_VERSION,
			`service bus queue ${context.name}`,
		);
		if (observed === undefined) return undefined;
		return outcome(
			settledAction(context),
			resourceId(context, suffix),
			serviceBusQueueOutputs(namespace, context.name, observed),
			serviceBusQueueDiagnostics(context, nestedRecord(observed, "properties")),
		);
	},
	async reconcile(context) {
		const namespace = await requireServiceBusNamespace(
			context,
			AZURE_SERVICE_BUS_QUEUE_PRODUCT_ID,
		);
		const suffix = serviceBusQueueSuffix(namespace, context.name);
		const path = groupPath(context, suffix);
		const id = resourceId(context, suffix);
		const label = `service bus queue ${context.name}`;
		const deltas = serviceBusQueueDeltas(context);

		const observed = await armGet(
			context,
			path,
			AZURE_SERVICE_BUS_API_VERSION,
			label,
		);
		if (observed === undefined) {
			const sessions = optionalBoolean(context.desired, "sessionsEnabled");
			const created = await settleWrite(
				context,
				await callArm(context, {
					method: "PUT",
					url: azureArmUrl(path, AZURE_SERVICE_BUS_API_VERSION),
					json: {
						properties: {
							...deltas,
							...(sessions !== undefined
								? { requiresSession: sessions }
								: undefined),
						},
					},
				}),
				path,
				AZURE_SERVICE_BUS_API_VERSION,
				label,
			);
			return outcome(
				"create",
				id,
				serviceBusQueueOutputs(namespace, context.name, created.body),
				created.diagnostics,
			);
		}

		const properties = nestedRecord(observed, "properties");
		const diagnostics = serviceBusQueueDiagnostics(context, properties);
		if (serviceBusQueueSettled(context, properties)) {
			return outcome(
				settledAction(context),
				id,
				serviceBusQueueOutputs(namespace, context.name, observed),
				diagnostics,
			);
		}
		const updated = await settleWrite(
			context,
			await callArm(context, {
				method: "PUT",
				url: azureArmUrl(path, AZURE_SERVICE_BUS_API_VERSION),
				json: {
					properties: {
						...withoutReadOnly(properties, SERVICE_BUS_READ_ONLY_PROPERTIES),
						...deltas,
					},
				},
			}),
			path,
			AZURE_SERVICE_BUS_API_VERSION,
			label,
		);
		return outcome(
			"update",
			id,
			serviceBusQueueOutputs(namespace, context.name, updated.body),
			[...diagnostics, ...updated.diagnostics],
		);
	},
	async remove(context) {
		const namespace = requiredDesired(
			context,
			"namespace",
			AZURE_SERVICE_BUS_QUEUE_PRODUCT_ID,
			"the queue is addressed inside a named Service Bus namespace",
		);
		await armDelete(
			context,
			groupPath(context, serviceBusQueueSuffix(namespace, context.name)),
			AZURE_SERVICE_BUS_API_VERSION,
			`service bus queue ${context.name}`,
		);
	},
};

/** `maxSizeMb` is the mutable slice of a topic the binding names. */
function serviceBusTopicDeltas(context: AzureResolverContext) {
	const maxSize = optionalInteger(context.desired, "maxSizeMb");
	return maxSize === undefined ? undefined : { maxSizeInMegabytes: maxSize };
}

function serviceBusTopicSettled(
	context: AzureResolverContext,
	properties: JsonObject,
): boolean {
	const maxSize = optionalInteger(context.desired, "maxSizeMb");
	return (
		maxSize === undefined ||
		optionalInteger(properties, "maxSizeInMegabytes") === maxSize
	);
}

/** Duplicate detection and partitioning are fixed at create on Service Bus. */
function serviceBusTopicDiagnostics(
	context: AzureResolverContext,
	properties: JsonObject,
): readonly string[] {
	const diagnostics: string[] = [];
	const wantedDuplicates = optionalBoolean(
		context.desired,
		"duplicateDetection",
	);
	const actualDuplicates = optionalBoolean(
		properties,
		"requiresDuplicateDetection",
	);
	if (
		wantedDuplicates !== undefined &&
		actualDuplicates !== undefined &&
		wantedDuplicates !== actualDuplicates
	) {
		diagnostics.push(
			`topic requiresDuplicateDetection is ${String(actualDuplicates)} but duplicateDetection asks for ${String(wantedDuplicates)}; duplicate detection is fixed when a topic is created and this resolver never replaces a topic, so the drift is reported for a human rather than corrected`,
		);
	}
	const wantedPartitioned = optionalBoolean(context.desired, "partitioned");
	const actualPartitioned = optionalBoolean(properties, "enablePartitioning");
	if (
		wantedPartitioned !== undefined &&
		actualPartitioned !== undefined &&
		wantedPartitioned !== actualPartitioned
	) {
		diagnostics.push(
			`topic enablePartitioning is ${String(actualPartitioned)} but partitioned asks for ${String(wantedPartitioned)}; partitioning is fixed when a topic is created and this resolver never replaces a topic, so the drift is reported for a human rather than corrected`,
		);
	}
	return diagnostics;
}

function serviceBusTopicOutputs(
	namespace: string,
	name: string,
	body: JsonObject | undefined,
): JsonObject {
	const properties =
		body === undefined ? undefined : nestedRecord(body, "properties");
	const status = optionalString(properties, "status");
	const maxSizeInMegabytes = optionalInteger(properties, "maxSizeInMegabytes");
	const enablePartitioning = optionalBoolean(properties, "enablePartitioning");
	return {
		namespace,
		topicName: name,
		...(enablePartitioning !== undefined ? { enablePartitioning } : undefined),
		...(maxSizeInMegabytes !== undefined ? { maxSizeInMegabytes } : undefined),
		...(status !== undefined ? { status } : undefined),
	};
}

const SERVICE_BUS_TOPIC_SPEC: Omit<AzureResolverSpec, "productId"> = {
	async read(context) {
		const namespace = await requireServiceBusNamespace(
			context,
			AZURE_SERVICE_BUS_TOPIC_PRODUCT_ID,
		);
		const suffix = serviceBusTopicSuffix(namespace, context.name);
		const observed = await armGet(
			context,
			groupPath(context, suffix),
			AZURE_SERVICE_BUS_API_VERSION,
			`service bus topic ${context.name}`,
		);
		if (observed === undefined) return undefined;
		return outcome(
			settledAction(context),
			resourceId(context, suffix),
			serviceBusTopicOutputs(namespace, context.name, observed),
			serviceBusTopicDiagnostics(context, nestedRecord(observed, "properties")),
		);
	},
	async reconcile(context) {
		const namespace = await requireServiceBusNamespace(
			context,
			AZURE_SERVICE_BUS_TOPIC_PRODUCT_ID,
		);
		const suffix = serviceBusTopicSuffix(namespace, context.name);
		const path = groupPath(context, suffix);
		const id = resourceId(context, suffix);
		const label = `service bus topic ${context.name}`;
		const deltas = serviceBusTopicDeltas(context);

		const observed = await armGet(
			context,
			path,
			AZURE_SERVICE_BUS_API_VERSION,
			label,
		);
		if (observed === undefined) {
			const duplicates = optionalBoolean(context.desired, "duplicateDetection");
			const partitioned = optionalBoolean(context.desired, "partitioned");
			const created = await settleWrite(
				context,
				await callArm(context, {
					method: "PUT",
					url: azureArmUrl(path, AZURE_SERVICE_BUS_API_VERSION),
					json: {
						properties: {
							...deltas,
							...(duplicates !== undefined
								? { requiresDuplicateDetection: duplicates }
								: undefined),
							...(partitioned !== undefined
								? { enablePartitioning: partitioned }
								: undefined),
						},
					},
				}),
				path,
				AZURE_SERVICE_BUS_API_VERSION,
				label,
			);
			return outcome(
				"create",
				id,
				serviceBusTopicOutputs(namespace, context.name, created.body),
				created.diagnostics,
			);
		}

		const properties = nestedRecord(observed, "properties");
		const diagnostics = serviceBusTopicDiagnostics(context, properties);
		if (serviceBusTopicSettled(context, properties)) {
			return outcome(
				settledAction(context),
				id,
				serviceBusTopicOutputs(namespace, context.name, observed),
				diagnostics,
			);
		}
		const updated = await settleWrite(
			context,
			await callArm(context, {
				method: "PUT",
				url: azureArmUrl(path, AZURE_SERVICE_BUS_API_VERSION),
				json: {
					properties: {
						...withoutReadOnly(properties, SERVICE_BUS_READ_ONLY_PROPERTIES),
						...deltas,
					},
				},
			}),
			path,
			AZURE_SERVICE_BUS_API_VERSION,
			label,
		);
		return outcome(
			"update",
			id,
			serviceBusTopicOutputs(namespace, context.name, updated.body),
			[...diagnostics, ...updated.diagnostics],
		);
	},
	async remove(context) {
		const namespace = requiredDesired(
			context,
			"namespace",
			AZURE_SERVICE_BUS_TOPIC_PRODUCT_ID,
			"the topic is addressed inside a named Service Bus namespace",
		);
		await armDelete(
			context,
			groupPath(context, serviceBusTopicSuffix(namespace, context.name)),
			AZURE_SERVICE_BUS_API_VERSION,
			`service bus topic ${context.name}`,
		);
	},
};

// ---------------------------------------------------------------------------
// Key Vault — Microsoft.KeyVault
// ---------------------------------------------------------------------------

function keyVaultSuffix(name: string): string {
	return `/providers/Microsoft.KeyVault/vaults/${encodeURIComponent(name)}`;
}

/** The base tier ARM requires but the binding does not name. Chosen visibly:
 *  a create that used it says so in `diagnostics`. */
const KEY_VAULT_FALLBACK_SKU = "standard";

function keyVaultOutputs(
	name: string,
	body: JsonObject | undefined,
): JsonObject {
	const properties =
		body === undefined ? undefined : nestedRecord(body, "properties");
	const vaultUri = optionalString(properties, "vaultUri");
	const state = optionalString(properties, "provisioningState");
	const rbac = optionalBoolean(properties, "enableRbacAuthorization");
	return {
		vaultName: name,
		...(rbac !== undefined ? { enableRbacAuthorization: rbac } : undefined),
		...(state !== undefined ? { provisioningState: state } : undefined),
		...(vaultUri !== undefined ? { vaultUri } : undefined),
	};
}

/** The mutable slice of a vault the binding names. */
function keyVaultDeltas(context: AzureResolverContext, properties: JsonObject) {
	const patch = {};
	const diagnostics: string[] = [];

	const rbac = optionalBoolean(context.desired, "rbacAuthorization");
	if (
		rbac !== undefined &&
		optionalBoolean(properties, "enableRbacAuthorization") !== rbac
	) {
		Object.assign(patch, { enableRbacAuthorization: rbac });
	}
	const purge = optionalBoolean(context.desired, "purgeProtection");
	const observedPurge = optionalBoolean(properties, "enablePurgeProtection");
	if (purge === true && observedPurge !== true) {
		Object.assign(patch, { enablePurgeProtection: true });
	}
	if (purge === false && observedPurge === true) {
		// ARM has no way back: purge protection is permanent once enabled.
		diagnostics.push(
			"purgeProtection asks for false but the vault already has purge protection enabled; Azure makes that setting permanent, so the drift is reported rather than corrected — recreating the vault under a new name is the only path, and this resolver never replaces a vault",
		);
	}
	return { patch, diagnostics };
}

/** Immutable-at-create fields, reported rather than corrected. */
function keyVaultImmutableDiagnostics(
	context: AzureResolverContext,
	body: JsonObject,
): readonly string[] {
	const properties = nestedRecord(body, "properties");
	const diagnostics: string[] = [];
	const wantedTenant = optionalString(context.desired, "tenantId");
	const actualTenant = optionalString(properties, "tenantId");
	if (
		wantedTenant !== undefined &&
		actualTenant !== undefined &&
		wantedTenant.toLowerCase() !== actualTenant.toLowerCase()
	) {
		diagnostics.push(
			"the vault's tenantId differs from the declared one; a vault's tenant is fixed at creation and this resolver never replaces a vault, so the drift is reported for a human",
		);
	}
	const wantedLocation = optionalString(context.desired, "location");
	const actualLocation = optionalString(body, "location");
	if (
		wantedLocation !== undefined &&
		actualLocation !== undefined &&
		wantedLocation.toLowerCase() !== actualLocation.toLowerCase()
	) {
		diagnostics.push(
			`the vault is in ${actualLocation} but location asks for ${wantedLocation}; an Azure resource's location is immutable and this resolver never replaces a vault, so the drift is reported rather than corrected`,
		);
	}
	return diagnostics;
}

const KEY_VAULT_SPEC: Omit<AzureResolverSpec, "productId"> = {
	nameKeys: ["vaultName", "name"],
	async read(context) {
		const suffix = keyVaultSuffix(context.name);
		const observed = await armGet(
			context,
			groupPath(context, suffix),
			AZURE_KEY_VAULT_API_VERSION,
			`key vault ${context.name}`,
		);
		if (observed === undefined) return undefined;
		return outcome(
			settledAction(context),
			resourceId(context, suffix),
			keyVaultOutputs(context.name, observed),
			keyVaultImmutableDiagnostics(context, observed),
		);
	},
	async reconcile(context) {
		const suffix = keyVaultSuffix(context.name);
		const path = groupPath(context, suffix);
		const id = resourceId(context, suffix);
		const label = `key vault ${context.name}`;

		const observed = await armGet(
			context,
			path,
			AZURE_KEY_VAULT_API_VERSION,
			label,
		);
		if (observed === undefined) {
			const location = requiredDesired(
				context,
				"location",
				AZURE_KEY_VAULT_PRODUCT_ID,
				"ARM requires a location on a vault create and there is no safe default region",
			);
			const tenantId = requiredDesired(
				context,
				"tenantId",
				AZURE_KEY_VAULT_PRODUCT_ID,
				"a vault is bound to exactly one Entra tenant at creation and ARM requires it",
			);
			const skuName = optionalString(context.desired, "skuName");
			const rbac = optionalBoolean(context.desired, "rbacAuthorization");
			const purge = optionalBoolean(context.desired, "purgeProtection");
			const created = await settleWrite(
				context,
				await callArm(context, {
					method: "PUT",
					url: azureArmUrl(path, AZURE_KEY_VAULT_API_VERSION),
					json: {
						location,
						properties: {
							sku: {
								family: "A",
								name: skuName ?? KEY_VAULT_FALLBACK_SKU,
							},
							tenantId,
							...(rbac !== undefined
								? { enableRbacAuthorization: rbac }
								: undefined),
							...(purge === true ? { enablePurgeProtection: true } : undefined),
						},
					},
				}),
				path,
				AZURE_KEY_VAULT_API_VERSION,
				label,
			);
			const diagnostics: string[] = [
				"Key Vault names are globally unique and a deleted vault keeps its name for the soft-delete retention period; if this create is refused as a conflict the previous vault must be recovered or purged by a human, which this resolver will not do on its own",
			];
			if (skuName === undefined) {
				diagnostics.push(
					`skuName was not declared, and ARM requires one: the vault was created at the ${KEY_VAULT_FALLBACK_SKU} tier. Declare skuName to choose deliberately — this resolver never changes an existing vault's tier`,
				);
			}
			return outcome(
				"create",
				id,
				keyVaultOutputs(context.name, created.body),
				[...diagnostics, ...created.diagnostics],
			);
		}

		const properties = nestedRecord(observed, "properties");
		const { patch, diagnostics } = keyVaultDeltas(context, properties);
		const immutable = keyVaultImmutableDiagnostics(context, observed);
		if (Object.keys(patch).length === 0) {
			return outcome(
				settledAction(context),
				id,
				keyVaultOutputs(context.name, observed),
				[...immutable, ...diagnostics],
			);
		}
		const updated = await settleWrite(
			context,
			await callArm(context, {
				method: "PATCH",
				url: azureArmUrl(path, AZURE_KEY_VAULT_API_VERSION),
				json: { properties: patch },
			}),
			path,
			AZURE_KEY_VAULT_API_VERSION,
			label,
		);
		return outcome("update", id, keyVaultOutputs(context.name, updated.body), [
			...immutable,
			...diagnostics,
			`vault properties updated: ${Object.keys(patch).sort(compareStrings).join(", ")}`,
			...updated.diagnostics,
		]);
	},
	async remove(context) {
		await armDelete(
			context,
			groupPath(context, keyVaultSuffix(context.name)),
			AZURE_KEY_VAULT_API_VERSION,
			`key vault ${context.name}`,
		);
	},
};

// ---------------------------------------------------------------------------
// Cosmos DB — Microsoft.DocumentDB
// ---------------------------------------------------------------------------

function cosmosSuffix(name: string): string {
	return `/providers/Microsoft.DocumentDB/databaseAccounts/${encodeURIComponent(name)}`;
}

/** The binding's consistency vocabulary to ARM's. Kept explicit so a new
 *  binding value fails loudly instead of being passed through unrecognized. */
const COSMOS_CONSISTENCY_BY_BINDING: Readonly<Record<string, string>> =
	Object.freeze({
		"bounded-staleness": "BoundedStaleness",
		"consistent-prefix": "ConsistentPrefix",
		eventual: "Eventual",
		session: "Session",
		strong: "Strong",
	});

function cosmosConsistencyPolicy(
	context: AzureResolverContext,
): JsonObject | undefined {
	const level = optionalString(context.desired, "consistencyLevel");
	if (level === undefined) return undefined;
	const armLevel = COSMOS_CONSISTENCY_BY_BINDING[level];
	if (armLevel === undefined) {
		throw new ResolverError(
			"RESOLVER_PRODUCT_UNSUPPORTED",
			`${AZURE_COSMOS_DB_PRODUCT_ID}: consistencyLevel ${JSON.stringify(level)} is not one of ${Object.keys(COSMOS_CONSISTENCY_BY_BINDING).sort(compareStrings).join(", ")}`,
			AZURE_COSMOS_DB_PRODUCT_ID,
		);
	}
	if (armLevel !== "BoundedStaleness") {
		return { defaultConsistencyLevel: armLevel };
	}
	const maxStalenessPrefix = optionalInteger(
		context.desired,
		"maxStalenessPrefix",
	);
	const maxIntervalInSeconds = optionalInteger(
		context.desired,
		"maxIntervalInSeconds",
	);
	if (maxStalenessPrefix === undefined || maxIntervalInSeconds === undefined) {
		throw new ResolverError(
			"RESOLVER_PRODUCT_UNSUPPORTED",
			`${AZURE_COSMOS_DB_PRODUCT_ID}: consistencyLevel "bounded-staleness" additionally requires desired.maxStalenessPrefix and desired.maxIntervalInSeconds — ARM refuses a bounded-staleness policy without both, and this resolver will not invent a staleness bound`,
			AZURE_COSMOS_DB_PRODUCT_ID,
		);
	}
	return {
		defaultConsistencyLevel: armLevel,
		maxIntervalInSeconds,
		maxStalenessPrefix,
	};
}

function cosmosOutputs(name: string, body: JsonObject | undefined): JsonObject {
	const properties =
		body === undefined ? undefined : nestedRecord(body, "properties");
	const endpoint = optionalString(properties, "documentEndpoint");
	const state = optionalString(properties, "provisioningState");
	const consistency = optionalString(
		nestedRecord(properties, "consistencyPolicy"),
		"defaultConsistencyLevel",
	);
	return {
		accountName: name,
		...(consistency !== undefined
			? { defaultConsistencyLevel: consistency }
			: undefined),
		...(endpoint !== undefined ? { documentEndpoint: endpoint } : undefined),
		...(state !== undefined ? { provisioningState: state } : undefined),
	};
}

/** Serverless is a capability flag, and capabilities are fixed at create. */
function cosmosImmutableDiagnostics(
	context: AzureResolverContext,
	body: JsonObject,
): readonly string[] {
	const diagnostics: string[] = [];
	const mode = optionalString(context.desired, "throughputMode");
	if (mode !== undefined) {
		const capabilities = nestedRecord(body, "properties").capabilities;
		const names = Array.isArray(capabilities)
			? capabilities
					.filter(isJsonObject)
					.map((entry) => optionalString(entry, "name"))
			: [];
		const serverless = names.includes("EnableServerless");
		if ((mode === "serverless") !== serverless) {
			diagnostics.push(
				`the account's serverless capability is ${String(serverless)} but throughputMode asks for ${JSON.stringify(mode)}; Cosmos DB capacity mode is fixed when the account is created and this resolver never replaces an account, so the drift is reported for a human`,
			);
		}
	}
	const wantedLocation = optionalString(context.desired, "location");
	const actualLocation = optionalString(body, "location");
	if (
		wantedLocation !== undefined &&
		actualLocation !== undefined &&
		wantedLocation.toLowerCase() !== actualLocation.toLowerCase()
	) {
		diagnostics.push(
			`the account's write region is ${actualLocation} but location asks for ${wantedLocation}; changing it is a failover operation this resolver does not perform, so the drift is reported rather than corrected`,
		);
	}
	return diagnostics;
}

const COSMOS_DB_SPEC: Omit<AzureResolverSpec, "productId"> = {
	async read(context) {
		const suffix = cosmosSuffix(context.name);
		const observed = await armGet(
			context,
			groupPath(context, suffix),
			AZURE_COSMOS_API_VERSION,
			`cosmos account ${context.name}`,
		);
		if (observed === undefined) return undefined;
		return outcome(
			settledAction(context),
			resourceId(context, suffix),
			cosmosOutputs(context.name, observed),
			cosmosImmutableDiagnostics(context, observed),
		);
	},
	async reconcile(context) {
		const suffix = cosmosSuffix(context.name);
		const path = groupPath(context, suffix);
		const id = resourceId(context, suffix);
		const label = `cosmos account ${context.name}`;
		const consistencyPolicy = cosmosConsistencyPolicy(context);
		const multiRegionWrites = optionalBoolean(
			context.desired,
			"multiRegionWrites",
		);

		const observed = await armGet(
			context,
			path,
			AZURE_COSMOS_API_VERSION,
			label,
		);
		if (observed === undefined) {
			const location = requiredDesired(
				context,
				"location",
				AZURE_COSMOS_DB_PRODUCT_ID,
				"ARM requires a write region on a database-account create and there is no safe default region",
			);
			const serverless =
				optionalString(context.desired, "throughputMode") === "serverless";
			const created = await settleWrite(
				context,
				await callArm(context, {
					method: "PUT",
					url: azureArmUrl(path, AZURE_COSMOS_API_VERSION),
					json: {
						kind: "GlobalDocumentDB",
						location,
						properties: {
							databaseAccountOfferType: "Standard",
							locations: [{ failoverPriority: 0, locationName: location }],
							...(consistencyPolicy !== undefined
								? { consistencyPolicy }
								: undefined),
							...(serverless
								? { capabilities: [{ name: "EnableServerless" }] }
								: undefined),
							...(multiRegionWrites !== undefined
								? { enableMultipleWriteLocations: multiRegionWrites }
								: undefined),
						},
					},
				}),
				path,
				AZURE_COSMOS_API_VERSION,
				label,
			);
			return outcome(
				"create",
				id,
				cosmosOutputs(context.name, created.body),
				created.diagnostics,
			);
		}

		const properties = nestedRecord(observed, "properties");
		const immutable = cosmosImmutableDiagnostics(context, observed);
		const patch = {};
		if (consistencyPolicy !== undefined) {
			const current = nestedRecord(properties, "consistencyPolicy");
			const sameLevel =
				optionalString(current, "defaultConsistencyLevel") ===
				consistencyPolicy.defaultConsistencyLevel;
			const samePrefix =
				consistencyPolicy.maxStalenessPrefix === undefined ||
				optionalInteger(current, "maxStalenessPrefix") ===
					consistencyPolicy.maxStalenessPrefix;
			const sameInterval =
				consistencyPolicy.maxIntervalInSeconds === undefined ||
				optionalInteger(current, "maxIntervalInSeconds") ===
					consistencyPolicy.maxIntervalInSeconds;
			if (!(sameLevel && samePrefix && sameInterval)) {
				Object.assign(patch, { consistencyPolicy });
			}
		}
		if (
			multiRegionWrites !== undefined &&
			optionalBoolean(properties, "enableMultipleWriteLocations") !==
				multiRegionWrites
		) {
			Object.assign(patch, {
				enableMultipleWriteLocations: multiRegionWrites,
			});
		}
		if (Object.keys(patch).length === 0) {
			return outcome(
				settledAction(context),
				id,
				cosmosOutputs(context.name, observed),
				immutable,
			);
		}
		const updated = await settleWrite(
			context,
			await callArm(context, {
				method: "PATCH",
				url: azureArmUrl(path, AZURE_COSMOS_API_VERSION),
				json: { properties: patch },
			}),
			path,
			AZURE_COSMOS_API_VERSION,
			label,
		);
		return outcome("update", id, cosmosOutputs(context.name, updated.body), [
			...immutable,
			`database account properties updated: ${Object.keys(patch).sort(compareStrings).join(", ")}`,
			...updated.diagnostics,
		]);
	},
	async remove(context) {
		await armDelete(
			context,
			groupPath(context, cosmosSuffix(context.name)),
			AZURE_COSMOS_API_VERSION,
			`cosmos account ${context.name}`,
		);
	},
};

// ---------------------------------------------------------------------------
// Container Apps — Microsoft.App
// ---------------------------------------------------------------------------

function containerAppSuffix(name: string): string {
	return `/providers/Microsoft.App/containerApps/${encodeURIComponent(name)}`;
}

/**
 * The template this resolver owns. Container Apps `template` is replaced
 * wholesale by a write rather than merged, so the resolver states the whole
 * thing from the binding — which is honest only because the binding is what
 * names the image, the resources and the replica range.
 */
function containerAppTemplate(
	context: AzureResolverContext,
	image: string,
): JsonObject {
	const cpu = optionalNumber(context.desired, "cpu");
	const memory = optionalString(context.desired, "memory");
	if ((cpu === undefined) !== (memory === undefined)) {
		throw new ResolverError(
			"RESOLVER_PRODUCT_UNSUPPORTED",
			`${AZURE_CONTAINER_APPS_PRODUCT_ID}: cpu and memory must be declared together — Container Apps only accepts a matched cpu/memory pair, and supplying one without the other is refused by ARM`,
			AZURE_CONTAINER_APPS_PRODUCT_ID,
		);
	}
	const minReplicas = optionalInteger(context.desired, "minReplicas");
	const maxReplicas = optionalInteger(context.desired, "maxReplicas");
	const scale = {};
	if (minReplicas !== undefined) {
		Object.assign(scale, { minReplicas });
	}
	if (maxReplicas !== undefined) {
		Object.assign(scale, { maxReplicas });
	}
	return {
		containers: [
			{
				image,
				name: context.name,
				...(cpu !== undefined && memory !== undefined
					? { resources: { cpu, memory } }
					: undefined),
			},
		],
		...(Object.keys(scale).length > 0 ? { scale } : undefined),
	};
}

/**
 * `null` is the ARM way to say "no ingress"; omitting the key would leave an
 * existing ingress in place, which is a different statement than the binding's
 * `ingress: "none"`.
 */
function containerAppIngress(
	context: AzureResolverContext,
): JsonValue | undefined {
	const ingress = optionalString(context.desired, "ingress");
	if (ingress === undefined) return undefined;
	if (ingress === "none") return null;
	if (ingress !== "external" && ingress !== "internal") {
		throw new ResolverError(
			"RESOLVER_PRODUCT_UNSUPPORTED",
			`${AZURE_CONTAINER_APPS_PRODUCT_ID}: ingress ${JSON.stringify(ingress)} is not one of external, internal, none`,
			AZURE_CONTAINER_APPS_PRODUCT_ID,
		);
	}
	const targetPort = optionalInteger(context.desired, "targetPort");
	if (targetPort === undefined) {
		throw new ResolverError(
			"RESOLVER_PRODUCT_UNSUPPORTED",
			`${AZURE_CONTAINER_APPS_PRODUCT_ID}: desired.targetPort is required when ingress is ${JSON.stringify(ingress)} — ARM refuses an ingress without one, and guessing a port would publish the wrong thing`,
			AZURE_CONTAINER_APPS_PRODUCT_ID,
		);
	}
	return { external: ingress === "external", targetPort };
}

function containerAppOutputs(
	context: AzureResolverContext,
	body: JsonObject | undefined,
): JsonObject {
	const name = context.name;
	const expected = resourceId(context, containerAppSuffix(name));
	if (
		body !== undefined &&
		optionalString(body, "id")?.toLowerCase() !== expected.toLowerCase()
	)
		throw new ResolverError(
			"RESOLVER_OUTPUT_UNPARSEABLE",
			"Container App response identity differs from requested scope",
		);
	assertContainerAppOwnership(context, body);
	const properties =
		body === undefined ? undefined : nestedRecord(body, "properties");
	const state = optionalString(properties, "provisioningState");
	const revision = optionalString(properties, "latestRevisionName");
	const fqdn = optionalString(
		nestedRecord(nestedRecord(properties, "configuration"), "ingress"),
		"fqdn",
	);
	const readyRevision = optionalString(properties, "latestReadyRevisionName");
	const image = optionalString(context.desired, "image");
	const artifact = containerAppArtifact(context);
	const nativeArtifact = nestedRecord(body, "tags")["hobo.artifact"];
	const confirmed = state?.toLowerCase() === "succeeded";
	const ready =
		containerAppOwnership(context) !== undefined &&
		artifact !== undefined &&
		nativeArtifact === artifact &&
		confirmed &&
		optionalString(properties, "runningStatus") === "Running" &&
		revision !== undefined &&
		readyRevision === revision &&
		image !== undefined &&
		optionalString(body, "location")?.toLowerCase() ===
			optionalString(context.desired, "location")?.toLowerCase() &&
		optionalString(properties, "managedEnvironmentId")?.toLowerCase() ===
			optionalString(context.desired, "managedEnvironmentId")?.toLowerCase() &&
		containerAppSettled(
			context,
			properties ?? {},
			image,
			containerAppIngress(context),
		);
	const result: JsonObject = {
		appName: name,
		ready,
		operationConfirmed: confirmed,
		lifecycleStatus: ready
			? "ready"
			: state?.toLowerCase() === "failed"
				? "failed"
				: "pending",
		...(fqdn !== undefined ? { fqdn } : undefined),
		...(revision !== undefined ? { latestRevisionName: revision } : undefined),
		...(state !== undefined ? { provisioningState: state } : undefined),
	};
	const containers = nestedRecord(properties, "template").containers;
	if (
		ready &&
		fqdn &&
		fqdn.length <= 253 &&
		/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+azurecontainerapps\.io$/iu.test(
			fqdn,
		)
	)
		Object.assign(result, {
			servingEndpoint: `https://${fqdn.toLowerCase()}/`,
		});
	const observedImage =
		isJsonArray(containers) && isJsonObject(containers[0])
			? optionalString(containers[0], "image")
			: undefined;
	const contentDigest = observedImage?.match(/@(sha256:[a-f0-9]{64})$/u)?.[1];
	if (contentDigest !== undefined)
		Object.assign(result, { artifactDigest: contentDigest });
	if (isJsonString(nativeArtifact))
		Object.assign(result, { artifactMarker: nativeArtifact });
	return result;
}

function containerAppImmutableDiagnostics(
	context: AzureResolverContext,
	body: JsonObject,
): readonly string[] {
	const properties = nestedRecord(body, "properties");
	const diagnostics: string[] = [];
	const wantedEnvironment = optionalString(
		context.desired,
		"managedEnvironmentId",
	);
	const actualEnvironment = optionalString(properties, "managedEnvironmentId");
	if (
		wantedEnvironment !== undefined &&
		actualEnvironment !== undefined &&
		wantedEnvironment.toLowerCase() !== actualEnvironment.toLowerCase()
	) {
		diagnostics.push(
			"the app is in a different managed environment than the declared one; moving a Container App between environments is a delete-and-recreate and this resolver never replaces an app, so the drift is reported for a human",
		);
	}
	const wantedLocation = optionalString(context.desired, "location");
	const actualLocation = optionalString(body, "location");
	if (
		wantedLocation !== undefined &&
		actualLocation !== undefined &&
		wantedLocation.toLowerCase() !== actualLocation.toLowerCase()
	) {
		diagnostics.push(
			`the app is in ${actualLocation} but location asks for ${wantedLocation}; an Azure resource's location is immutable and this resolver never replaces an app, so the drift is reported rather than corrected`,
		);
	}
	return diagnostics;
}

/** True when the observed app already runs the declared image and shape. */
function containerAppSettled(
	context: AzureResolverContext,
	properties: JsonObject,
	image: string,
	ingress: JsonValue | undefined,
): boolean {
	const template = nestedRecord(properties, "template");
	const containers = template.containers;
	if (
		containerAppOwnership(context) !== undefined &&
		(!isJsonArray(containers) ||
			containers.length !== 1 ||
			(template.initContainers !== undefined &&
				(!isJsonArray(template.initContainers) ||
					template.initContainers.length > 0)))
	)
		return false;
	const first: JsonObject =
		isJsonArray(containers) && isJsonObject(containers[0]) ? containers[0] : {};
	if (optionalString(first, "image") !== image) return false;

	const resources = nestedRecord(first, "resources");
	const cpu = optionalNumber(context.desired, "cpu");
	const memory = optionalString(context.desired, "memory");
	if (cpu !== undefined && optionalNumber(resources, "cpu") !== cpu) {
		return false;
	}
	const observedMemory = optionalString(resources, "memory");
	if (
		memory !== undefined &&
		(observedMemory === undefined ||
			!/^[0-9]+(?:\.[0-9]+)?Gi$/u.test(observedMemory) ||
			Number.parseFloat(observedMemory) !== Number.parseFloat(memory))
	) {
		return false;
	}

	const scale = nestedRecord(template, "scale");
	const minReplicas = optionalInteger(context.desired, "minReplicas");
	if (
		minReplicas !== undefined &&
		optionalInteger(scale, "minReplicas") !== minReplicas
	) {
		return false;
	}
	const maxReplicas = optionalInteger(context.desired, "maxReplicas");
	if (
		maxReplicas !== undefined &&
		optionalInteger(scale, "maxReplicas") !== maxReplicas
	) {
		return false;
	}

	if (ingress === undefined) return true;
	const observedIngress = nestedRecord(
		nestedRecord(properties, "configuration"),
		"ingress",
	);
	const hasIngress = Object.keys(observedIngress).length > 0;
	if (ingress === null) return !hasIngress;
	if (!isJsonObject(ingress)) return true;
	return (
		hasIngress &&
		optionalBoolean(observedIngress, "external") === ingress.external &&
		optionalInteger(observedIngress, "targetPort") === ingress.targetPort
	);
}

const CONTAINER_APPS_SPEC: Omit<AzureResolverSpec, "productId"> = {
	async read(context) {
		assertContainerAppScope(context);
		const suffix = containerAppSuffix(context.name);
		const observed = await armGet(
			context,
			groupPath(context, suffix),
			AZURE_CONTAINER_APPS_API_VERSION,
			`container app ${context.name}`,
		);
		if (observed === undefined) return undefined;
		return outcome(
			settledAction(context),
			resourceId(context, suffix),
			containerAppOutputs(context, observed),
			containerAppImmutableDiagnostics(context, observed),
		);
	},
	async reconcile(context) {
		assertContainerAppScope(context);
		const suffix = containerAppSuffix(context.name);
		const path = groupPath(context, suffix);
		const id = resourceId(context, suffix);
		const label = `container app ${context.name}`;
		const image = requiredDesired(
			context,
			"image",
			AZURE_CONTAINER_APPS_PRODUCT_ID,
			"a Container App revision is defined by its container image and ARM refuses a template without one",
		);
		const ingress = containerAppIngress(context);
		const template = containerAppTemplate(context, image);

		const observed = await armGet(
			context,
			path,
			AZURE_CONTAINER_APPS_API_VERSION,
			label,
		);
		assertContainerAppOwnership(context, observed);
		if (
			observed !== undefined &&
			containerAppArtifact(context) !== undefined &&
			nestedRecord(observed, "tags")["hobo.artifact"] !==
				containerAppArtifact(context)
		)
			throw new ResolverError(
				"RESOLVER_PRODUCT_UNSUPPORTED",
				"Container App artifact differs; use a new immutable target name rather than overwriting an older deployment",
			);
		if (observed === undefined) {
			const location = requiredDesired(
				context,
				"location",
				AZURE_CONTAINER_APPS_PRODUCT_ID,
				"ARM requires a location on a Container App create and there is no safe default region",
			);
			const managedEnvironmentId = requiredDesired(
				context,
				"managedEnvironmentId",
				AZURE_CONTAINER_APPS_PRODUCT_ID,
				"a Container App runs inside a managed environment, and this resolver never creates one on the caller's behalf",
			);
			const body = {
				location,
				properties: {
					managedEnvironmentId,
					template,
					...(ingress === undefined
						? undefined
						: { configuration: { ingress } }),
				},
			};
			const owner = containerAppOwnership(context);
			if (owner !== undefined)
				Object.assign(body, {
					tags: {
						"hobo.owner": owner,
						"hobo.artifact": containerAppArtifact(context),
					},
				});
			const created = await settleWrite(
				context,
				await callArm(context, {
					method: "PUT",
					url: azureArmUrl(path, AZURE_CONTAINER_APPS_API_VERSION),
					json: body,
				}),
				path,
				AZURE_CONTAINER_APPS_API_VERSION,
				label,
			);
			return outcome(
				"create",
				id,
				containerAppOutputs(context, created.body),
				created.diagnostics,
			);
		}

		const properties = nestedRecord(observed, "properties");
		const immutable = containerAppImmutableDiagnostics(context, observed);
		if (containerAppSettled(context, properties, image, ingress)) {
			return outcome(
				settledAction(context),
				id,
				containerAppOutputs(context, observed),
				immutable,
			);
		}
		const updated = await settleWrite(
			context,
			await callArm(context, {
				method: "PATCH",
				url: azureArmUrl(path, AZURE_CONTAINER_APPS_API_VERSION),
				json: {
					properties: {
						template,
						...(ingress === undefined
							? undefined
							: { configuration: { ingress } }),
					},
				},
			}),
			path,
			AZURE_CONTAINER_APPS_API_VERSION,
			label,
		);
		return outcome("update", id, containerAppOutputs(context, updated.body), [
			...immutable,
			"container template applied: the Container Apps template is replaced wholesale by a write, so any revision field this binding does not name is reset to the platform default",
			...updated.diagnostics,
		]);
	},
	async remove(context) {
		assertContainerAppScope(context);
		const existing = await armGet(
			context,
			groupPath(context, containerAppSuffix(context.name)),
			AZURE_CONTAINER_APPS_API_VERSION,
			`container app ${context.name}`,
		);
		if (existing === undefined) return;
		containerAppOutputs(context, existing);
		if (
			containerAppArtifact(context) !== undefined &&
			nestedRecord(existing, "tags")["hobo.artifact"] !==
				containerAppArtifact(context)
		)
			throw new ResolverError(
				"RESOLVER_PROVIDER_REJECTED",
				"Container App retirement artifact no longer matches the approved source",
			);
		await armDelete(
			context,
			groupPath(context, containerAppSuffix(context.name)),
			AZURE_CONTAINER_APPS_API_VERSION,
			`container app ${context.name}`,
		);
	},
};

function assertContainerAppScope(context: AzureResolverContext): void {
	containerAppOwnership(context);
	containerAppArtifact(context);
	validateContainerAppSettings(context);
	const expected = resourceId(context, containerAppSuffix(context.name));
	if (
		context.knownPhysicalId !== undefined &&
		context.knownPhysicalId.toLowerCase() !== expected.toLowerCase()
	)
		throw new ResolverError(
			"RESOLVER_PRODUCT_UNSUPPORTED",
			"Container App physical identity differs from requested resource scope",
		);
}

function validateContainerAppSettings(context: AzureResolverContext): void {
	if (containerAppOwnership(context) !== undefined) {
		for (const key of ["location", "managedEnvironmentId"])
			if (!optionalString(context.desired, key))
				throw new ResolverError(
					"RESOLVER_PRODUCT_UNSUPPORTED",
					`Budgeted Container Apps require explicit ${key}`,
				);
		const allowed = new Set([
			"name",
			"image",
			"location",
			"managedEnvironmentId",
			"cpu",
			"memory",
			"minReplicas",
			"maxReplicas",
			"ingress",
			"targetPort",
			"ownershipRef",
			"artifactDigest",
		]);
		for (const key of Object.keys(context.desired))
			if (!allowed.has(key))
				throw new ResolverError(
					"RESOLVER_PRODUCT_UNSUPPORTED",
					`Budgeted Container Apps do not implement desired.${key}; unhandled bindings cannot be silently omitted`,
				);
		if (
			!/^[A-Za-z0-9][A-Za-z0-9._:/-]*@sha256:[a-f0-9]{64}$/u.test(
				optionalString(context.desired, "image") ?? "",
			)
		)
			throw new ResolverError(
				"RESOLVER_PRODUCT_UNSUPPORTED",
				"Budgeted Container Apps require an immutable sha256 container image",
			);
	}
	const cpu = optionalNumber(context.desired, "cpu"),
		memory = optionalString(context.desired, "memory");
	if (context.desired.cpu !== undefined && (cpu === undefined || cpu <= 0))
		throw new ResolverError(
			"RESOLVER_PRODUCT_UNSUPPORTED",
			"Container App CPU must be a positive finite quantity",
		);
	if (
		context.desired.memory !== undefined &&
		(!memory ||
			!/^[0-9]+(?:\.[0-9]+)?Gi$/u.test(memory) ||
			Number.parseFloat(memory) <= 0)
	)
		throw new ResolverError(
			"RESOLVER_PRODUCT_UNSUPPORTED",
			"Container App memory must be an explicit positive Gi quantity",
		);
	for (const key of ["minReplicas", "maxReplicas", "targetPort"]) {
		const value = optionalInteger(context.desired, key);
		if (
			context.desired[key] !== undefined &&
			(value === undefined ||
				value < (key === "minReplicas" ? 0 : 1) ||
				(key === "targetPort" && value > 65535))
		)
			throw new ResolverError(
				"RESOLVER_PRODUCT_UNSUPPORTED",
				`Container App ${key} must be a bounded integer`,
			);
	}
	const min = optionalInteger(context.desired, "minReplicas"),
		max = optionalInteger(context.desired, "maxReplicas");
	if (min !== undefined && max !== undefined && min > max)
		throw new ResolverError(
			"RESOLVER_PRODUCT_UNSUPPORTED",
			"Container App minimum replicas exceeds its bounded maximum",
		);
	if (
		containerAppOwnership(context) !== undefined &&
		[
			"cpu",
			"memory",
			"minReplicas",
			"maxReplicas",
			"location",
			"managedEnvironmentId",
		].some((key) => context.desired[key] === undefined)
	)
		throw new ResolverError(
			"RESOLVER_PRODUCT_UNSUPPORTED",
			"Budgeted Container Apps require explicit CPU, memory, minReplicas and maxReplicas bounds",
		);
}

function containerAppArtifact(
	context: AzureResolverContext,
): string | undefined {
	const artifact = optionalString(context.desired, "artifactDigest");
	if (
		(context.desired.artifactDigest !== undefined ||
			context.desired.ownershipRef !== undefined) &&
		(!artifact || !/^sha256:[a-f0-9]{64}$/u.test(artifact))
	)
		throw new ResolverError(
			"RESOLVER_PRODUCT_UNSUPPORTED",
			"Container App artifactDigest must pin the complete approved sha256 artifact",
		);
	return artifact;
}

function containerAppOwnership(
	context: AzureResolverContext,
): string | undefined {
	const owner = optionalString(context.desired, "ownershipRef");
	if (
		context.desired.ownershipRef !== undefined &&
		(!owner || !/^sha256:[a-f0-9]{64}$/u.test(owner))
	)
		throw new ResolverError(
			"RESOLVER_PRODUCT_UNSUPPORTED",
			"Container App ownershipRef must be a complete sha256 ownership identity",
		);
	return owner;
}

function assertContainerAppOwnership(
	context: AzureResolverContext,
	body: JsonObject | undefined,
): void {
	const owner = containerAppOwnership(context);
	if (
		owner !== undefined &&
		body !== undefined &&
		nestedRecord(body, "tags")["hobo.owner"] !== owner
	)
		throw new ResolverError(
			"RESOLVER_PROVIDER_REJECTED",
			"Container App has different or missing ownership metadata; implicit adoption is forbidden",
		);
}

// ---------------------------------------------------------------------------
// Azure Cache for Redis — Microsoft.Cache
// ---------------------------------------------------------------------------

function redisSuffix(name: string): string {
	return `/providers/Microsoft.Cache/redis/${encodeURIComponent(name)}`;
}

/**
 * The sku family each tier belongs to. ARM wants `name`, `family` and
 * `capacity` as three separate fields, and the family is a function of the
 * tier — but not one to compute by taking a first letter: `Basic` and
 * `Standard` are both family `C`, and only `Premium` is `P`. Written as a map
 * so an unrecognized tier is refused rather than silently sent with a family
 * ARM will reject in a less legible way.
 */
const REDIS_FAMILY_BY_SKU: Readonly<Record<string, string>> = Object.freeze({
	Basic: "C",
	Premium: "P",
	Standard: "C",
});

/** The sku tier as ARM spells it, from however the binding spelled it. */
function redisSkuName(context: AzureResolverContext): string | undefined {
	const value = optionalString(context.desired, "skuName");
	if (value === undefined) return undefined;
	const canonical = Object.keys(REDIS_FAMILY_BY_SKU).find(
		(name) => name.toLowerCase() === value.toLowerCase(),
	);
	if (canonical === undefined) {
		throw new ResolverError(
			"RESOLVER_PRODUCT_UNSUPPORTED",
			`${AZURE_REDIS_CACHE_PRODUCT_ID}: skuName ${JSON.stringify(value)} is not one of ${Object.keys(REDIS_FAMILY_BY_SKU).sort(compareStrings).join(", ")}`,
			AZURE_REDIS_CACHE_PRODUCT_ID,
		);
	}
	return canonical;
}

function redisOutputs(name: string, body: JsonObject | undefined): JsonObject {
	const properties =
		body === undefined ? undefined : nestedRecord(body, "properties");
	const sku = nestedRecord(properties, "sku");
	const hostName = optionalString(properties, "hostName");
	const sslPort = optionalInteger(properties, "sslPort");
	const state = optionalString(properties, "provisioningState");
	const skuName = optionalString(sku, "name");
	const capacity = optionalInteger(sku, "capacity");
	const shardCount = optionalInteger(properties, "shardCount");
	const version = optionalString(properties, "redisVersion");
	return {
		cacheName: name,
		...(hostName !== undefined ? { hostName } : undefined),
		...(sslPort !== undefined ? { sslPort } : undefined),
		...(state !== undefined ? { provisioningState: state } : undefined),
		...(skuName !== undefined ? { skuName } : undefined),
		...(capacity !== undefined ? { capacity } : undefined),
		...(shardCount !== undefined ? { shardCount } : undefined),
		...(version !== undefined ? { redisVersion: version } : undefined),
	};
}

/**
 * Clustering is a Premium-only feature and it cannot be turned off once on, so
 * both halves are refusals rather than silent no-ops: asking for a cluster on a
 * tier that cannot host one would fail at ARM with a less legible message, and
 * "un-clustering" is not something a PATCH can do.
 */
function redisShardCount(
	context: AzureResolverContext,
	skuName: string | undefined,
): number | undefined {
	if (optionalBoolean(context.desired, "clustered") !== true) return undefined;
	if (skuName !== "Premium") {
		throw new ResolverError(
			"RESOLVER_PRODUCT_UNSUPPORTED",
			`${AZURE_REDIS_CACHE_PRODUCT_ID}: clustered asks for a clustered cache, but Azure offers clustering only on the Premium tier and this request names ${skuName === undefined ? "no skuName" : JSON.stringify(skuName)}. Set skuName to "Premium", or drop clustered`,
			AZURE_REDIS_CACHE_PRODUCT_ID,
		);
	}
	return 1;
}

/** Fields fixed when the cache was created, reported rather than corrected. */
function redisImmutableDiagnostics(
	context: AzureResolverContext,
	body: JsonObject,
): readonly string[] {
	const diagnostics: string[] = [];
	const properties = nestedRecord(body, "properties");
	const sku = nestedRecord(properties, "sku");
	const wantedSku = redisSkuName(context);
	const actualSku = optionalString(sku, "name");
	if (
		wantedSku !== undefined &&
		actualSku !== undefined &&
		wantedSku !== actualSku
	) {
		diagnostics.push(
			`the cache is on the ${actualSku} tier but skuName asks for ${wantedSku}; a tier change is a migration with a service interruption, not a field write, so it is reported for a human rather than applied here`,
		);
	}
	const wantedLocation = optionalString(context.desired, "location");
	const actualLocation = optionalString(body, "location");
	if (
		wantedLocation !== undefined &&
		actualLocation !== undefined &&
		wantedLocation.toLowerCase() !== actualLocation.toLowerCase()
	) {
		diagnostics.push(
			`the cache is in ${actualLocation} but location asks for ${wantedLocation}; an Azure resource's location is immutable and this resolver never replaces a cache, so the drift is reported rather than corrected`,
		);
	}
	if (
		optionalBoolean(context.desired, "clustered") === false &&
		(optionalInteger(properties, "shardCount") ?? 0) > 0
	) {
		diagnostics.push(
			"clustered asks for false but the cache already has shards; Azure has no path back from a clustered Premium cache, so the drift is reported rather than corrected — recreating the cache is the only route, and this resolver never replaces one",
		);
	}
	return diagnostics;
}

const REDIS_CACHE_SPEC: Omit<AzureResolverSpec, "productId"> = {
	nameKeys: ["cacheName", "name"],
	async read(context) {
		const suffix = redisSuffix(context.name);
		const observed = await armGet(
			context,
			groupPath(context, suffix),
			AZURE_CACHE_API_VERSION,
			`redis cache ${context.name}`,
		);
		if (observed === undefined) return undefined;
		return outcome(
			settledAction(context),
			resourceId(context, suffix),
			redisOutputs(context.name, observed),
			redisImmutableDiagnostics(context, observed),
		);
	},
	async reconcile(context) {
		const suffix = redisSuffix(context.name);
		const path = groupPath(context, suffix);
		const id = resourceId(context, suffix);
		const label = `redis cache ${context.name}`;

		const observed = await armGet(
			context,
			path,
			AZURE_CACHE_API_VERSION,
			label,
		);
		if (observed === undefined) {
			const location = requiredDesired(
				context,
				"location",
				AZURE_REDIS_CACHE_PRODUCT_ID,
				"ARM requires a location on a cache create and there is no safe default region",
			);
			// The tier is refused rather than defaulted: every Azure Cache tier is
			// billed, they differ by an order of magnitude, and there is no free one
			// to fall back to. The *capacity within* a named tier is a different
			// question — the caller already chose the tier, and 0 is that tier's
			// documented floor — so it defaults visibly instead.
			const skuName = requiredDesired(
				context,
				"skuName",
				AZURE_REDIS_CACHE_PRODUCT_ID,
				'every Azure Cache for Redis tier is billed and they differ by an order of magnitude, so no tier is chosen here — set it to "Basic", "Standard" or "Premium"',
			);
			const canonicalSku = redisSkuName(context) ?? skuName;
			const family = REDIS_FAMILY_BY_SKU[canonicalSku];
			const capacity = optionalInteger(context.desired, "capacity");
			const shardCount = redisShardCount(context, canonicalSku);
			const created = await settleWrite(
				context,
				await callArm(context, {
					method: "PUT",
					url: azureArmUrl(path, AZURE_CACHE_API_VERSION),
					json: {
						location,
						properties: {
							sku: {
								capacity: capacity ?? 0,
								family,
								name: canonicalSku,
							},
							...(shardCount !== undefined ? { shardCount } : undefined),
						},
					},
				}),
				path,
				AZURE_CACHE_API_VERSION,
				label,
			);
			const diagnostics: string[] = [];
			if (capacity === undefined) {
				diagnostics.push(
					`capacity was not declared, and ARM requires one: the cache was created at capacity 0, the smallest size in the ${canonicalSku} tier. Declare capacity to size it deliberately`,
				);
			}
			return outcome("create", id, redisOutputs(context.name, created.body), [
				...diagnostics,
				...created.diagnostics,
			]);
		}

		const properties = nestedRecord(observed, "properties");
		const sku = nestedRecord(properties, "sku");
		const immutable = redisImmutableDiagnostics(context, observed);
		const patch = {};

		// Only a scale *within* the observed tier is applied. Sending the declared
		// tier here would turn a drift check into a migration; the mismatch is in
		// `immutable` instead.
		const wantedCapacity = optionalInteger(context.desired, "capacity");
		const observedSku = optionalString(sku, "name");
		if (
			wantedCapacity !== undefined &&
			observedSku !== undefined &&
			optionalInteger(sku, "capacity") !== wantedCapacity
		) {
			Object.assign(patch, {
				sku: {
					capacity: wantedCapacity,
					family: REDIS_FAMILY_BY_SKU[observedSku] ?? "C",
					name: observedSku,
				},
			});
		}
		if (
			optionalBoolean(context.desired, "clustered") === true &&
			observedSku === "Premium" &&
			(optionalInteger(properties, "shardCount") ?? 0) === 0
		) {
			Object.assign(patch, { shardCount: 1 });
		}

		if (Object.keys(patch).length === 0) {
			return outcome(
				settledAction(context),
				id,
				redisOutputs(context.name, observed),
				immutable,
			);
		}
		const updated = await settleWrite(
			context,
			await callArm(context, {
				method: "PATCH",
				url: azureArmUrl(path, AZURE_CACHE_API_VERSION),
				json: { properties: patch },
			}),
			path,
			AZURE_CACHE_API_VERSION,
			label,
		);
		return outcome("update", id, redisOutputs(context.name, updated.body), [
			...immutable,
			`cache properties updated: ${Object.keys(patch).sort(compareStrings).join(", ")}`,
			...updated.diagnostics,
		]);
	},
	async remove(context) {
		await armDelete(
			context,
			groupPath(context, redisSuffix(context.name)),
			AZURE_CACHE_API_VERSION,
			`redis cache ${context.name}`,
		);
	},
};

// ---------------------------------------------------------------------------
// Cosmos DB Table API — Microsoft.DocumentDB/databaseAccounts/…/tables
// ---------------------------------------------------------------------------

function cosmosTableSuffix(account: string, table: string): string {
	return `${cosmosSuffix(account)}/tables/${encodeURIComponent(table)}`;
}

function cosmosTableThroughputSuffix(account: string, table: string): string {
	return `${cosmosTableSuffix(account, table)}/throughputSettings/default`;
}

/** What the account's `capabilities` array actually says. */
function accountCapabilities(body: JsonObject): readonly string[] {
	const capabilities = nestedRecord(body, "properties").capabilities;
	return Array.isArray(capabilities)
		? capabilities
				.filter(isJsonObject)
				.map((entry) => optionalString(entry, "name"))
				.filter((name): name is string => name !== undefined)
		: [];
}

/**
 * The database account is a *precondition*, not something this resolver
 * creates — the same boundary the blob-container resolver draws around its
 * storage account, and for the same reason: creating one would mean choosing a
 * globally unique name, a consistency policy and a write region on the caller's
 * behalf, and then owning the deletion question for every other table in it.
 *
 * The `EnableTable` check is not decoration. A Table API table can only exist
 * on an account created with that capability, and capabilities are fixed at
 * account creation; without the check the table PUT fails at ARM with an error
 * that does not say which of the two resources is wrong.
 */
async function requireTableAccount(context: AzureResolverContext): Promise<{
	readonly account: string;
	readonly serverless: boolean;
}> {
	const account = requiredDesired(
		context,
		"databaseAccount",
		AZURE_COSMOS_TABLE_PRODUCT_ID,
		"this resolver owns the table inside a Cosmos DB account, not the account itself",
	);
	const observed = await armGet(
		context,
		groupPath(context, cosmosSuffix(account)),
		AZURE_COSMOS_API_VERSION,
		`cosmos account ${account}`,
	);
	if (observed === undefined) {
		throw new ResolverError(
			"RESOLVER_PROVIDER_REJECTED",
			`${AZURE_COSMOS_TABLE_PRODUCT_ID}: Cosmos DB account ${JSON.stringify(account)} does not exist in resource group ${JSON.stringify(context.resourceGroup)}. Create the account with the EnableTable capability (or point desired.databaseAccount at an existing one) before deploying; this resolver never creates an account, because it would then own every other table in it`,
			AZURE_COSMOS_TABLE_PRODUCT_ID,
		);
	}
	const capabilities = accountCapabilities(observed);
	if (!capabilities.includes("EnableTable")) {
		throw new ResolverError(
			"RESOLVER_PROVIDER_REJECTED",
			`${AZURE_COSMOS_TABLE_PRODUCT_ID}: Cosmos DB account ${JSON.stringify(account)} does not carry the EnableTable capability, so it cannot host a Table API table. Capabilities are fixed when an account is created, so this needs a Table-enabled account rather than a change to this one`,
			AZURE_COSMOS_TABLE_PRODUCT_ID,
		);
	}
	return { account, serverless: capabilities.includes("EnableServerless") };
}

function cosmosTableOutputs(
	account: string,
	table: string,
	body: JsonObject | undefined,
	throughput: number | undefined,
): JsonObject {
	const resource = nestedRecord(nestedRecord(body, "properties"), "resource");
	const tableId = optionalString(resource, "id");
	return {
		tableName: tableId ?? table,
		databaseAccount: account,
		...(throughput !== undefined ? { throughput } : undefined),
	};
}

/**
 * The declared throughput, and the refusals around it.
 *
 * Serverless is an *account* capability, not a table option: a serverless
 * account has no throughput to provision, so declaring RU against one is a
 * request that cannot be honoured and is refused rather than dropped.
 */
function cosmosTableThroughput(
	context: AzureResolverContext,
	serverless: boolean,
): number | undefined {
	const mode = optionalString(context.desired, "throughputMode");
	const ru = optionalInteger(context.desired, "throughputRu");
	if (mode !== undefined && mode !== "provisioned" && mode !== "serverless") {
		throw new ResolverError(
			"RESOLVER_PRODUCT_UNSUPPORTED",
			`${AZURE_COSMOS_TABLE_PRODUCT_ID}: throughputMode ${JSON.stringify(mode)} is not one of provisioned, serverless`,
			AZURE_COSMOS_TABLE_PRODUCT_ID,
		);
	}
	if (serverless) {
		if (ru !== undefined) {
			throw new ResolverError(
				"RESOLVER_PRODUCT_UNSUPPORTED",
				`${AZURE_COSMOS_TABLE_PRODUCT_ID}: throughputRu is declared but the account is serverless, which has no provisioned throughput to set. Drop throughputRu, or point desired.databaseAccount at a provisioned account`,
				AZURE_COSMOS_TABLE_PRODUCT_ID,
			);
		}
		return undefined;
	}
	if (mode === "serverless") {
		throw new ResolverError(
			"RESOLVER_PRODUCT_UNSUPPORTED",
			`${AZURE_COSMOS_TABLE_PRODUCT_ID}: throughputMode asks for serverless but the account was created without the EnableServerless capability. Capacity mode is an account-level decision fixed at creation, so it cannot be set per table`,
			AZURE_COSMOS_TABLE_PRODUCT_ID,
		);
	}
	return ru;
}

/** The table's current provisioned RU, or `undefined` on a serverless account. */
async function readTableThroughput(
	context: AzureResolverContext,
	account: string,
): Promise<number | undefined> {
	const observed = await armGet(
		context,
		groupPath(context, cosmosTableThroughputSuffix(account, context.name)),
		AZURE_COSMOS_API_VERSION,
		`cosmos table throughput ${context.name}`,
	);
	if (observed === undefined) return undefined;
	return optionalInteger(
		nestedRecord(nestedRecord(observed, "properties"), "resource"),
		"throughput",
	);
}

const COSMOS_TABLE_SPEC: Omit<AzureResolverSpec, "productId"> = {
	nameKeys: ["tableName", "name"],
	async read(context) {
		const { account, serverless } = await requireTableAccount(context);
		const suffix = cosmosTableSuffix(account, context.name);
		const observed = await armGet(
			context,
			groupPath(context, suffix),
			AZURE_COSMOS_API_VERSION,
			`cosmos table ${context.name}`,
		);
		if (observed === undefined) return undefined;
		const throughput = serverless
			? undefined
			: await readTableThroughput(context, account);
		return outcome(
			settledAction(context),
			resourceId(context, suffix),
			cosmosTableOutputs(account, context.name, observed, throughput),
			[],
		);
	},
	async reconcile(context) {
		const { account, serverless } = await requireTableAccount(context);
		const wantedRu = cosmosTableThroughput(context, serverless);
		const suffix = cosmosTableSuffix(account, context.name);
		const path = groupPath(context, suffix);
		const id = resourceId(context, suffix);
		const label = `cosmos table ${context.name}`;

		const observed = await armGet(
			context,
			path,
			AZURE_COSMOS_API_VERSION,
			label,
		);
		if (observed === undefined) {
			const created = await settleWrite(
				context,
				await callArm(context, {
					method: "PUT",
					url: azureArmUrl(path, AZURE_COSMOS_API_VERSION),
					json: {
						properties: {
							resource: { id: context.name },
							// `options` is omitted entirely on a serverless account: an
							// empty options bag is not the same as no options, and ARM
							// rejects a throughput on an account that has none.
							...(wantedRu !== undefined
								? { options: { throughput: wantedRu } }
								: undefined),
						},
					},
				}),
				path,
				AZURE_COSMOS_API_VERSION,
				label,
			);
			return outcome(
				"create",
				id,
				cosmosTableOutputs(account, context.name, created.body, wantedRu),
				created.diagnostics,
			);
		}

		const currentRu = serverless
			? undefined
			: await readTableThroughput(context, account);
		if (wantedRu === undefined || wantedRu === currentRu) {
			return outcome(
				settledAction(context),
				id,
				cosmosTableOutputs(account, context.name, observed, currentRu),
				[],
			);
		}
		if (currentRu === undefined) {
			// Never write a value there is nothing to compare against: a blind PUT
			// here would be a PUT on *every* reconcile, which is exactly the
			// non-convergence this module refuses. So it is reported instead.
			return outcome(
				settledAction(context),
				id,
				cosmosTableOutputs(account, context.name, observed, undefined),
				[
					`throughputRu asks for ${wantedRu} RU/s but ARM returned no throughputSettings/default for this table, so there is no current value to compare against; the declared throughput is reported rather than written, because a write with nothing to compare to would repeat on every reconcile`,
				],
			);
		}
		// Throughput lives on its own sub-resource, and re-PUTting the table to
		// change it is not the documented path — it would also rewrite the table
		// definition. So the scale is a write to `throughputSettings/default`.
		const throughputPath = groupPath(
			context,
			cosmosTableThroughputSuffix(account, context.name),
		);
		const updated = await settleWrite(
			context,
			await callArm(context, {
				method: "PUT",
				url: azureArmUrl(throughputPath, AZURE_COSMOS_API_VERSION),
				json: { properties: { resource: { throughput: wantedRu } } },
			}),
			throughputPath,
			AZURE_COSMOS_API_VERSION,
			`${label} throughput`,
		);
		return outcome(
			"update",
			id,
			cosmosTableOutputs(account, context.name, observed, wantedRu),
			[
				`table throughput set to ${wantedRu} RU/s${currentRu === undefined ? "" : ` (was ${currentRu})`}`,
				...updated.diagnostics,
			],
		);
	},
	async remove(context) {
		const account = requiredDesired(
			context,
			"databaseAccount",
			AZURE_COSMOS_TABLE_PRODUCT_ID,
			"the table is addressed inside a named Cosmos DB account",
		);
		await armDelete(
			context,
			groupPath(context, cosmosTableSuffix(account, context.name)),
			AZURE_COSMOS_API_VERSION,
			`cosmos table ${context.name}`,
		);
	},
};

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/**
 * Every Azure resolver, id-sorted so the list is a function of the code rather
 * than of construction order. The products in
 * {@link AZURE_UNRESOLVED_PRODUCT_IDS} are deliberately absent.
 */
export function azureResolvers(
	options: AzureResolverOptions,
): readonly ResourceResolver[] {
	const specs: readonly AzureResolverSpec[] = [
		{ productId: AZURE_BLOB_STORAGE_PRODUCT_ID, ...BLOB_STORAGE_SPEC },
		{ productId: AZURE_CONTAINER_APPS_PRODUCT_ID, ...CONTAINER_APPS_SPEC },
		{ productId: AZURE_COSMOS_DB_PRODUCT_ID, ...COSMOS_DB_SPEC },
		{ productId: AZURE_COSMOS_TABLE_PRODUCT_ID, ...COSMOS_TABLE_SPEC },
		{ productId: AZURE_KEY_VAULT_PRODUCT_ID, ...KEY_VAULT_SPEC },
		{ productId: AZURE_REDIS_CACHE_PRODUCT_ID, ...REDIS_CACHE_SPEC },
		{
			productId: AZURE_SERVICE_BUS_QUEUE_PRODUCT_ID,
			...SERVICE_BUS_QUEUE_SPEC,
		},
		{
			productId: AZURE_SERVICE_BUS_TOPIC_PRODUCT_ID,
			...SERVICE_BUS_TOPIC_SPEC,
		},
		{ productId: AZURE_STORAGE_QUEUE_PRODUCT_ID, ...STORAGE_QUEUE_SPEC },
	];
	return Object.freeze(
		[...specs]
			.sort((left, right) => compareStrings(left.productId, right.productId))
			.map((spec) => createResolver(spec, options)),
	);
}

/** The same resolvers, behind core's product-id lookup. */
export function azureResolverRegistry(options: AzureResolverOptions): {
	get(productId: string): ResourceResolver | undefined;
	list(): readonly ResourceResolver[];
} {
	return createResolverRegistry(azureResolvers(options));
}
