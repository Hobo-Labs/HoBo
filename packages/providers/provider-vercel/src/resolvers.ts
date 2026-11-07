/**
 * Direct-HTTPS resource resolvers for Vercel (the default deployment path).
 *
 * HoBo's default way to put a resource on Vercel is to call Vercel's documented
 * REST API over the injected, hardened transport in `./transport.ts` — no
 * infrastructure-as-code engine in the middle, no shelling out to a CLI. That
 * is the whole point of the resolver contract: `reconcile` converges one
 * resource, `delete` removes it, `read` recovers its state, and everything the
 * call needs (transport, credential locator resolution) is handed in.
 *
 * Reuse over re-implementation. The HTTPS-only, exact-host-allowlist,
 * path-prefix-allowlist, no-redirect, bounded-body/time boundary is core's
 * `guardTransport` — which generalizes this package's own
 * `createGuardedTransport` and additionally speaks the PATCH that a project
 * update requires. This module supplies the policy: the package's existing
 * `VERCEL_API_ALLOWED_HOSTS` and `DEFAULT_TRANSPORT_POLICY` caps plus the two
 * path prefixes the catalog needs. `VERCEL_API_BASE` and `ApiCallOptions` come
 * from `./management-api.ts`, and provider text is redacted with the package's
 * existing `redactProviderText`. There is exactly one HTTP boundary here.
 *
 * Convergence. Every `reconcile` first looks the resource up — by
 * `ref.physicalId` when the caller has one, otherwise by the deterministic name
 * derived from the request — and only then creates. Running it twice yields one
 * resource and the same `physicalId`; the second run reports `adopt` (the
 * resource exists and the request did not name it) or `noop` (the request named
 * it and nothing differs) rather than pretending it created anything. `replace`
 * is never emitted: nothing here deletes and re-creates a resource behind the
 * caller's back.
 *
 * Credentials are locators. `credentialRef` must parse as a secret-ref URI; a
 * raw token is refused with `RESOLVER_CREDENTIAL_NOT_A_REF` and never echoed
 * into an error message. The value arrives from the injected
 * `resolveCredential` and is held in a `SecretValue`, so only the header builder
 * can see it.
 *
 * HONEST SCOPE: these resolvers are exercised in this repo against an injected
 * fake transport only. Nothing here has been run against api.vercel.com; a live
 * deploy additionally needs real credentials, network egress, and a Vercel
 * account, and none of that is proven by the test suite. Two of the four
 * catalog offerings deliberately have no resolver — see the README table.
 */

import { createHash } from "node:crypto";
import { parseSecretRef, SecretValue } from "@hobo/bindings";
import {
	createResolverRegistry,
	guardTransport,
	type HttpTransport,
	parseResolveRequest,
	RESOLVER_CONTRACT,
	type ResolveOutcome,
	type ResolveRequest,
	type ResolverAction,
	ResolverError,
	type ResourceMutationJournal,
	type ResourceResolver,
	type TransportGuardPolicy,
	type TransportMethod,
	type TransportResponse,
} from "@hobo/core";
import {
	createVercelStaticDeploymentResolver,
	VERCEL_STATIC_DEPLOY_PRODUCT_ID,
} from "./deployment-resolver.js";
import {
	isJsonArray,
	isJsonBoolean,
	isJsonNumber,
	isJsonObject,
	isJsonString,
	type JsonObject,
	type JsonValue,
	parseJsonObject,
	parseJsonValue,
} from "./json.js";
import { type ApiCallOptions, VERCEL_API_BASE } from "./management-api.js";
import { PROVIDER_TARGET } from "./options.js";
import { redactProviderText } from "./provider-errors.js";
import {
	VERCEL_EDGE_CONFIG_PRODUCT_ID,
	VERCEL_PROJECT_PRODUCT_ID,
} from "./slots.js";
import {
	DEFAULT_TRANSPORT_POLICY,
	VERCEL_API_ALLOWED_HOSTS,
} from "./transport.js";

/**
 * Path prefixes the resolvers reach, each pinned to a documented endpoint:
 * `POST /v9/projects`, `GET|PATCH|DELETE /v9/projects/{idOrName}`, and the
 * Global Config family `POST|GET /v1/global-config` plus
 * `GET|PUT|DELETE /v1/global-config/{edgeConfigId}`.
 */
export const VERCEL_RESOLVER_PATH_PREFIXES = Object.freeze([
	"/v1/global-config",
	"/v9/projects",
] as const);

/**
 * The policy every resolver call is guarded by. The host allowlist and the
 * body/time caps are the package's existing hardened values; the guard itself
 * is core's, which generalizes this package's `createGuardedTransport` and
 * additionally speaks PATCH (which `POST /v9/projects` updates require).
 */
export const VERCEL_RESOLVER_TRANSPORT_POLICY: TransportGuardPolicy =
	Object.freeze({
		allowedHosts: VERCEL_API_ALLOWED_HOSTS,
		allowedPathPrefixes: VERCEL_RESOLVER_PATH_PREFIXES,
		maxResponseBytes: DEFAULT_TRANSPORT_POLICY.maxResponseBytes,
		maxTimeoutMs: DEFAULT_TRANSPORT_POLICY.timeoutMs,
	});

const DEFAULT_CALL: Required<ApiCallOptions> = {
	timeoutMs: DEFAULT_TRANSPORT_POLICY.timeoutMs,
	maxResponseBytes: DEFAULT_TRANSPORT_POLICY.maxResponseBytes,
};

/** What a host hands the resolvers so they can reach the provider at all. */
export type VercelResolverOptions = {
	/**
	 * Resolve a secret **locator** into its value. Injected because custody is
	 * the host's business: this module never reads an environment variable and
	 * never accepts a raw token.
	 */
	readonly resolveCredential: (credentialRef: string) => Promise<string>;
	/** Team the resources live in, when the token is team-scoped. */
	readonly teamId?: string;
	readonly call?: ApiCallOptions;
	readonly mutationJournal?: ResourceMutationJournal;
	readonly artifactTransport?: HttpTransport;
	readonly maxArtifactBytes?: number;
	readonly maxArtifactFiles?: number;
};

type Dispatch = HttpTransport;

/**
 * Wrap the injected transport in the hardened guard. Nothing in this module
 * calls the network directly, and no unguarded transport is ever handed a
 * credential.
 */
function guardedDispatch(
	transport: HttpTransport,
	options: VercelResolverOptions,
	request: ResolveRequest,
): Dispatch {
	const dispatch = guardTransport(transport, VERCEL_RESOLVER_TRANSPORT_POLICY);
	return async (outbound) => {
		if (outbound.method !== "POST") return dispatch(outbound);
		if (options.mutationJournal?.persistence !== "durable-cas")
			throw new ResolverError(
				"RESOLVER_PRODUCT_UNSUPPORTED",
				"vercel resource creation requires a durable mutation journal",
			);
		const mutationId = JSON.stringify([
			"vercel",
			options.teamId ?? "personal",
			request.ref.productId,
			request.ref.logicalId,
			outbound.url,
		]);
		const requestDigest = `sha256:${createHash("sha256")
			.update(JSON.stringify({ url: outbound.url, body: outbound.body ?? "" }))
			.digest("hex")}`;
		const claim = await options.mutationJournal.claim({
			mutationId,
			requestDigest,
		});
		if (claim.status !== "claimed")
			throw new ResolverError(
				"RESOLVER_PROVIDER_REJECTED",
				"vercel creation was already attempted; observe its result instead of repeating POST",
			);
		try {
			const response = await dispatch(outbound);
			if (response.status >= 200 && response.status < 300)
				await options.mutationJournal.acknowledge(mutationId, requestDigest);
			else await options.mutationJournal.uncertain(mutationId, requestDigest);
			return response;
		} catch (error) {
			await options.mutationJournal.uncertain(mutationId, requestDigest);
			throw error;
		}
	};
}

type ApiRequest = {
	readonly method: TransportMethod;
	readonly path: string;
	readonly body?: JsonObject;
};

async function callApi(
	dispatch: Dispatch,
	credential: SecretValue,
	request: ApiRequest,
	options: ApiCallOptions,
): Promise<TransportResponse> {
	const body =
		request.body === undefined ? undefined : JSON.stringify(request.body);
	const response = await dispatch({
		method: request.method,
		url: `${VERCEL_API_BASE}${request.path}`,
		headers: {
			// The one place the value is exposed. It never reaches a template
			// literal that could end up in a log line or a receipt.
			authorization: `Bearer ${credential.expose()}`,
			accept: "application/json",
			...(body !== undefined
				? { "content-type": "application/json" }
				: undefined),
		},
		...(body !== undefined ? { body } : undefined),
		timeoutMs: options.timeoutMs ?? DEFAULT_CALL.timeoutMs,
		maxResponseBytes: options.maxResponseBytes ?? DEFAULT_CALL.maxResponseBytes,
	});
	return response.status >= 200 && response.status < 300
		? response
		: {
				...response,
				body: response.body.replaceAll(credential.expose(), "[redacted]"),
			};
}

function teamQuery(teamId: string | undefined): string {
	return teamId === undefined ? "" : `?teamId=${encodeURIComponent(teamId)}`;
}

/**
 * A provider refusal, with the provider's own message redacted of anything
 * token-shaped. Vercel error bodies echo request payloads, and an error message
 * is the one string that reliably reaches a log, a receipt, and a support
 * ticket.
 */
function providerRejected(
	operation: string,
	status: number,
	body: string,
): ResolverError {
	return new ResolverError(
		"RESOLVER_PROVIDER_REJECTED",
		`vercel rejected ${operation} with status ${status}: ${vercelErrorMessage(body)}`,
	);
}

function vercelErrorMessage(body: string): string {
	const parsed = parseJsonValue(body);
	if (isJsonObject(parsed) && isJsonObject(parsed.error)) {
		const message = parsed.error.message;
		const code = parsed.error.code;
		if (isJsonString(message) && message.length > 0) {
			return isJsonString(code) && code.length > 0
				? `${redactProviderText(code, 60)}: ${redactProviderText(message, 180)}`
				: redactProviderText(message, 180);
		}
	}
	return body.length === 0 ? "no error body" : redactProviderText(body, 180);
}

function unparseable(operation: string, why: string): ResolverError {
	return new ResolverError(
		"RESOLVER_OUTPUT_UNPARSEABLE",
		`vercel response to ${operation} could not be parsed: ${why}`,
	);
}

function readJsonObject(body: string, operation: string): JsonObject {
	let parsed: JsonValue;
	try {
		// SAFETY: JSON.parse yields a JSON value at this document boundary.
		parsed = JSON.parse(body) as JsonValue;
	} catch {
		throw unparseable(operation, "the body is not JSON");
	}
	if (!isJsonObject(parsed)) {
		throw unparseable(operation, "the body is not a JSON object");
	}
	return parsed;
}

function readJsonArray(body: string, operation: string): JsonValue[] {
	let parsed: JsonValue;
	try {
		// SAFETY: JSON.parse yields a JSON value at this document boundary.
		parsed = JSON.parse(body) as JsonValue;
	} catch {
		throw unparseable(operation, "the body is not JSON");
	}
	if (!isJsonArray(parsed)) {
		throw unparseable(
			operation,
			"the documented list response is a JSON array and this body is not one",
		);
	}
	return parsed;
}

function requiredString(
	record: JsonObject,
	key: string,
	operation: string,
): string {
	const value = record[key];
	if (!isJsonString(value) || value.length === 0) {
		throw unparseable(operation, `the documented ${key} field is missing`);
	}
	return value;
}

function optionalString(record: JsonObject, key: string): string | undefined {
	const value = record[key];
	return isJsonString(value) && value.length > 0 ? value : undefined;
}

function desiredOf(request: ResolveRequest): JsonObject {
	return parseJsonObject(JSON.stringify(request.desired));
}

/**
 * A field this resolver knows how to send. Anything else in `desired` is
 * refused rather than dropped: a silently ignored setting is a deployment that
 * does not match what was asked for.
 */
function desiredString(
	desired: JsonObject,
	key: string,
	productId: string,
): string | undefined {
	const value = desired[key];
	if (value === undefined) return undefined;
	if (!isJsonString(value) || value.length === 0) {
		throw new ResolverError(
			"RESOLVER_PRODUCT_UNSUPPORTED",
			`${productId} accepts ${key} only as a non-empty string; received ${describe(value)}`,
		);
	}
	return value;
}

function describe(value: JsonValue): string {
	if (value === null) return "null";
	if (isJsonArray(value)) return "an array";
	if (isJsonObject(value)) return "an object";
	if (isJsonBoolean(value)) return "a boolean";
	if (isJsonNumber(value)) return "a number";
	return "a string";
}

/**
 * Derive a deterministic, provider-legal name. Same request in, same name out —
 * this is what makes lookup-before-create a real idempotency key rather than a
 * hope.
 */
function deterministicName(
	raw: string,
	allowed: RegExp,
	maxLength: number,
	productId: string,
): string {
	const name = raw
		.toLowerCase()
		.replace(allowed, "-")
		.replace(/-+/gu, "-")
		.replace(/^-+|-+$/gu, "")
		.slice(0, maxLength)
		.replace(/-+$/gu, "");
	if (name.length === 0) {
		throw new ResolverError(
			"RESOLVER_PRODUCT_UNSUPPORTED",
			`${productId} needs a deterministic name and none could be derived from the request's logicalId; give the resource a name in desired`,
		);
	}
	return name;
}

function outcomeOf(
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

function assertProduct(request: ResolveRequest, productId: string): void {
	if (request.ref.productId !== productId) {
		throw new ResolverError(
			"RESOLVER_PRODUCT_UNSUPPORTED",
			`this resolver handles ${productId}; the request names ${JSON.stringify(request.ref.productId)}`,
		);
	}
}

/**
 * Turn the locator into a usable value, refusing both a raw credential and a
 * locator custody cannot answer for.
 */
async function resolveCredential(
	options: VercelResolverOptions,
	credentialRef: string,
): Promise<SecretValue> {
	let ref: ReturnType<typeof parseSecretRef>;
	try {
		ref = parseSecretRef(credentialRef);
	} catch {
		// The rejected input is deliberately not interpolated: it is frequently
		// the plaintext credential someone passed where a locator belongs.
		throw new ResolverError(
			"RESOLVER_CREDENTIAL_NOT_A_REF",
			"credentialRef must be a secret locator URI (for example hobo-token://vercel/deploy), not a credential value; deposit the token in custody and reference it",
		);
	}
	let value: string;
	try {
		value = await options.resolveCredential(ref.ref);
	} catch {
		throw new ResolverError(
			"RESOLVER_CREDENTIAL_MISSING",
			"custody could not resolve the referenced vercel credential; deposit a scoped Vercel API token under that locator and grant this deployer read access to it",
		);
	}
	if (value.trim().length === 0) {
		throw new ResolverError(
			"RESOLVER_CREDENTIAL_MISSING",
			"custody returned no value for the referenced vercel credential; deposit a scoped Vercel API token under that locator before deploying",
		);
	}
	return new SecretValue(ref, value);
}

/**
 * The caller's last-known physical id, from the ref or from a prior
 * observation. Used for state recovery: it is what lets a reconcile after a
 * rename still find the resource it created.
 */
function knownPhysicalId(request: ResolveRequest): string | undefined {
	if (request.ref.physicalId !== undefined && request.ref.physicalId.length > 0)
		return request.ref.physicalId;
	const observed = request.observed;
	if (observed === undefined) return undefined;
	return optionalString(parseJsonObject(JSON.stringify(observed)), "id");
}

// --------------------------------------------------------------------------
// vercel.project/v1 — POST /v9/projects, GET|PATCH|DELETE /v9/projects/{id}
// --------------------------------------------------------------------------

type ProjectView = {
	readonly id: string;
	readonly name: string;
	readonly accountId?: string;
	readonly framework?: string;
	readonly rootDirectory?: string;
	readonly buildCommand?: string;
	readonly outputDirectory?: string;
};

/** Settings this resolver sends. `name` doubles as the idempotency key. */
const PROJECT_SETTINGS = Object.freeze([
	"buildCommand",
	"framework",
	"outputDirectory",
	"rootDirectory",
] as const);

function parseProjectView(body: string, operation: string): ProjectView {
	const record = readJsonObject(body, operation);
	const accountId = optionalString(record, "accountId");
	const framework = optionalString(record, "framework");
	const rootDirectory = optionalString(record, "rootDirectory");
	const buildCommand = optionalString(record, "buildCommand");
	const outputDirectory = optionalString(record, "outputDirectory");
	return {
		id: requiredString(record, "id", operation),
		name: requiredString(record, "name", operation),
		...(accountId !== undefined ? { accountId } : undefined),
		...(framework !== undefined ? { framework } : undefined),
		...(rootDirectory !== undefined ? { rootDirectory } : undefined),
		...(buildCommand !== undefined ? { buildCommand } : undefined),
		...(outputDirectory !== undefined ? { outputDirectory } : undefined),
	};
}

type ProjectOutputs = {
	readonly id: string;
	readonly name: string;
	readonly accountId?: string;
	readonly framework?: string;
	readonly rootDirectory?: string;
	readonly buildCommand?: string;
	readonly outputDirectory?: string;
};

function projectOutputs(view: ProjectView): ProjectOutputs {
	return {
		id: view.id,
		name: view.name,
		...(view.accountId !== undefined
			? { accountId: view.accountId }
			: undefined),
		...(view.framework !== undefined
			? { framework: view.framework }
			: undefined),
		...(view.rootDirectory !== undefined
			? { rootDirectory: view.rootDirectory }
			: undefined),
		...(view.buildCommand !== undefined
			? { buildCommand: view.buildCommand }
			: undefined),
		...(view.outputDirectory !== undefined
			? { outputDirectory: view.outputDirectory }
			: undefined),
	};
}

type ProjectSettings = {
	readonly name?: string;
	readonly buildCommand?: string;
	readonly framework?: string;
	readonly outputDirectory?: string;
	readonly rootDirectory?: string;
};

type ProjectDesired = {
	readonly name: string;
	readonly settings: ProjectSettings;
};

function parseProjectDesired(request: ResolveRequest): ProjectDesired {
	const desired = desiredOf(request);
	for (const key of Object.keys(desired))
		if (!["name", "operationId", ...PROJECT_SETTINGS].includes(key))
			throw new ResolverError(
				"RESOLVER_PRODUCT_UNSUPPORTED",
				"vercel project desired contains an unsupported setting",
			);
	const named = desiredString(desired, "name", VERCEL_PROJECT_PRODUCT_ID);
	const name = deterministicName(
		named ?? request.ref.logicalId,
		/[^a-z0-9._-]+/gu,
		100,
		VERCEL_PROJECT_PRODUCT_ID,
	);
	let settings: ProjectSettings = {};
	for (const key of PROJECT_SETTINGS) {
		const value = desiredString(desired, key, VERCEL_PROJECT_PRODUCT_ID);
		if (value !== undefined) settings = { ...settings, [key]: value };
	}
	return { name, settings };
}

async function getProjectView(
	dispatch: Dispatch,
	credential: SecretValue,
	options: VercelResolverOptions,
	idOrName: string,
	byPhysicalId = false,
): Promise<ProjectView | undefined> {
	const operation = "GET /v9/projects/{idOrName}";
	const response = await callApi(
		dispatch,
		credential,
		{
			method: "GET",
			path: `/v9/projects/${encodeURIComponent(idOrName)}${teamQuery(options.teamId)}`,
		},
		options.call ?? {},
	);
	if (response.status === 404) return undefined;
	if (response.status !== 200) {
		throw providerRejected(operation, response.status, response.body);
	}
	const view = parseProjectView(response.body, operation);
	assertProjectIdentity(view, options, idOrName, byPhysicalId);
	return view;
}

function assertProjectIdentity(
	view: ProjectView,
	options: VercelResolverOptions,
	expected: string,
	byPhysicalId: boolean,
): void {
	if ((byPhysicalId ? view.id : view.name) !== expected)
		throw unparseable(
			"project observation",
			"returned project identity differs from the requested resource",
		);
	if (options.teamId !== undefined && view.accountId !== options.teamId)
		throw unparseable(
			"project observation",
			"returned project belongs to a different team",
		);
}

function projectDelta(
	desired: ProjectDesired,
	observed: ProjectView,
): ProjectSettings {
	let delta: ProjectSettings = {};
	if (desired.name !== observed.name) delta = { ...delta, name: desired.name };
	for (const key of PROJECT_SETTINGS) {
		const want = desired.settings[key];
		if (want !== undefined && want !== observed[key]) {
			delta = { ...delta, [key]: want };
		}
	}
	return delta;
}

function createProjectResolver(
	options: VercelResolverOptions,
): ResourceResolver {
	return {
		providerId: PROVIDER_TARGET,
		productId: VERCEL_PROJECT_PRODUCT_ID,

		async reconcile(request, transport) {
			// Round-trip so an already-typed `ResolveRequest` can go back through
			// core's parse boundary, which takes untrusted JSON while the resolver
			// port hands this method the domain type. Same idiom as `desired` above.
			const parsed = parseResolveRequest(
				parseJsonObject(JSON.stringify(request)),
			);
			assertProduct(parsed, VERCEL_PROJECT_PRODUCT_ID);
			const credential = await resolveCredential(options, parsed.credentialRef);
			const dispatch = guardedDispatch(transport, options, parsed);
			const desired = parseProjectDesired(parsed);
			const known = knownPhysicalId(parsed);
			const observed = await getProjectView(
				dispatch,
				credential,
				options,
				known ?? desired.name,
				known !== undefined,
			);

			if (observed === undefined) {
				if (known !== undefined)
					throw new ResolverError(
						"RESOLVER_PRODUCT_UNSUPPORTED",
						"known vercel project is absent; a fresh resource needs a new approved identity",
					);
				const operation = "POST /v9/projects";
				const response = await callApi(
					dispatch,
					credential,
					{
						method: "POST",
						path: `/v9/projects${teamQuery(options.teamId)}`,
						body: { name: desired.name, ...desired.settings },
					},
					options.call ?? {},
				);
				if (response.status !== 200 && response.status !== 201) {
					throw providerRejected(operation, response.status, response.body);
				}
				const view = parseProjectView(response.body, operation);
				assertProjectIdentity(view, options, desired.name, false);
				return outcomeOf("create", view.id, projectOutputs(view), [
					`created vercel project ${view.name}`,
				]);
			}

			const delta = projectDelta(desired, observed);
			if (Object.keys(delta).length === 0) {
				return known === undefined
					? outcomeOf("adopt", observed.id, projectOutputs(observed), [
							`adopted the existing vercel project ${observed.name}; it matches the desired settings and this run did not create it`,
						])
					: outcomeOf("noop", observed.id, projectOutputs(observed), [
							`vercel project ${observed.name} already matches the desired settings`,
						]);
			}

			const operation = "PATCH /v9/projects/{idOrName}";
			const response = await callApi(
				dispatch,
				credential,
				{
					method: "PATCH",
					path: `/v9/projects/${encodeURIComponent(observed.id)}${teamQuery(options.teamId)}`,
					body: delta,
				},
				options.call ?? {},
			);
			if (response.status !== 200) {
				throw providerRejected(operation, response.status, response.body);
			}
			const view = parseProjectView(response.body, operation);
			assertProjectIdentity(view, options, observed.id, true);
			return outcomeOf("update", view.id, projectOutputs(view), [
				`updated ${Object.keys(delta).sort().join(", ")} on vercel project ${view.name}`,
			]);
		},

		async delete(request, transport) {
			// Round-trip so an already-typed `ResolveRequest` can go back through
			// core's parse boundary, which takes untrusted JSON while the resolver
			// port hands this method the domain type. Same idiom as `desired` above.
			const parsed = parseResolveRequest(
				parseJsonObject(JSON.stringify(request)),
			);
			assertProduct(parsed, VERCEL_PROJECT_PRODUCT_ID);
			const credential = await resolveCredential(options, parsed.credentialRef);
			const dispatch = guardedDispatch(transport, options, parsed);
			const target =
				knownPhysicalId(parsed) ?? parseProjectDesired(parsed).name;
			if (
				!(await getProjectView(
					dispatch,
					credential,
					options,
					target,
					knownPhysicalId(parsed) !== undefined,
				))
			)
				return;
			const operation = "DELETE /v9/projects/{idOrName}";
			const response = await callApi(
				dispatch,
				credential,
				{
					method: "DELETE",
					path: `/v9/projects/${encodeURIComponent(target)}${teamQuery(options.teamId)}`,
				},
				options.call ?? {},
			);
			// A project that is already gone is the state delete asks for.
			if (response.status === 404) return;
			if (
				response.status !== 200 &&
				response.status !== 202 &&
				response.status !== 204
			) {
				throw providerRejected(operation, response.status, response.body);
			}
		},

		async read(request, transport) {
			// Round-trip so an already-typed `ResolveRequest` can go back through
			// core's parse boundary, which takes untrusted JSON while the resolver
			// port hands this method the domain type. Same idiom as `desired` above.
			const parsed = parseResolveRequest(
				parseJsonObject(JSON.stringify(request)),
			);
			assertProduct(parsed, VERCEL_PROJECT_PRODUCT_ID);
			const credential = await resolveCredential(options, parsed.credentialRef);
			const dispatch = guardedDispatch(transport, options, parsed);
			const known = knownPhysicalId(parsed);
			const target = known ?? parseProjectDesired(parsed).name;
			const view = await getProjectView(
				dispatch,
				credential,
				options,
				target,
				known !== undefined,
			);
			return view === undefined
				? undefined
				: outcomeOf("noop", view.id, projectOutputs(view), [
						`read vercel project ${view.name}`,
					]);
		},
	};
}

// --------------------------------------------------------------------------
// vercel.edge-config/v1 — the documented Global Config REST family
// POST|GET /v1/global-config, GET|PUT|DELETE /v1/global-config/{edgeConfigId}
// --------------------------------------------------------------------------

type EdgeConfigView = {
	readonly id: string;
	readonly slug: string;
	readonly ownerId?: string;
	readonly digest?: string;
};

function parseEdgeConfigView(
	record: JsonObject,
	operation: string,
): EdgeConfigView {
	const ownerId = optionalString(record, "ownerId");
	const digest = optionalString(record, "digest");
	return {
		id: requiredString(record, "id", operation),
		slug: requiredString(record, "slug", operation),
		...(ownerId !== undefined ? { ownerId } : undefined),
		...(digest !== undefined ? { digest } : undefined),
	};
}

type EdgeConfigOutputs = {
	readonly id: string;
	readonly slug: string;
	readonly ownerId?: string;
	readonly digest?: string;
};

function edgeConfigOutputs(view: EdgeConfigView): EdgeConfigOutputs {
	return {
		id: view.id,
		slug: view.slug,
		...(view.ownerId !== undefined ? { ownerId: view.ownerId } : undefined),
		...(view.digest !== undefined ? { digest: view.digest } : undefined),
	};
}

function parseEdgeConfigSlug(request: ResolveRequest): string {
	for (const key of Object.keys(request.desired))
		if (!["slug", "operationId"].includes(key))
			throw new ResolverError(
				"RESOLVER_PRODUCT_UNSUPPORTED",
				"vercel edge config desired contains an unsupported setting",
			);
	const named = desiredString(
		desiredOf(request),
		"slug",
		VERCEL_EDGE_CONFIG_PRODUCT_ID,
	);
	// Documented slug rule: alphanumeric plus underscore/hyphen, max 32 chars.
	return deterministicName(
		named ?? request.ref.logicalId,
		/[^a-z0-9_-]+/gu,
		32,
		VERCEL_EDGE_CONFIG_PRODUCT_ID,
	);
}

async function getEdgeConfigById(
	dispatch: Dispatch,
	credential: SecretValue,
	options: VercelResolverOptions,
	id: string,
): Promise<EdgeConfigView | undefined> {
	const operation = "GET /v1/global-config/{edgeConfigId}";
	const response = await callApi(
		dispatch,
		credential,
		{
			method: "GET",
			path: `/v1/global-config/${encodeURIComponent(id)}${teamQuery(options.teamId)}`,
		},
		options.call ?? {},
	);
	if (response.status === 404) return undefined;
	if (response.status !== 200) {
		throw providerRejected(operation, response.status, response.body);
	}
	const view = parseEdgeConfigView(
		readJsonObject(response.body, operation),
		operation,
	);
	if (
		view.id !== id ||
		(options.teamId !== undefined && view.ownerId !== options.teamId)
	)
		throw unparseable(
			operation,
			"edge config identity or owning team differs from the approved resource",
		);
	return view;
}

/**
 * There is no documented get-by-slug endpoint, so discovery by deterministic
 * name goes through the documented list endpoint and matches on `slug`.
 */
async function findEdgeConfigBySlug(
	dispatch: Dispatch,
	credential: SecretValue,
	options: VercelResolverOptions,
	slug: string,
): Promise<EdgeConfigView | undefined> {
	const operation = "GET /v1/global-config";
	const response = await callApi(
		dispatch,
		credential,
		{ method: "GET", path: `/v1/global-config${teamQuery(options.teamId)}` },
		options.call ?? {},
	);
	if (response.status !== 200) {
		throw providerRejected(operation, response.status, response.body);
	}
	const matches: EdgeConfigView[] = [];
	for (const entry of readJsonArray(response.body, operation)) {
		if (!isJsonObject(entry))
			throw unparseable(operation, "a list entry is not a JSON object");
		if (entry.slug === slug) {
			const view = parseEdgeConfigView(entry, operation);
			if (options.teamId !== undefined && view.ownerId !== options.teamId)
				throw unparseable(operation, "edge config belongs to a different team");
			matches.push(view);
		}
	}
	if (matches.length > 1)
		throw unparseable(operation, "multiple edge configs claim the same name");
	return matches[0];
}

async function lookupEdgeConfig(
	dispatch: Dispatch,
	credential: SecretValue,
	options: VercelResolverOptions,
	known: string | undefined,
	slug: string,
): Promise<EdgeConfigView | undefined> {
	return known === undefined
		? findEdgeConfigBySlug(dispatch, credential, options, slug)
		: getEdgeConfigById(dispatch, credential, options, known);
}

function createEdgeConfigResolver(
	options: VercelResolverOptions,
): ResourceResolver {
	return {
		providerId: PROVIDER_TARGET,
		productId: VERCEL_EDGE_CONFIG_PRODUCT_ID,

		async reconcile(request, transport) {
			// Round-trip so an already-typed `ResolveRequest` can go back through
			// core's parse boundary, which takes untrusted JSON while the resolver
			// port hands this method the domain type. Same idiom as `desired` above.
			const parsed = parseResolveRequest(
				parseJsonObject(JSON.stringify(request)),
			);
			assertProduct(parsed, VERCEL_EDGE_CONFIG_PRODUCT_ID);
			const credential = await resolveCredential(options, parsed.credentialRef);
			const dispatch = guardedDispatch(transport, options, parsed);
			const slug = parseEdgeConfigSlug(parsed);
			const known = knownPhysicalId(parsed);
			const observed = await lookupEdgeConfig(
				dispatch,
				credential,
				options,
				known,
				slug,
			);

			if (observed === undefined) {
				if (known !== undefined)
					throw new ResolverError(
						"RESOLVER_PRODUCT_UNSUPPORTED",
						"known vercel edge config is absent; fresh allocation requires a new approved identity",
					);
				const operation = "POST /v1/global-config";
				const response = await callApi(
					dispatch,
					credential,
					{
						method: "POST",
						path: `/v1/global-config${teamQuery(options.teamId)}`,
						body: { slug },
					},
					options.call ?? {},
				);
				if (response.status !== 200 && response.status !== 201) {
					throw providerRejected(operation, response.status, response.body);
				}
				const view = parseEdgeConfigView(
					readJsonObject(response.body, operation),
					operation,
				);
				if (
					view.slug !== slug ||
					(options.teamId !== undefined && view.ownerId !== options.teamId)
				)
					throw unparseable(
						operation,
						"created edge config identity differs from approved scope",
					);
				return outcomeOf("create", view.id, edgeConfigOutputs(view), [
					`created vercel edge config ${view.slug}`,
				]);
			}

			if (observed.slug === slug) {
				return known === undefined
					? outcomeOf("adopt", observed.id, edgeConfigOutputs(observed), [
							`adopted the existing vercel edge config ${observed.slug}; this run did not create it`,
						])
					: outcomeOf("noop", observed.id, edgeConfigOutputs(observed), [
							`vercel edge config ${observed.slug} already matches the desired slug`,
						]);
			}

			const operation = "PUT /v1/global-config/{edgeConfigId}";
			const response = await callApi(
				dispatch,
				credential,
				{
					method: "PUT",
					path: `/v1/global-config/${encodeURIComponent(observed.id)}${teamQuery(options.teamId)}`,
					body: { slug },
				},
				options.call ?? {},
			);
			if (response.status !== 200) {
				throw providerRejected(operation, response.status, response.body);
			}
			const view = parseEdgeConfigView(
				readJsonObject(response.body, operation),
				operation,
			);
			if (
				view.id !== observed.id ||
				view.slug !== slug ||
				(options.teamId !== undefined && view.ownerId !== options.teamId)
			)
				throw unparseable(
					operation,
					"updated edge config identity differs from approved scope",
				);
			return outcomeOf("update", view.id, edgeConfigOutputs(view), [
				`renamed vercel edge config ${observed.slug} to ${view.slug}`,
			]);
		},

		async delete(request, transport) {
			// Round-trip so an already-typed `ResolveRequest` can go back through
			// core's parse boundary, which takes untrusted JSON while the resolver
			// port hands this method the domain type. Same idiom as `desired` above.
			const parsed = parseResolveRequest(
				parseJsonObject(JSON.stringify(request)),
			);
			assertProduct(parsed, VERCEL_EDGE_CONFIG_PRODUCT_ID);
			const credential = await resolveCredential(options, parsed.credentialRef);
			const dispatch = guardedDispatch(transport, options, parsed);
			const known = knownPhysicalId(parsed);
			const target =
				known ??
				(
					await findEdgeConfigBySlug(
						dispatch,
						credential,
						options,
						parseEdgeConfigSlug(parsed),
					)
				)?.id;
			// Nothing to delete is the state delete asks for.
			if (target === undefined) return;
			if (!(await getEdgeConfigById(dispatch, credential, options, target)))
				return;
			const operation = "DELETE /v1/global-config/{edgeConfigId}";
			const response = await callApi(
				dispatch,
				credential,
				{
					method: "DELETE",
					path: `/v1/global-config/${encodeURIComponent(target)}${teamQuery(options.teamId)}`,
				},
				options.call ?? {},
			);
			if (response.status === 404) return;
			if (
				response.status !== 200 &&
				response.status !== 202 &&
				response.status !== 204
			) {
				throw providerRejected(operation, response.status, response.body);
			}
		},

		async read(request, transport) {
			// Round-trip so an already-typed `ResolveRequest` can go back through
			// core's parse boundary, which takes untrusted JSON while the resolver
			// port hands this method the domain type. Same idiom as `desired` above.
			const parsed = parseResolveRequest(
				parseJsonObject(JSON.stringify(request)),
			);
			assertProduct(parsed, VERCEL_EDGE_CONFIG_PRODUCT_ID);
			const credential = await resolveCredential(options, parsed.credentialRef);
			const dispatch = guardedDispatch(transport, options, parsed);
			const view = await lookupEdgeConfig(
				dispatch,
				credential,
				options,
				knownPhysicalId(parsed),
				parseEdgeConfigSlug(parsed),
			);
			return view === undefined
				? undefined
				: outcomeOf("noop", view.id, edgeConfigOutputs(view), [
						`read vercel edge config ${view.slug}`,
					]);
		},
	};
}

/**
 * Product ids this package catalogs but deliberately cannot resolve.
 *
 * `vercel.edge-function/v1`: functions are produced by a deployment, and Vercel
 * documents no endpoint that creates one as a standalone resource.
 * `vercel.blob/v1`: `POST /storage/stores/blob`, `GET /storage/stores/{id}` and
 * `DELETE /storage/stores/blob/{id}` are documented, but no documented endpoint
 * lists stores by name — without name lookup, `reconcile` could not discover an
 * existing store and would create a second one on every retry. A silently
 * non-convergent resolver is worse than an absent one, so it is absent.
 */
export const VERCEL_UNRESOLVED_PRODUCT_IDS = Object.freeze([
	"vercel.blob/v1",
	"vercel.edge-function/v1",
] as const);

/**
 * Every product this module resolves, id-sorted for a deterministic registry.
 *
 * Declared as data rather than left implicit in {@link vercelResolvers},
 * because the other four provider packages all publish this pair and anything
 * that reports coverage across providers — the live-provider matrix, a Station
 * capability report, a reader counting what actually ships — has to enumerate
 * one list per provider. Vercel exported only the *unresolved* half, so a
 * caller reading the pair uniformly saw Vercel as zero-of-two rather than
 * two-of-four, which understates it by exactly the products that do work.
 */
export const VERCEL_RESOLVED_PRODUCT_IDS = Object.freeze([
	"vercel.edge-config/v1",
	"vercel.project/v1",
	VERCEL_STATIC_DEPLOY_PRODUCT_ID,
] as const);

/**
 * Every Vercel product this package can resolve over the REST API, ordered by
 * product id so two builds of the registry are identical.
 *
 * `vercel.blob/v1` and `vercel.edge-function/v1` are deliberately absent —
 * see {@link VERCEL_UNRESOLVED_PRODUCT_IDS} and the README.
 */
export function vercelResolvers(
	options: VercelResolverOptions,
): readonly ResourceResolver[] {
	return Object.freeze([
		createEdgeConfigResolver(options),
		createProjectResolver(options),
		createVercelStaticDeploymentResolver(options),
	]);
}

/** The same resolvers behind core's registry lookup. */
export function vercelResolverRegistry(options: VercelResolverOptions): {
	get(productId: string): ResourceResolver | undefined;
	list(): readonly ResourceResolver[];
} {
	return createResolverRegistry(vercelResolvers(options));
}
