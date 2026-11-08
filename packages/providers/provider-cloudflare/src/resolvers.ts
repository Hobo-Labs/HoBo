/**
 * Direct Cloudflare API v4 resource resolvers — the default deployment path.
 *
 * Why this module exists: HoBo's Cloudflare path used to emit an IaC program
 * and hand it to an engine. That engine is an extra artifact format, an extra
 * state file, and an extra failure mode between "what the Yard says can be
 * allocated" and "what exists in the account". These resolvers remove it: a
 * `ResourceResolver` talks to `https://api.cloudflare.com/client/v4` over an
 * injected, guarded transport and reconciles one product at a time.
 *
 * The property that makes that safe is convergence. Every `reconcile()` here is
 * read-or-create: it asks Cloudflare whether a resource with the deterministic
 * name already exists (by direct GET where the API offers one, by a paged list
 * where it does not) *before* it creates anything, then applies only the
 * mutable deltas. Running it twice produces the same `physicalId` and exactly
 * one resource — which is what makes a crashed half-apply safe to re-run
 * instead of something an operator has to reconcile by hand. `delete()` treats
 * "already gone" as success for the same reason.
 *
 * Credentials are locators, never material. A resolver is constructed with an
 * injected `resolveCredential(ref)`; `ResolveRequest.credentialRef` must look
 * like a reference (`env://CLOUDFLARE_API_TOKEN`, `secret://…`) and a value that
 * looks like the token itself is refused, because a raw token in a request
 * record is a token in the event log. A credential that cannot be resolved is
 * a typed refusal with remediation, never a silent skip.
 *
 * Nothing here reaches for a global `fetch`, and nothing reads a clock or a
 * random source: request bodies are a pure function of the request.
 *
 * HONEST SCOPE (also in the README):
 *   - These resolvers are exercised in tests against an *injected fake*
 *     transport. Nothing in this package proves a live deploy: that
 *     additionally needs real credentials, real network egress, and a real
 *     Cloudflare account, none of which a unit test supplies.
 *   - The `productId` strings are read off the `./slots.js` factories, so the
 *     resolver registry and the Yard catalog cannot drift apart. Whether a
 *     matching Resource Definition is registered in the catalog is still
 *     checked at resolution time (`YARD_BINDING_PRODUCT_UNKNOWN`), not here.
 *   - Coverage is named endpoint by endpoint in the README. It is a slice of
 *     each product's API — enough to allocate, observe, converge, and remove
 *     the resource — and explicitly not the whole surface.
 *   - `"replace"` is never emitted. Replacing a bucket, a database, or a KV
 *     namespace destroys data, so drift on an immutable field is reported as a
 *     diagnostic and left for a human, not silently "fixed".
 */

import { createHash } from "node:crypto";
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

import { CLOUDFLARE_PROVIDER_TARGET } from "./hello-bindle.js";
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
import { d1, kv, pages, queues, r2, workers } from "./slots.js";
import {
	CLOUDFLARE_MAX_RESPONSE_BYTES,
	CLOUDFLARE_MAX_TIMEOUT_MS,
	cloudflareApiUrl,
	guardedCloudflareTransport,
} from "./transport.js";
import { parseCloudflareWorkerSource } from "./worker-content.js";

/**
 * Product ids are read off the slot factories rather than retyped, so the
 * registry cannot silently stop covering a product the Yard still offers.
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

export const CLOUDFLARE_R2_PRODUCT_ID = productIdOf(r2(), "r2");
export const CLOUDFLARE_D1_PRODUCT_ID = productIdOf(d1(), "d1");
export const CLOUDFLARE_KV_PRODUCT_ID = productIdOf(kv(), "kv");
export const CLOUDFLARE_QUEUES_PRODUCT_ID = productIdOf(queues(), "queues");
export const CLOUDFLARE_WORKERS_PRODUCT_ID = productIdOf(workers(), "workers");
export const CLOUDFLARE_PAGES_PRODUCT_ID = productIdOf(pages(), "pages");

/** Every product this module resolves, id-sorted for a deterministic registry. */
export const CLOUDFLARE_RESOLVED_PRODUCT_IDS = Object.freeze(
	[
		CLOUDFLARE_D1_PRODUCT_ID,
		CLOUDFLARE_KV_PRODUCT_ID,
		CLOUDFLARE_PAGES_PRODUCT_ID,
		CLOUDFLARE_QUEUES_PRODUCT_ID,
		CLOUDFLARE_R2_PRODUCT_ID,
		CLOUDFLARE_WORKERS_PRODUCT_ID,
	].sort(compareStrings),
);

/** What a host must supply to build the resolvers. */
export interface CloudflareResolverOptions {
	/** The Cloudflare account every path is scoped to. */
	readonly accountId: string;
	/**
	 * Resolves a credential *locator* to material. Injected so the resolver
	 * never holds a secret and never decides where secrets live.
	 */
	readonly resolveCredential: (ref: string) => Promise<string>;
}

/**
 * A credential locator, using the same grammar core's `parseResolveRequest`
 * enforces (`scheme://path`, no userinfo). Restated here rather than imported
 * because a resolver must refuse a bad ref even when a caller skipped the
 * parse boundary — and a second grammar would be a second answer.
 */
const CREDENTIAL_REF_PATTERN = /^[a-z][a-z0-9+.-]*:\/\/[^\s@]+$/u;

/**
 * What a Cloudflare API token looks like when someone pastes the value into
 * the `credentialRef` field by mistake. Refusing this shape is the difference
 * between a locator in the event log and a live token in the event log.
 */
const RAW_CREDENTIAL_PATTERN = /^[A-Za-z0-9_-]{16,}$/u;

/** Anything long and token-shaped is scrubbed out of provider error text. */
const TOKEN_PATTERN = /[A-Za-z0-9_-]{20,}/gu;

/** A listing that will not terminate is refused rather than half-read. */
const MAX_LIST_PAGES = 25;

const LIST_PAGE_SIZE = 100;

/** Fixed multipart boundary: a random one would make requests nondeterministic. */
const WORKER_MULTIPART_BOUNDARY = "----hobo-cloudflare-worker-boundary";

const DEFAULT_WORKER_MAIN_MODULE = "worker.js";

/**
 * Redact provider text before it reaches a message, a diagnostic, or a log.
 * Cloudflare echoes request context in `errors[].message`, and that context has
 * carried an account id or a token fragment before.
 */
export function redactCloudflareText(text: string, limit = 400): string {
	const scrubbed = text.replace(TOKEN_PATTERN, "[redacted]");
	return scrubbed.length > limit ? `${scrubbed.slice(0, limit)}…` : scrubbed;
}

/** The `{ success, errors, result }` envelope every v4 endpoint returns. */
interface CloudflareEnvelope {
	readonly success: boolean;
	readonly errors: readonly string[];
	readonly result: JsonValue;
	readonly totalPages: number | undefined;
}

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

function optionalStringArray(
	record: JsonObject | undefined,
	key: string,
): readonly string[] | undefined {
	if (record === undefined) return undefined;
	const value = record[key];
	if (!isJsonArray(value)) return undefined;
	return value.every(isJsonString) ? [...value] : undefined;
}

function desiredOf(request: ResolveRequest): JsonObject {
	return parseJsonObject(JSON.stringify(request.desired));
}

/**
 * Parse the v4 envelope. Three distinct outcomes, three distinct codes: a body
 * that is not the documented shape is `RESOLVER_OUTPUT_UNPARSEABLE`, a body
 * that says `success: false` is `RESOLVER_PROVIDER_REJECTED`, and anything else
 * is the caller's to interpret.
 */
function parseEnvelope(
	response: TransportResponse,
	context: string,
): CloudflareEnvelope {
	let parsed: JsonValue;
	try {
		// SAFETY: JSON.parse yields a JSON value at this Cloudflare document boundary.
		parsed = JSON.parse(response.body) as JsonValue;
	} catch {
		throw new ResolverError(
			"RESOLVER_OUTPUT_UNPARSEABLE",
			`${context}: Cloudflare returned a status ${response.status} body that is not JSON, so the outcome of the call is unknown and it is refused rather than assumed; retry, and if it repeats the API contract has changed`,
		);
	}
	if (!isJsonObject(parsed)) {
		throw new ResolverError(
			"RESOLVER_OUTPUT_UNPARSEABLE",
			`${context}: Cloudflare returned JSON that is not an object envelope (status ${response.status})`,
		);
	}
	const success = parsed.success;
	if (!isJsonBoolean(success)) {
		throw new ResolverError(
			"RESOLVER_OUTPUT_UNPARSEABLE",
			`${context}: Cloudflare response has no boolean "success" field, so it is not the documented v4 envelope (status ${response.status})`,
		);
	}
	const envelope: CloudflareEnvelope = {
		success,
		errors: readErrors(parsed.errors),
		result: parsed.result ?? null,
		totalPages: readTotalPages(parsed.result_info),
	};
	if (!envelope.success || response.status >= 400) {
		throw new ResolverError(
			"RESOLVER_PROVIDER_REJECTED",
			`${context}: Cloudflare refused the call with status ${response.status}: ${
				envelope.errors.length > 0
					? envelope.errors.join("; ")
					: "no error detail was returned"
			}`,
		);
	}
	return envelope;
}

function readErrors(value: JsonValue | undefined): readonly string[] {
	if (!isJsonArray(value)) return [];
	const out: string[] = [];
	for (const entry of value) {
		if (isJsonString(entry)) {
			out.push(redactCloudflareText(entry));
			continue;
		}
		if (!isJsonObject(entry)) continue;
		const message = entry.message;
		const code = entry.code;
		const detail = isJsonString(message) ? message : JSON.stringify(entry);
		out.push(
			redactCloudflareText(isJsonNumber(code) ? `${code}: ${detail}` : detail),
		);
	}
	return out;
}

function readTotalPages(value: JsonValue | undefined): number | undefined {
	if (!isJsonObject(value)) return undefined;
	const total = value.total_pages;
	return isJsonNumber(total) && Number.isSafeInteger(total) && total >= 0
		? total
		: undefined;
}

function resultObject(
	envelope: CloudflareEnvelope,
	context: string,
): JsonObject {
	if (!isJsonObject(envelope.result)) {
		throw new ResolverError(
			"RESOLVER_OUTPUT_UNPARSEABLE",
			`${context}: Cloudflare returned a successful envelope whose "result" is not an object, so the created resource cannot be identified`,
		);
	}
	return envelope.result;
}

function resultArray(
	envelope: CloudflareEnvelope,
	context: string,
): readonly JsonObject[] {
	if (!isJsonArray(envelope.result)) {
		throw new ResolverError(
			"RESOLVER_OUTPUT_UNPARSEABLE",
			`${context}: Cloudflare returned a successful envelope whose "result" is not a list`,
		);
	}
	const out: JsonObject[] = [];
	for (const entry of envelope.result) {
		if (!isJsonObject(entry)) {
			throw new ResolverError(
				"RESOLVER_OUTPUT_UNPARSEABLE",
				`${context}: Cloudflare returned a list containing a non-object entry`,
			);
		}
		out.push(entry);
	}
	return out;
}

interface CloudflareCall {
	readonly method: TransportMethod;
	/** `/client/v4`-relative, with every dynamic segment already encoded. */
	readonly path: string;
	readonly json?: unknown;
	readonly rawBody?: string;
	readonly contentType?: string;
	readonly headers?: Readonly<Record<string, string>>;
}

async function send(
	transport: HttpTransport,
	token: string,
	call: CloudflareCall,
): Promise<TransportResponse> {
	const body =
		call.rawBody ??
		(call.json !== undefined ? JSON.stringify(call.json) : undefined);
	const contentType =
		body === undefined ? undefined : (call.contentType ?? "application/json");
	return transport({
		method: call.method,
		url: cloudflareApiUrl(call.path),
		headers: {
			accept: "application/json",
			authorization: `Bearer ${token}`,
			...(contentType !== undefined
				? { "content-type": contentType }
				: undefined),
			...(call.headers ?? undefined),
		},
		...(body !== undefined ? { body } : undefined),
		timeoutMs: CLOUDFLARE_MAX_TIMEOUT_MS,
		maxResponseBytes: CLOUDFLARE_MAX_RESPONSE_BYTES,
	});
}

/**
 * Read every page of a list endpoint. Cloudflare pages some collections that
 * have no name filter (KV namespaces, Queues); stopping at page one there would
 * mean creating a duplicate of a resource that already exists on page two,
 * which is precisely the failure convergence is supposed to rule out.
 */
async function listAll(
	transport: HttpTransport,
	token: string,
	path: string,
	context: string,
): Promise<readonly JsonObject[]> {
	const separator = path.includes("?") ? "&" : "?";
	const items: JsonObject[] = [];
	for (let page = 1; page <= MAX_LIST_PAGES; page += 1) {
		const response = await send(transport, token, {
			method: "GET",
			path: `${path}${separator}page=${page}&per_page=${LIST_PAGE_SIZE}`,
		});
		const envelope = parseEnvelope(response, context);
		const batch = resultArray(envelope, context);
		items.push(...batch);
		const { totalPages } = envelope;
		if (batch.length === 0) return items;
		if (
			totalPages !== undefined
				? page >= totalPages
				: batch.length < LIST_PAGE_SIZE
		) {
			return items;
		}
	}
	throw new ResolverError(
		"RESOLVER_PROVIDER_REJECTED",
		`${context}: Cloudflare listing did not terminate within ${MAX_LIST_PAGES} pages, so an existing resource cannot be ruled out and creating one would risk a duplicate`,
	);
}

/** 404 means "not there", which every read-or-create path needs to tell apart. */
function isNotFound(response: TransportResponse): boolean {
	return response.status === 404;
}

/** Everything a resolver body needs, with the credential already resolved. */
interface CloudflareResolverContext {
	readonly request: ResolveRequest;
	readonly transport: HttpTransport;
	readonly token: string;
	readonly accountId: string;
	/** The deterministic resource name: `desired.name`, else the logical id. */
	readonly name: string;
	readonly desired: JsonObject;
	/** True when the caller already knows the physical id (adopt vs noop). */
	readonly knownPhysicalId: string | undefined;
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
 * Existing resource, no delta: `noop` when the caller already named it,
 * `adopt` when the resolver found something the request did not know about.
 * The distinction is the audit record — adoption of an unmanaged resource is a
 * fact an operator should be able to see, not something folded into "nothing
 * happened".
 */
function settledAction(context: CloudflareResolverContext): ResolverAction {
	return context.knownPhysicalId === undefined ? "adopt" : "noop";
}

function assertAccountId(accountId: string): string {
	if (accountId.trim().length === 0) {
		throw new ResolverError(
			"RESOLVER_PRODUCT_UNSUPPORTED",
			"cloudflare resolvers need an accountId: every /client/v4 path is account-scoped, and guessing one would target the wrong tenant",
		);
	}
	return accountId;
}

/**
 * The credential parse boundary.
 *
 * `credentialRef` is a locator. A blank one is `RESOLVER_CREDENTIAL_MISSING`
 * (with the remediation), a token-shaped one is `RESOLVER_CREDENTIAL_NOT_A_REF`
 * — a raw secret in a request record has already leaked by the time it is used
 * — and a resolver that hands back nothing is missing, never "carry on
 * unauthenticated".
 */
async function resolveToken(
	request: ResolveRequest,
	resolve: (ref: string) => Promise<string>,
): Promise<string> {
	const ref = request.credentialRef;
	if (ref.trim().length === 0) {
		throw new ResolverError(
			"RESOLVER_CREDENTIAL_MISSING",
			'cloudflare resolver: credentialRef is empty. Supply a locator such as "env://CLOUDFLARE_API_TOKEN" or "secret://camp/cloudflare-api-token" and register it with the host credential resolver; the resolver never accepts inline credential material',
		);
	}
	const trimmed = ref.trim();
	if (RAW_CREDENTIAL_PATTERN.test(trimmed)) {
		throw new ResolverError(
			"RESOLVER_CREDENTIAL_NOT_A_REF",
			"cloudflare resolver: credentialRef looks like credential material rather than a locator. Store the token with the host secret custody and pass its reference (scheme://path); a raw token in a ResolveRequest is a token in the event log",
		);
	}
	if (!CREDENTIAL_REF_PATTERN.test(trimmed)) {
		throw new ResolverError(
			"RESOLVER_CREDENTIAL_NOT_A_REF",
			`cloudflare resolver: credentialRef ${JSON.stringify(redactCloudflareText(trimmed, 60))} is not a locator. Expected "<scheme>://<path>", for example "env://CLOUDFLARE_API_TOKEN"`,
		);
	}
	let material: string;
	try {
		material = await resolve(trimmed);
	} catch (cause) {
		throw new ResolverError(
			"RESOLVER_CREDENTIAL_MISSING",
			`cloudflare resolver: the host could not resolve credentialRef ${JSON.stringify(trimmed)}: ${redactCloudflareText(
				cause instanceof Error ? cause.message : String(cause),
				160,
			)}. Register the reference with the credential resolver before deploying`,
		);
	}
	if (material.trim().length === 0) {
		throw new ResolverError(
			"RESOLVER_CREDENTIAL_MISSING",
			`cloudflare resolver: credentialRef ${JSON.stringify(trimmed)} resolved to nothing. A missing credential is refused rather than retried unauthenticated, which would look like a permissions error at the provider`,
		);
	}
	return material.trim();
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

/** Per-product behaviour; the wrapper owns credentials, naming, and refusals. */
interface CloudflareResolverSpec {
	readonly productId: string;
	reconcile(context: CloudflareResolverContext): Promise<ResolveOutcome>;
	read(context: CloudflareResolverContext): Promise<ResolveOutcome | undefined>;
	remove(context: CloudflareResolverContext): Promise<void>;
}

function createResolver(
	spec: CloudflareResolverSpec,
	options: CloudflareResolverOptions,
): ResourceResolver {
	const accountId = assertAccountId(options.accountId);

	async function contextFor(
		request: ResolveRequest,
		transport: HttpTransport,
	): Promise<CloudflareResolverContext> {
		request = parseResolveRequest(parseJsonObject(JSON.stringify(request)));
		if (request.ref.productId !== spec.productId) {
			throw new ResolverError(
				"RESOLVER_PRODUCT_UNSUPPORTED",
				`cloudflare resolver for ${spec.productId} was handed a request for ${JSON.stringify(request.ref.productId)}; route the request through the registry rather than picking a resolver by hand`,
			);
		}
		const token = await resolveToken(request, options.resolveCredential);
		return {
			request,
			transport: guardedCloudflareTransport(transport),
			token,
			accountId,
			name: resourceName(request, spec.productId),
			desired: desiredOf(request),
			knownPhysicalId: knownPhysicalId(request),
		};
	}

	return {
		providerId: CLOUDFLARE_PROVIDER_TARGET,
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
// R2 buckets — /client/v4/accounts/{account_id}/r2/buckets
// ---------------------------------------------------------------------------

/** Jurisdiction is a header on *every* R2 call, not a body field. */
function r2Headers(
	context: CloudflareResolverContext,
): Readonly<Record<string, string>> {
	const jurisdiction = optionalString(context.desired, "jurisdiction");
	return jurisdiction === undefined
		? {}
		: { "cf-r2-jurisdiction": jurisdiction };
}

function r2Path(context: CloudflareResolverContext, suffix = ""): string {
	return `/accounts/${encodeURIComponent(context.accountId)}/r2/buckets${suffix}`;
}

function r2Outputs(name: string, record: JsonObject) {
	const location = optionalString(record, "location");
	const storageClass = optionalString(record, "storage_class");
	return {
		bucketName: name,
		...(location !== undefined ? { location } : undefined),
		...(storageClass !== undefined ? { storageClass } : undefined),
	};
}

function r2Diagnostics(
	context: CloudflareResolverContext,
	observed: JsonObject | undefined,
): readonly string[] {
	const diagnostics: string[] = [];
	if (optionalBoolean(context.desired, "publicBucket") === true) {
		diagnostics.push(
			"publicBucket is declared but not applied: public access is a managed-domain call this resolver does not implement",
		);
	}
	const wanted = optionalString(context.desired, "locationHint");
	const actual =
		observed === undefined ? undefined : optionalString(observed, "location");
	// R2 takes `locationHint` lowercase ("weur") and reports `location`
	// uppercase ("WEUR"), so a case-sensitive compare reports permanent drift on
	// a bucket that is exactly where it was asked to be. A diagnostic that fires
	// every reconcile teaches operators to ignore diagnostics.
	if (
		wanted !== undefined &&
		actual !== undefined &&
		wanted.toLowerCase() !== actual.toLowerCase()
	) {
		diagnostics.push(
			`bucket location is ${actual} but locationHint asks for ${wanted}; R2 location is immutable and this resolver never replaces a bucket, so the drift is reported rather than corrected`,
		);
	}
	return diagnostics;
}

async function readR2(
	context: CloudflareResolverContext,
): Promise<JsonObject | undefined> {
	const response = await send(context.transport, context.token, {
		method: "GET",
		path: r2Path(context, `/${encodeURIComponent(context.name)}`),
		headers: r2Headers(context),
	});
	if (isNotFound(response)) return undefined;
	const envelope = parseEnvelope(response, `r2 get bucket ${context.name}`);
	return resultObject(envelope, `r2 get bucket ${context.name}`);
}

const R2_SPEC: Omit<CloudflareResolverSpec, "productId"> = {
	async read(context) {
		const observed = await readR2(context);
		if (observed === undefined) return undefined;
		return outcome(
			settledAction(context),
			context.name,
			r2Outputs(context.name, observed),
			r2Diagnostics(context, observed),
		);
	},
	async reconcile(context) {
		const observed = await readR2(context);
		if (observed !== undefined) {
			return outcome(
				settledAction(context),
				context.name,
				r2Outputs(context.name, observed),
				r2Diagnostics(context, observed),
			);
		}
		const locationHint = optionalString(context.desired, "locationHint");
		const storageClass = optionalString(context.desired, "storageClass");
		const response = await send(context.transport, context.token, {
			method: "POST",
			path: r2Path(context),
			headers: r2Headers(context),
			json: {
				name: context.name,
				...(locationHint !== undefined ? { locationHint } : undefined),
				...(storageClass !== undefined ? { storageClass } : undefined),
			},
		});
		const created = resultObject(
			parseEnvelope(response, `r2 create bucket ${context.name}`),
			`r2 create bucket ${context.name}`,
		);
		return outcome(
			"create",
			context.name,
			r2Outputs(context.name, created),
			r2Diagnostics(context, created),
		);
	},
	async remove(context) {
		const response = await send(context.transport, context.token, {
			method: "DELETE",
			path: r2Path(context, `/${encodeURIComponent(context.name)}`),
			headers: r2Headers(context),
		});
		if (isNotFound(response)) return;
		parseEnvelope(response, `r2 delete bucket ${context.name}`);
	},
};

// ---------------------------------------------------------------------------
// D1 databases — /client/v4/accounts/{account_id}/d1/database
// ---------------------------------------------------------------------------

function d1Path(context: CloudflareResolverContext, suffix = ""): string {
	return `/accounts/${encodeURIComponent(context.accountId)}/d1/database${suffix}`;
}

/** D1's read-replication toggle is a mode string, not a boolean. */
function d1ReplicationMode(
	context: CloudflareResolverContext,
): string | undefined {
	const wanted = optionalBoolean(context.desired, "readReplication");
	if (wanted === undefined) return undefined;
	return wanted ? "auto" : "disabled";
}

function d1ObservedMode(record: JsonObject): string | undefined {
	const replication = record.read_replication;
	return isJsonObject(replication)
		? optionalString(replication, "mode")
		: undefined;
}

function d1Outputs(record: JsonObject, uuid: string, name: string) {
	const version = optionalString(record, "version");
	return {
		databaseId: uuid,
		databaseName: name,
		...(version !== undefined ? { version } : undefined),
	};
}

function d1Uuid(record: JsonObject, context: string): string {
	const uuid = optionalString(record, "uuid");
	if (uuid === undefined) {
		throw new ResolverError(
			"RESOLVER_OUTPUT_UNPARSEABLE",
			`${context}: Cloudflare returned a D1 record without a "uuid", so the database cannot be addressed`,
		);
	}
	return uuid;
}

async function findD1(
	context: CloudflareResolverContext,
): Promise<JsonObject | undefined> {
	const response = await send(context.transport, context.token, {
		method: "GET",
		path: d1Path(context, `?name=${encodeURIComponent(context.name)}`),
	});
	if (isNotFound(response)) return undefined;
	const label = `d1 list databases ${context.name}`;
	const matches = resultArray(parseEnvelope(response, label), label);
	// The filter is a prefix search at the provider, so the exact match is
	// re-checked here rather than trusting position in the list.
	return matches.find(
		(entry) => optionalString(entry, "name") === context.name,
	);
}

const D1_SPEC: Omit<CloudflareResolverSpec, "productId"> = {
	async read(context) {
		const observed = await findD1(context);
		if (observed === undefined) return undefined;
		const uuid = d1Uuid(observed, `d1 read ${context.name}`);
		return outcome(
			settledAction(context),
			uuid,
			d1Outputs(observed, uuid, context.name),
			[],
		);
	},
	async reconcile(context) {
		const observed = await findD1(context);
		if (observed === undefined) {
			const locationHint = optionalString(
				context.desired,
				"primaryLocationHint",
			);
			const label = `d1 create database ${context.name}`;
			const created = resultObject(
				parseEnvelope(
					await send(context.transport, context.token, {
						method: "POST",
						path: d1Path(context),
						json: {
							name: context.name,
							...(locationHint !== undefined
								? { primary_location_hint: locationHint }
								: undefined),
						},
					}),
					label,
				),
				label,
			);
			const uuid = d1Uuid(created, label);
			const mode = d1ReplicationMode(context);
			if (mode !== undefined) {
				await patchD1ReadReplication(context, uuid, mode);
			}
			return outcome(
				"create",
				uuid,
				d1Outputs(created, uuid, context.name),
				[],
			);
		}
		const uuid = d1Uuid(observed, `d1 reconcile ${context.name}`);
		const mode = d1ReplicationMode(context);
		if (mode !== undefined && mode !== d1ObservedMode(observed)) {
			const updated = await patchD1ReadReplication(context, uuid, mode);
			return outcome("update", uuid, d1Outputs(updated, uuid, context.name), [
				`read replication set to ${mode}`,
			]);
		}
		return outcome(
			settledAction(context),
			uuid,
			d1Outputs(observed, uuid, context.name),
			[],
		);
	},
	async remove(context) {
		const observed = await findD1(context);
		if (observed === undefined) return;
		const uuid = d1Uuid(observed, `d1 delete ${context.name}`);
		const response = await send(context.transport, context.token, {
			method: "DELETE",
			path: d1Path(context, `/${encodeURIComponent(uuid)}`),
		});
		if (isNotFound(response)) return;
		parseEnvelope(response, `d1 delete database ${context.name}`);
	},
};

async function patchD1ReadReplication(
	context: CloudflareResolverContext,
	uuid: string,
	mode: string,
): Promise<JsonObject> {
	const label = `d1 update read replication ${context.name}`;
	return resultObject(
		parseEnvelope(
			await send(context.transport, context.token, {
				method: "PATCH",
				path: d1Path(context, `/${encodeURIComponent(uuid)}`),
				json: { read_replication: { mode } },
			}),
			label,
		),
		label,
	);
}

// ---------------------------------------------------------------------------
// KV namespaces — /client/v4/accounts/{account_id}/storage/kv/namespaces
// ---------------------------------------------------------------------------

function kvPath(context: CloudflareResolverContext, suffix = ""): string {
	return `/accounts/${encodeURIComponent(context.accountId)}/storage/kv/namespaces${suffix}`;
}

function kvOutputs(id: string, title: string) {
	return { namespaceId: id, title };
}

function kvDiagnostics(context: CloudflareResolverContext): readonly string[] {
	return optionalInteger(context.desired, "ttlSeconds") === undefined
		? []
		: [
				"ttlSeconds is declared but not applied: Workers KV expiry is set per write, not on the namespace",
			];
}

function kvId(record: JsonObject, context: string): string {
	const id = optionalString(record, "id");
	if (id === undefined) {
		throw new ResolverError(
			"RESOLVER_OUTPUT_UNPARSEABLE",
			`${context}: Cloudflare returned a KV namespace without an "id"`,
		);
	}
	return id;
}

async function findKv(
	context: CloudflareResolverContext,
): Promise<JsonObject | undefined> {
	const namespaces = await listAll(
		context.transport,
		context.token,
		kvPath(context),
		"kv list namespaces",
	);
	return namespaces.find(
		(entry) => optionalString(entry, "title") === context.name,
	);
}

const KV_SPEC: Omit<CloudflareResolverSpec, "productId"> = {
	async read(context) {
		const observed = await findKv(context);
		if (observed === undefined) return undefined;
		const id = kvId(observed, `kv read ${context.name}`);
		return outcome(
			settledAction(context),
			id,
			kvOutputs(id, context.name),
			kvDiagnostics(context),
		);
	},
	async reconcile(context) {
		const observed = await findKv(context);
		if (observed !== undefined) {
			// The title is the lookup key, so there is no mutable delta left to
			// apply — finding it *is* convergence.
			const id = kvId(observed, `kv reconcile ${context.name}`);
			return outcome(
				settledAction(context),
				id,
				kvOutputs(id, context.name),
				kvDiagnostics(context),
			);
		}
		const label = `kv create namespace ${context.name}`;
		const created = resultObject(
			parseEnvelope(
				await send(context.transport, context.token, {
					method: "POST",
					path: kvPath(context),
					json: { title: context.name },
				}),
				label,
			),
			label,
		);
		const id = kvId(created, label);
		return outcome(
			"create",
			id,
			kvOutputs(id, context.name),
			kvDiagnostics(context),
		);
	},
	async remove(context) {
		const observed = await findKv(context);
		if (observed === undefined) return;
		const id = kvId(observed, `kv delete ${context.name}`);
		const response = await send(context.transport, context.token, {
			method: "DELETE",
			path: kvPath(context, `/${encodeURIComponent(id)}`),
		});
		if (isNotFound(response)) return;
		parseEnvelope(response, `kv delete namespace ${context.name}`);
	},
};

// ---------------------------------------------------------------------------
// Queues — /client/v4/accounts/{account_id}/queues
// ---------------------------------------------------------------------------

function queuesPath(context: CloudflareResolverContext, suffix = ""): string {
	return `/accounts/${encodeURIComponent(context.accountId)}/queues${suffix}`;
}

function queueId(record: JsonObject, context: string): string {
	const id = optionalString(record, "queue_id");
	if (id === undefined) {
		throw new ResolverError(
			"RESOLVER_OUTPUT_UNPARSEABLE",
			`${context}: Cloudflare returned a queue without a "queue_id"`,
		);
	}
	return id;
}

function queueOutputs(id: string, name: string) {
	return { queueId: id, queueName: name };
}

/** Only the queue-scoped settings; batching and retries are consumer-scoped. */
function queueSettings(
	context: CloudflareResolverContext,
): Readonly<Record<string, number>> | undefined {
	const deliveryDelay = optionalInteger(
		context.desired,
		"deliveryDelaySeconds",
	);
	const retention = optionalInteger(
		context.desired,
		"messageRetentionPeriodSeconds",
	);
	const settings = {
		...(deliveryDelay !== undefined
			? { delivery_delay: deliveryDelay }
			: undefined),
		...(retention !== undefined
			? { message_retention_period: retention }
			: undefined),
	};
	return Object.keys(settings).length === 0 ? undefined : settings;
}

function queueSettingsDrift(
	context: CloudflareResolverContext,
	observed: JsonObject,
): Readonly<Record<string, number>> | undefined {
	const wanted = queueSettings(context);
	if (wanted === undefined) return undefined;
	const current = observed.settings;
	const currentRecord = isJsonObject(current) ? current : undefined;
	for (const [key, value] of Object.entries(wanted)) {
		if (optionalInteger(currentRecord, key) !== value) return wanted;
	}
	return undefined;
}

function queueDiagnostics(
	context: CloudflareResolverContext,
): readonly string[] {
	const consumerScoped = ["maxBatchSize", "maxRetries"].filter(
		(key) => optionalInteger(context.desired, key) !== undefined,
	);
	return consumerScoped.length === 0
		? []
		: [
				`${consumerScoped.join(", ")} declared but not applied: these are consumer settings, configured on a queue consumer rather than on the queue`,
			];
}

async function findQueue(
	context: CloudflareResolverContext,
): Promise<JsonObject | undefined> {
	const all = await listAll(
		context.transport,
		context.token,
		queuesPath(context),
		"queues list",
	);
	return all.find(
		(entry) => optionalString(entry, "queue_name") === context.name,
	);
}

const QUEUES_SPEC: Omit<CloudflareResolverSpec, "productId"> = {
	async read(context) {
		const observed = await findQueue(context);
		if (observed === undefined) return undefined;
		const id = queueId(observed, `queues read ${context.name}`);
		return outcome(
			settledAction(context),
			id,
			queueOutputs(id, context.name),
			queueDiagnostics(context),
		);
	},
	async reconcile(context) {
		const observed = await findQueue(context);
		if (observed === undefined) {
			const label = `queues create ${context.name}`;
			const settings = queueSettings(context);
			const created = resultObject(
				parseEnvelope(
					await send(context.transport, context.token, {
						method: "POST",
						path: queuesPath(context),
						json: {
							queue_name: context.name,
							...(settings !== undefined ? { settings } : undefined),
						},
					}),
					label,
				),
				label,
			);
			const id = queueId(created, label);
			return outcome(
				"create",
				id,
				queueOutputs(id, context.name),
				queueDiagnostics(context),
			);
		}
		const id = queueId(observed, `queues reconcile ${context.name}`);
		const drift = queueSettingsDrift(context, observed);
		if (drift !== undefined) {
			const label = `queues update ${context.name}`;
			parseEnvelope(
				await send(context.transport, context.token, {
					method: "PUT",
					path: queuesPath(context, `/${encodeURIComponent(id)}`),
					json: { queue_name: context.name, settings: drift },
				}),
				label,
			);
			return outcome("update", id, queueOutputs(id, context.name), [
				...queueDiagnostics(context),
				`queue settings updated: ${Object.keys(drift).sort(compareStrings).join(", ")}`,
			]);
		}
		return outcome(
			settledAction(context),
			id,
			queueOutputs(id, context.name),
			queueDiagnostics(context),
		);
	},
	async remove(context) {
		const observed = await findQueue(context);
		if (observed === undefined) return;
		const id = queueId(observed, `queues delete ${context.name}`);
		const response = await send(context.transport, context.token, {
			method: "DELETE",
			path: queuesPath(context, `/${encodeURIComponent(id)}`),
		});
		if (isNotFound(response)) return;
		parseEnvelope(response, `queues delete ${context.name}`);
	},
};

// ---------------------------------------------------------------------------
// Worker scripts — /client/v4/accounts/{account_id}/workers/scripts/{name}
// ---------------------------------------------------------------------------

function workerPath(context: CloudflareResolverContext, suffix = ""): string {
	return `/accounts/${encodeURIComponent(context.accountId)}/workers/scripts/${encodeURIComponent(context.name)}${suffix}`;
}

function workerOutputs(name: string, record: JsonObject) {
	const compatibilityDate = optionalString(record, "compatibility_date");
	const etag = optionalString(record, "etag");
	return {
		scriptName: name,
		...(compatibilityDate !== undefined ? { compatibilityDate } : undefined),
		...(etag !== undefined ? { etag } : undefined),
	};
}

/**
 * Cloudflare's script upload is `multipart/form-data`, so the body is composed
 * here rather than by the transport. The boundary is a constant: a random one
 * would make the same desired state produce a different request every run.
 */
function workerUploadBody(context: CloudflareResolverContext): string {
	const script = optionalString(context.desired, "script");
	if (script === undefined) {
		throw new ResolverError(
			"RESOLVER_PRODUCT_UNSUPPORTED",
			`${CLOUDFLARE_WORKERS_PRODUCT_ID}: creating a Worker needs desired.script (the ES module source). This resolver uploads what it is given and never synthesises a placeholder Worker, which would deploy code nobody wrote`,
		);
	}
	const mainModule =
		optionalString(context.desired, "mainModule") ?? DEFAULT_WORKER_MAIN_MODULE;
	const compatibilityDate = optionalString(
		context.desired,
		"compatibilityDate",
	);
	const compatibilityFlags = optionalStringArray(
		context.desired,
		"compatibilityFlags",
	);
	const bindings = context.desired.bindings;
	const smartPlacement = optionalBoolean(context.desired, "smartPlacement");
	const metadata = JSON.stringify({
		main_module: mainModule,
		...(compatibilityDate !== undefined
			? { compatibility_date: compatibilityDate }
			: undefined),
		...(compatibilityFlags !== undefined
			? { compatibility_flags: [...compatibilityFlags] }
			: undefined),
		...(isJsonArray(bindings) ? { bindings } : undefined),
		...(smartPlacement === undefined
			? undefined
			: { placement: { mode: smartPlacement ? "smart" : "off" } }),
	});
	if (
		script.includes(WORKER_MULTIPART_BOUNDARY) ||
		mainModule.includes(WORKER_MULTIPART_BOUNDARY) ||
		metadata.includes(WORKER_MULTIPART_BOUNDARY)
	) {
		throw new ResolverError(
			"RESOLVER_PRODUCT_UNSUPPORTED",
			`${CLOUDFLARE_WORKERS_PRODUCT_ID}: the Worker source contains this resolver's multipart boundary marker, which would produce an ambiguous request body; rename the module or strip the marker`,
		);
	}
	return [
		`--${WORKER_MULTIPART_BOUNDARY}`,
		'Content-Disposition: form-data; name="metadata"; filename="metadata.json"',
		"Content-Type: application/json",
		"",
		metadata,
		`--${WORKER_MULTIPART_BOUNDARY}`,
		`Content-Disposition: form-data; name="${mainModule}"; filename="${mainModule}"`,
		"Content-Type: application/javascript+module",
		"",
		script,
		`--${WORKER_MULTIPART_BOUNDARY}--`,
		"",
	].join("\r\n");
}

async function readWorkerSettings(
	context: CloudflareResolverContext,
): Promise<JsonObject | undefined> {
	const response = await send(context.transport, context.token, {
		method: "GET",
		path: workerPath(context, "/settings"),
	});
	if (isNotFound(response)) return undefined;
	const label = `workers read settings ${context.name}`;
	return resultObject(parseEnvelope(response, label), label);
}

async function uploadWorker(
	context: CloudflareResolverContext,
): Promise<JsonObject> {
	const label = `workers upload ${context.name}`;
	return resultObject(
		parseEnvelope(
			await send(context.transport, context.token, {
				method: "PUT",
				path: workerPath(context),
				rawBody: workerUploadBody(context),
				contentType: `multipart/form-data; boundary=${WORKER_MULTIPART_BOUNDARY}`,
			}),
			label,
		),
		label,
	);
}

function assertWorkerRequest(context: CloudflareResolverContext): void {
	if (
		context.knownPhysicalId !== undefined &&
		context.knownPhysicalId !== context.name
	)
		throw new ResolverError(
			"RESOLVER_PRODUCT_UNSUPPORTED",
			"Cloudflare Worker name differs from its pinned physical identity",
		);
	if (!/^[a-z0-9][a-z0-9_-]{0,62}$/u.test(context.name))
		throw new ResolverError(
			"RESOLVER_PRODUCT_UNSUPPORTED",
			"Cloudflare Worker requires a plain provider script name",
		);
	if (
		Buffer.byteLength(JSON.stringify(context.desired), "utf8") >
		CLOUDFLARE_MAX_RESPONSE_BYTES - 16_384
	)
		throw new ResolverError(
			"RESOLVER_PRODUCT_UNSUPPORTED",
			"Cloudflare Worker artifact exceeds its bounded native readback limit",
		);
	const allowed = new Set([
		"name",
		"script",
		"mainModule",
		"compatibilityDate",
		"compatibilityFlags",
		"bindings",
		"smartPlacement",
		"workersDev",
	]);
	for (const key of Object.keys(context.desired))
		if (!allowed.has(key))
			throw new ResolverError(
				"RESOLVER_PRODUCT_UNSUPPORTED",
				"Cloudflare Worker has an unsupported desired property",
			);
	for (const key of ["workersDev", "smartPlacement"])
		if (
			context.desired[key] !== undefined &&
			!isJsonBoolean(context.desired[key])
		)
			throw new ResolverError(
				"RESOLVER_PRODUCT_UNSUPPORTED",
				"Cloudflare Worker boolean property has an invalid type",
			);
	for (const key of ["script", "mainModule", "compatibilityDate"])
		if (
			context.desired[key] !== undefined &&
			optionalString(context.desired, key) === undefined
		)
			throw new ResolverError(
				"RESOLVER_PRODUCT_UNSUPPORTED",
				"Cloudflare Worker source/settings require nonempty strings",
			);
	const module =
		optionalString(context.desired, "mainModule") ?? DEFAULT_WORKER_MAIN_MODULE;
	if (
		!/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/u.test(module) ||
		module.split("/").some((part) => part === "." || part === "..")
	)
		throw new ResolverError(
			"RESOLVER_PRODUCT_UNSUPPORTED",
			"Cloudflare Worker main module must be a safe artifact path",
		);
	if (
		context.desired.compatibilityFlags !== undefined &&
		(!isJsonArray(context.desired.compatibilityFlags) ||
			!context.desired.compatibilityFlags.every(isJsonString))
	)
		throw new ResolverError(
			"RESOLVER_PRODUCT_UNSUPPORTED",
			"Cloudflare Worker compatibility flags require a string array",
		);
	if (
		context.desired.bindings !== undefined &&
		!isJsonArray(context.desired.bindings)
	)
		throw new ResolverError(
			"RESOLVER_PRODUCT_UNSUPPORTED",
			"Cloudflare Worker bindings require an array",
		);
}
function workerSettingsMatch(
	context: CloudflareResolverContext,
	settings: JsonObject,
): boolean {
	const date = optionalString(context.desired, "compatibilityDate");
	if (date !== undefined && settings.compatibility_date !== date) return false;
	const flags = optionalStringArray(context.desired, "compatibilityFlags");
	if (
		flags !== undefined &&
		JSON.stringify([...flags].sort()) !==
			JSON.stringify(
				[
					...(optionalStringArray(settings, "compatibility_flags") ?? []),
				].sort(),
			)
	)
		return false;
	const placement = optionalBoolean(context.desired, "smartPlacement");
	if (
		placement !== undefined &&
		(!isJsonObject(settings.placement) ||
			settings.placement.mode !== (placement ? "smart" : "off"))
	)
		return false;
	const expected = context.desired.bindings;
	if (isJsonArray(expected)) {
		const actual = settings.bindings;
		if (!isJsonArray(actual) || actual.length !== expected.length) return false;
		for (const binding of expected) {
			if (!isJsonObject(binding) || !isJsonString(binding.name)) return false;
			const matches = actual.filter(
				(value) => isJsonObject(value) && value.name === binding.name,
			);
			if (matches.length !== 1 || !isJsonObject(matches[0])) return false;
			const observed = matches[0];
			for (const key of Object.keys(binding))
				if (JSON.stringify(observed[key]) !== JSON.stringify(binding[key]))
					return false;
		}
	}
	return true;
}
async function observeWorker(
	context: CloudflareResolverContext,
	settings?: JsonObject,
): Promise<JsonObject | undefined> {
	const observed = settings ?? (await readWorkerSettings(context));
	if (observed === undefined) return undefined;
	const content = await send(context.transport, context.token, {
		method: "GET",
		path: workerPath(context),
	});
	if (isNotFound(content))
		return {
			...workerOutputs(context.name, observed),
			ready: false,
			operationConfirmed: false,
			lifecycleStatus: "pending",
		};
	if (content.status !== 200)
		throw new ResolverError(
			"RESOLVER_PROVIDER_REJECTED",
			`Cloudflare Worker content read returned HTTP ${content.status}`,
		);
	const source = parseCloudflareWorkerSource(
		content.body,
		content.headers["content-type"] ?? "",
		optionalString(context.desired, "mainModule") ?? DEFAULT_WORKER_MAIN_MODULE,
	);
	const native = resultObject(
		parseEnvelope(
			await send(context.transport, context.token, {
				method: "GET",
				path: workerPath(context, "/subdomain"),
			}),
			"workers native subdomain",
		),
		"workers native subdomain",
	);
	if (!isJsonBoolean(native.enabled))
		throw new ResolverError(
			"RESOLVER_OUTPUT_UNPARSEABLE",
			"Cloudflare Worker did not report its native subdomain state",
		);
	const requested = optionalBoolean(context.desired, "workersDev"),
		ready =
			workerSettingsMatch(context, observed) &&
			(requested === undefined || requested === native.enabled);
	const outputs: JsonObject = {
		...workerOutputs(context.name, observed),
		artifactDigest: `sha256:${createHash("sha256").update(source).digest("hex")}`,
		workersDev: native.enabled,
		ready,
		operationConfirmed: true,
		lifecycleStatus: ready ? "ready" : "failed",
	};
	if (native.enabled) {
		const account = resultObject(
			parseEnvelope(
				await send(context.transport, context.token, {
					method: "GET",
					path: `/accounts/${encodeURIComponent(context.accountId)}/workers/subdomain`,
				}),
				"workers account subdomain",
			),
			"workers account subdomain",
		);
		const label = optionalString(account, "subdomain");
		if (
			label === undefined ||
			!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(label) ||
			!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(context.name)
		)
			throw new ResolverError(
				"RESOLVER_OUTPUT_UNPARSEABLE",
				"Cloudflare Worker returned an invalid native serving subdomain",
			);
		return {
			...outputs,
			servingEndpoint: `https://${context.name}.${label}.workers.dev`,
		};
	}
	return outputs;
}
async function convergeWorkerSubdomain(
	context: CloudflareResolverContext,
	observed: JsonObject,
): Promise<boolean> {
	const requested = optionalBoolean(context.desired, "workersDev");
	if (requested === undefined || observed.workersDev === requested)
		return false;
	const response = resultObject(
		parseEnvelope(
			await send(context.transport, context.token, {
				method: "POST",
				path: workerPath(context, "/subdomain"),
				json: { enabled: requested },
			}),
			"workers subdomain activation",
		),
		"workers subdomain activation",
	);
	if (response.enabled !== requested)
		throw new ResolverError(
			"RESOLVER_OUTPUT_UNPARSEABLE",
			"Cloudflare did not confirm the requested Worker exposure state",
		);
	return true;
}
const WORKERS_SPEC: Omit<CloudflareResolverSpec, "productId"> = {
	async read(context) {
		assertWorkerRequest(context);
		const observed = await observeWorker(context);
		return observed === undefined
			? undefined
			: outcome(settledAction(context), context.name, observed, []);
	},
	async reconcile(context) {
		assertWorkerRequest(context);
		const settings = await readWorkerSettings(context);
		if (settings === undefined) {
			if (context.knownPhysicalId !== undefined)
				throw new ResolverError(
					"RESOLVER_PRODUCT_UNSUPPORTED",
					"pinned Cloudflare Worker is absent; a fresh allocation requires a new approved identity",
				);
			await uploadWorker(context);
			let observed = await observeWorker(context);
			if (!observed)
				throw new ResolverError(
					"RESOLVER_OUTPUT_UNPARSEABLE",
					"Cloudflare Worker acknowledgment has no independent readback; retain its liability",
				);
			if (await convergeWorkerSubdomain(context, observed))
				observed = await observeWorker(context);
			if (!observed)
				throw new ResolverError(
					"RESOLVER_OUTPUT_UNPARSEABLE",
					"Cloudflare Worker vanished after its mutation acknowledgment",
				);
			return outcome("create", context.name, observed, []);
		}
		let observed = await observeWorker(context, settings);
		if (!observed)
			throw new ResolverError(
				"RESOLVER_OUTPUT_UNPARSEABLE",
				"Cloudflare Worker observation is incomplete",
			);
		let changed = false;
		const script = optionalString(context.desired, "script");
		if (
			script !== undefined &&
			(observed.artifactDigest !==
				`sha256:${createHash("sha256").update(script).digest("hex")}` ||
				!workerSettingsMatch(context, settings))
		) {
			await uploadWorker(context);
			changed = true;
			observed = await observeWorker(context);
			if (!observed)
				throw new ResolverError(
					"RESOLVER_OUTPUT_UNPARSEABLE",
					"Cloudflare Worker update has no independent readback",
				);
		}
		if (await convergeWorkerSubdomain(context, observed)) {
			changed = true;
			observed = await observeWorker(context);
		}
		if (!observed)
			throw new ResolverError(
				"RESOLVER_OUTPUT_UNPARSEABLE",
				"Cloudflare Worker mutation has no independent readback",
			);
		return outcome(
			changed ? "update" : settledAction(context),
			context.name,
			observed,
			[],
		);
	},
	async remove(context) {
		assertWorkerRequest(context);
		const response = await send(context.transport, context.token, {
			method: "DELETE",
			path: workerPath(context),
		});
		if (isNotFound(response)) return;
		parseEnvelope(response, `workers delete ${context.name}`);
	},
};

// ---------------------------------------------------------------------------
// Pages projects — /client/v4/accounts/{account_id}/pages/projects
// ---------------------------------------------------------------------------

function pagesPath(context: CloudflareResolverContext, suffix = ""): string {
	return `/accounts/${encodeURIComponent(context.accountId)}/pages/projects${suffix}`;
}

function pagesOutputs(name: string, record: JsonObject) {
	const subdomain = optionalString(record, "subdomain");
	const productionBranch = optionalString(record, "production_branch");
	return {
		projectName: name,
		...(subdomain !== undefined ? { subdomain } : undefined),
		...(productionBranch !== undefined ? { productionBranch } : undefined),
	};
}

async function readPagesProject(
	context: CloudflareResolverContext,
): Promise<JsonObject | undefined> {
	const response = await send(context.transport, context.token, {
		method: "GET",
		path: pagesPath(context, `/${encodeURIComponent(context.name)}`),
	});
	if (isNotFound(response)) return undefined;
	const label = `pages read project ${context.name}`;
	return resultObject(parseEnvelope(response, label), label);
}

const PAGES_SPEC: Omit<CloudflareResolverSpec, "productId"> = {
	async read(context) {
		const observed = await readPagesProject(context);
		if (observed === undefined) return undefined;
		return outcome(
			settledAction(context),
			context.name,
			pagesOutputs(context.name, observed),
			[],
		);
	},
	async reconcile(context) {
		const observed = await readPagesProject(context);
		const productionBranch = optionalString(
			context.desired,
			"productionBranch",
		);
		if (observed === undefined) {
			const label = `pages create project ${context.name}`;
			const created = resultObject(
				parseEnvelope(
					await send(context.transport, context.token, {
						method: "POST",
						path: pagesPath(context),
						json: {
							name: context.name,
							...(productionBranch !== undefined
								? { production_branch: productionBranch }
								: undefined),
						},
					}),
					label,
				),
				label,
			);
			return outcome(
				"create",
				context.name,
				pagesOutputs(context.name, created),
				[],
			);
		}
		if (
			productionBranch !== undefined &&
			productionBranch !== optionalString(observed, "production_branch")
		) {
			const label = `pages update project ${context.name}`;
			const updated = resultObject(
				parseEnvelope(
					await send(context.transport, context.token, {
						method: "PATCH",
						path: pagesPath(context, `/${encodeURIComponent(context.name)}`),
						json: { production_branch: productionBranch },
					}),
					label,
				),
				label,
			);
			return outcome(
				"update",
				context.name,
				pagesOutputs(context.name, updated),
				[`production branch set to ${productionBranch}`],
			);
		}
		return outcome(
			settledAction(context),
			context.name,
			pagesOutputs(context.name, observed),
			[],
		);
	},
	async remove(context) {
		const response = await send(context.transport, context.token, {
			method: "DELETE",
			path: pagesPath(context, `/${encodeURIComponent(context.name)}`),
		});
		if (isNotFound(response)) return;
		parseEnvelope(response, `pages delete project ${context.name}`);
	},
};

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/**
 * Every Cloudflare resolver, id-sorted so the list is a function of the code
 * rather than of construction order.
 */
export function cloudflareResolvers(
	options: CloudflareResolverOptions,
): readonly ResourceResolver[] {
	const specs: readonly CloudflareResolverSpec[] = [
		{ productId: CLOUDFLARE_D1_PRODUCT_ID, ...D1_SPEC },
		{ productId: CLOUDFLARE_KV_PRODUCT_ID, ...KV_SPEC },
		{ productId: CLOUDFLARE_PAGES_PRODUCT_ID, ...PAGES_SPEC },
		{ productId: CLOUDFLARE_QUEUES_PRODUCT_ID, ...QUEUES_SPEC },
		{ productId: CLOUDFLARE_R2_PRODUCT_ID, ...R2_SPEC },
		{ productId: CLOUDFLARE_WORKERS_PRODUCT_ID, ...WORKERS_SPEC },
	];
	return Object.freeze(
		[...specs]
			.sort((left, right) => compareStrings(left.productId, right.productId))
			.map((spec) => createResolver(spec, options)),
	);
}

/** The same resolvers, behind core's product-id lookup. */
export function cloudflareResolverRegistry(
	options: CloudflareResolverOptions,
): {
	get(productId: string): ResourceResolver | undefined;
	list(): readonly ResourceResolver[];
} {
	return createResolverRegistry(cloudflareResolvers(options));
}
