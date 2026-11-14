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
 * account, and none of that is proven by the test suite. Standalone edge
 * functions deliberately have no resolver — see the README table.
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
	ResourceMutationNotSentError,
	type ResourceResolver,
	TransportGuardError,
	type TransportGuardPolicy,
	type TransportMethod,
	type TransportResponse,
} from "@hobo/core";
import {
	instrumentResolvers,
	type ResolverTelemetryOptions,
} from "./delivery-coverage.js";
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
	VERCEL_BLOB_PRODUCT_ID,
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
	"/v1/storage/stores",
	"/v9/projects",
	"/v11/projects",
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
	/** Cross-process serialization for a store and its project connections. */
	readonly mutationScope?: {
		readonly persistence: "durable-cas";
		run<T>(
			scope: {
				readonly providerId: string;
				readonly providerAccountId: string;
				readonly parentId: string;
			},
			action: () => Promise<T>,
		): Promise<T>;
	};
	readonly artifactTransport?: HttpTransport;
	readonly maxArtifactBytes?: number;
	readonly maxArtifactFiles?: number;
	/** Independently authorize adopting and linking an existing unlinked
	 * project to this exact repository under the approved operation. */
	readonly verifyUnlinkedProject?: (input: {
		readonly teamId: string;
		readonly projectId: string;
		readonly repository: string;
		readonly operationId: string;
	}) => Promise<boolean>;
	/** Trusted durable fence and accounting proof: no queued, delayed or leased
	 * messages remain and producers stay fenced until the deployment is gone. */
	readonly verifyQueueDrain?: (input: {
		readonly teamId: string;
		readonly projectId: string;
		readonly deploymentId: string;
		readonly revision: string;
		readonly topic: string;
		readonly entry: string;
	}) => Promise<{
		readonly drained: boolean;
		readonly fencedUntilRetired: boolean;
		readonly evidenceRef: string;
	}>;
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
			...(request.ref.productId === VERCEL_BLOB_PRODUCT_ID ||
			(request.ref.productId === VERCEL_PROJECT_PRODUCT_ID &&
				request.desired.operationId !== undefined)
				? [request.desired.operationId ?? ""]
				: []),
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
	readonly oidc?: boolean;
};

async function callApi(
	dispatch: Dispatch,
	credential: SecretValue,
	request: ApiRequest,
	options: ApiCallOptions,
): Promise<TransportResponse> {
	const body =
		request.body === undefined ? undefined : JSON.stringify(request.body);
	let response: TransportResponse;
	try {
		response = await dispatch({
			method: request.method,
			url: `${VERCEL_API_BASE}${request.path}`,
			headers: {
				// The one place the value is exposed. It never reaches a template
				// literal that could end up in a log line or a receipt.
				authorization: `Bearer ${credential.expose()}`,
				accept: "application/json",
				...(request.oidc ? { "x-vercel-use-oidc": "1" } : undefined),
				...(body !== undefined
					? { "content-type": "application/json" }
					: undefined),
			},
			...(body !== undefined ? { body } : undefined),
			timeoutMs: options.timeoutMs ?? DEFAULT_CALL.timeoutMs,
			maxResponseBytes:
				options.maxResponseBytes ?? DEFAULT_CALL.maxResponseBytes,
		});
	} catch (error) {
		if (error instanceof TransportGuardError) throw error;
		if (error instanceof ResolverError)
			throw new ResolverError(
				error.code,
				redactCredentialForms(error.message, credential),
			);
		throw new ResolverError(
			"RESOLVER_PROVIDER_REJECTED",
			"Vercel API transport failed",
		);
	}
	return response.status >= 200 && response.status < 300
		? response
		: {
				...response,
				body: redactCredentialForms(response.body, credential),
			};
}

/**
 * A non-2xx body with the credential taken out in the encodings a body can
 * echo it in — raw, base64 (whole and as a Basic header's `:token`),
 * base64url, and percent-encoded — before `redactProviderText` shapes it.
 * The fuller per-character scrub lives on the fixture client
 * (@hobo/hobo's vercel-client), which this package cannot import; these
 * whole-form replacements are the resolver plane's share of it.
 */
function redactCredentialForms(body: string, credential: SecretValue): string {
	const token = credential.expose();
	if (token === "") return body;
	const bytes = Buffer.from(token, "utf8");
	const percent = [...bytes]
		.map((byte) => `%${byte.toString(16).padStart(2, "0")}`)
		.join("");
	const base64url = (form: string) =>
		form.replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
	const standard = [
		token,
		bytes.toString("base64"),
		Buffer.from(`:${token}`, "utf8").toString("base64"),
		percent,
		percent.toUpperCase(),
	];
	const forms = [...new Set([...standard, ...standard.map(base64url)])]
		.filter((form) => form.length >= 4)
		.sort((a, b) => b.length - a.length);
	let out = body;
	for (const form of forms) out = out.replaceAll(form, "[redacted]");
	return out;
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
	readonly installCommand?: string;
	readonly outputDirectory?: string;
	readonly repository?: string;
	readonly hasGitLink: boolean;
};

/** Settings this resolver sends. `name` doubles as the idempotency key. */
const PROJECT_SETTINGS = Object.freeze([
	"buildCommand",
	"framework",
	"installCommand",
	"outputDirectory",
	"rootDirectory",
] as const);

function parseProjectView(body: string, operation: string): ProjectView {
	const record = readJsonObject(body, operation);
	const accountId = optionalString(record, "accountId");
	const framework = optionalString(record, "framework");
	const rootDirectory = optionalString(record, "rootDirectory");
	const buildCommand = optionalString(record, "buildCommand");
	const installCommand = optionalString(record, "installCommand");
	const outputDirectory = optionalString(record, "outputDirectory");
	const rawLink = record.link;
	if (
		rawLink !== undefined &&
		rawLink !== null &&
		!isJsonObject(rawLink) &&
		!isJsonArray(rawLink)
	)
		throw unparseable(operation, "project Git linkage is invalid");
	const links = isJsonArray(rawLink)
		? rawLink
		: isJsonObject(rawLink)
			? [rawLink]
			: [];
	const link = links.length === 1 ? links[0] : undefined;
	let repository: string | undefined;
	if (
		isJsonObject(link) &&
		(link.type === "github" || link.type === "github-limited") &&
		isJsonString(link.org) &&
		isJsonString(link.repo) &&
		link.sourceless !== true
	)
		repository = `${link.org}/${link.repo}`;
	return {
		id: requiredString(record, "id", operation),
		name: requiredString(record, "name", operation),
		...(accountId !== undefined ? { accountId } : undefined),
		...(framework !== undefined ? { framework } : undefined),
		...(rootDirectory !== undefined ? { rootDirectory } : undefined),
		...(buildCommand !== undefined ? { buildCommand } : undefined),
		...(installCommand !== undefined ? { installCommand } : undefined),
		...(outputDirectory !== undefined ? { outputDirectory } : undefined),
		...(repository !== undefined ? { repository } : undefined),
		hasGitLink: links.length > 0,
	};
}

type ProjectOutputs = {
	readonly id: string;
	readonly name: string;
	readonly accountId?: string;
	readonly framework?: string;
	readonly rootDirectory?: string;
	readonly buildCommand?: string;
	readonly installCommand?: string;
	readonly outputDirectory?: string;
	readonly repository?: string;
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
		...(view.installCommand !== undefined
			? { installCommand: view.installCommand }
			: undefined),
		...(view.outputDirectory !== undefined
			? { outputDirectory: view.outputDirectory }
			: undefined),
		...(view.repository !== undefined
			? { repository: view.repository }
			: undefined),
	};
}

type ProjectSettings = {
	readonly name?: string;
	readonly buildCommand?: string;
	readonly installCommand?: string;
	readonly framework?: string;
	readonly outputDirectory?: string;
	readonly rootDirectory?: string;
};

type ProjectDesired = {
	readonly name: string;
	readonly settings: ProjectSettings;
	readonly repository?: string;
};

function parseProjectDesired(request: ResolveRequest): ProjectDesired {
	const desired = desiredOf(request);
	for (const key of Object.keys(desired))
		if (
			!["name", "operationId", "repository", ...PROJECT_SETTINGS].includes(key)
		)
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
	const repository = desiredString(
		desired,
		"repository",
		VERCEL_PROJECT_PRODUCT_ID,
	);
	if (
		repository !== undefined &&
		!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u.test(
			repository,
		)
	)
		throw new ResolverError(
			"RESOLVER_PRODUCT_UNSUPPORTED",
			"Vercel project requires an exact GitHub owner/repository",
		);
	return {
		name,
		settings,
		...(repository !== undefined ? { repository } : undefined),
	};
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

function checkProjectRepository(
	desired: ProjectDesired,
	view: ProjectView,
	allowUnlinked: boolean,
): void {
	if (desired.repository === undefined) return;
	if (view.hasGitLink && view.repository !== desired.repository)
		throw new ResolverError(
			"RESOLVER_PROVIDER_REJECTED",
			"Vercel project is linked to a different Git repository",
		);
	if (!allowUnlinked && view.repository !== desired.repository)
		throw new ResolverError(
			"RESOLVER_PROVIDER_REJECTED",
			"Vercel project Git repository is not confirmed",
		);
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
				const operation = desired.repository
					? "POST /v11/projects"
					: "POST /v9/projects";
				const response = await callApi(
					dispatch,
					credential,
					{
						method: "POST",
						path: `${desired.repository ? "/v11/projects" : "/v9/projects"}${teamQuery(options.teamId)}`,
						body: {
							name: desired.name,
							...desired.settings,
							...(desired.repository
								? {
										gitRepository: { type: "github", repo: desired.repository },
									}
								: undefined),
						},
					},
					options.call ?? {},
				);
				if (response.status !== 200 && response.status !== 201) {
					throw providerRejected(operation, response.status, response.body);
				}
				let view = parseProjectView(response.body, operation);
				assertProjectIdentity(view, options, desired.name, false);
				if (desired.repository) {
					const confirmed = await getProjectView(
						dispatch,
						credential,
						options,
						view.id,
						true,
					);
					if (!confirmed)
						throw unparseable(
							operation,
							"created project is not independently observable",
						);
					checkProjectRepository(desired, confirmed, false);
					if (Object.keys(projectDelta(desired, confirmed)).length)
						throw unparseable(
							operation,
							"created project settings are not independently confirmed",
						);
					view = confirmed;
				}
				return outcomeOf("create", view.id, projectOutputs(view), [
					`created vercel project ${view.name}`,
				]);
			}

			checkProjectRepository(desired, observed, true);
			const verifyUnlinked = async () => {
				if (!desired.repository || observed.hasGitLink) return;
				const operationId = desiredString(
					parsed.desired,
					"operationId",
					VERCEL_PROJECT_PRODUCT_ID,
				);
				if (
					!options.teamId ||
					!operationId ||
					!options.verifyUnlinkedProject ||
					!(await options.verifyUnlinkedProject({
						teamId: options.teamId,
						projectId: observed.id,
						repository: desired.repository,
						operationId,
					}))
				)
					throw new ResolverError(
						"RESOLVER_PRODUCT_UNSUPPORTED",
						"Vercel unlinked project requires independently verified adoption and Git-link authorization",
					);
			};
			await verifyUnlinked();
			const delta = projectDelta(desired, observed);
			if (
				Object.keys(delta).length === 0 &&
				(!desired.repository || observed.repository === desired.repository)
			) {
				return known === undefined
					? outcomeOf("adopt", observed.id, projectOutputs(observed), [
							`adopted the existing vercel project ${observed.name}; it matches the desired settings and this run did not create it`,
						])
					: outcomeOf("noop", observed.id, projectOutputs(observed), [
							`vercel project ${observed.name} already matches the desired settings`,
						]);
			}

			let view = observed;
			if (Object.keys(delta).length) {
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
				view = parseProjectView(response.body, operation);
				assertProjectIdentity(view, options, observed.id, true);
				checkProjectRepository(desired, view, true);
				if (desired.repository) {
					const confirmed = await getProjectView(
						dispatch,
						credential,
						options,
						view.id,
						true,
					);
					if (!confirmed)
						throw unparseable(
							operation,
							"updated project is not independently observable",
						);
					checkProjectRepository(desired, confirmed, true);
					if (Object.keys(projectDelta(desired, confirmed)).length)
						throw unparseable(
							operation,
							"project settings are not independently confirmed",
						);
					view = confirmed;
				}
			}
			if (desired.repository && !view.hasGitLink) {
				await verifyUnlinked();
				const operation = "POST /v9/projects/{idOrName}/link";
				const response = await callApi(
					dispatch,
					credential,
					{
						method: "POST",
						path: `/v9/projects/${encodeURIComponent(view.id)}/link${teamQuery(options.teamId)}`,
						body: { type: "github", repo: desired.repository },
					},
					options.call ?? {},
				);
				if (response.status !== 200 && response.status !== 201)
					throw providerRejected(operation, response.status, response.body);
				const confirmed = await getProjectView(
					dispatch,
					credential,
					options,
					view.id,
					true,
				);
				if (!confirmed)
					throw unparseable(
						operation,
						"linked project is not independently observable",
					);
				checkProjectRepository(desired, confirmed, false);
				if (Object.keys(projectDelta(desired, confirmed)).length)
					throw unparseable(
						operation,
						"project settings changed during Git linkage",
					);
				view = confirmed;
			}
			return outcomeOf("update", view.id, projectOutputs(view), [
				`updated approved settings or Git linkage on vercel project ${view.name}`,
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
			const observed = await getProjectView(
				dispatch,
				credential,
				options,
				target,
				knownPhysicalId(parsed) !== undefined,
			);
			if (!observed) return;
			checkProjectRepository(parseProjectDesired(parsed), observed, false);
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

// Vercel's own CLI uses GET /v1/storage/stores to discover stores and the
// storage-connections API to project OIDC access into a project. Both the
// lookup and the subsequent mutation must be serialized across processes.
type BlobDesired = {
	readonly name: string;
	readonly region: string;
	readonly access: "private" | "public";
	readonly projectId: string;
	readonly environments: readonly string[];
	readonly operationId: string;
	readonly deleteWhenEmpty: boolean;
};
type BlobRequested = Omit<BlobDesired, "projectId"> & {
	readonly projectId?: string;
	readonly projectName?: string;
	readonly teamId?: string;
};
type BlobConnection = {
	readonly id: string;
	readonly projectId: string;
	readonly environments: readonly string[];
	readonly environmentVariables?: readonly string[];
};
type BlobView = {
	readonly id: string;
	readonly name: string;
	readonly region: string;
	readonly access: "private" | "public";
	readonly count?: number;
	readonly connectionsObserved: boolean;
	readonly connections: readonly BlobConnection[];
};

function blobDesired(request: ResolveRequest): BlobRequested {
	const desired = desiredOf(request);
	for (const key of Object.keys(desired))
		if (
			![
				"name",
				"store",
				"region",
				"access",
				"projectId",
				"projectName",
				"teamId",
				"environments",
				"operationId",
				"deleteWhenEmpty",
			].includes(key)
		)
			throw new ResolverError(
				"RESOLVER_PRODUCT_UNSUPPORTED",
				"vercel Blob desired contains an unsupported setting",
			);
	const name =
		desiredString(desired, "store", VERCEL_BLOB_PRODUCT_ID) ??
		desiredString(desired, "name", VERCEL_BLOB_PRODUCT_ID) ??
		request.ref.logicalId;
	const region = desiredString(desired, "region", VERCEL_BLOB_PRODUCT_ID);
	const access = desiredString(desired, "access", VERCEL_BLOB_PRODUCT_ID);
	const projectId = desiredString(desired, "projectId", VERCEL_BLOB_PRODUCT_ID);
	const projectName = desiredString(
		desired,
		"projectName",
		VERCEL_BLOB_PRODUCT_ID,
	);
	const teamId = desiredString(desired, "teamId", VERCEL_BLOB_PRODUCT_ID);
	const operationId = desiredString(
		desired,
		"operationId",
		VERCEL_BLOB_PRODUCT_ID,
	);
	const environments = desired.environments;
	if (
		!/^[a-z0-9][a-z0-9-]{4,62}$/u.test(name) ||
		!region ||
		!/^[a-z0-9]{3,8}$/u.test(region) ||
		(access !== "private" && access !== "public") ||
		(!projectId && !projectName) ||
		(projectId !== undefined &&
			!/^prj_[A-Za-z0-9_-]{1,128}$/u.test(projectId)) ||
		(projectName !== undefined &&
			!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/u.test(projectName)) ||
		(teamId !== undefined && !/^team_[A-Za-z0-9_-]{1,128}$/u.test(teamId)) ||
		!operationId ||
		operationId.length > 200 ||
		!isJsonArray(environments) ||
		environments.length === 0 ||
		environments.some(
			(env) =>
				!isJsonString(env) ||
				!["production", "preview", "development"].includes(env),
		) ||
		new Set(environments).size !== environments.length ||
		(desired.deleteWhenEmpty !== undefined &&
			!isJsonBoolean(desired.deleteWhenEmpty))
	)
		throw new ResolverError(
			"RESOLVER_PRODUCT_UNSUPPORTED",
			"vercel Blob requires a valid store name, region, access, project ID, environments and operation ID",
		);
	return {
		name,
		region,
		access,
		...(projectId ? { projectId } : undefined),
		...(projectName ? { projectName } : undefined),
		...(teamId ? { teamId } : undefined),
		environments: environments.filter(isJsonString).sort(),
		operationId,
		deleteWhenEmpty: desired.deleteWhenEmpty === true,
	};
}

function assertBlobTeam(
	options: VercelResolverOptions,
	desired: BlobRequested,
) {
	if (!options.teamId || (desired.teamId && desired.teamId !== options.teamId))
		throw new ResolverError(
			"RESOLVER_PRODUCT_UNSUPPORTED",
			"vercel Blob requires the approved team scope",
		);
}

/** Resolve the declared project with the same scoped credential used for the
 * store. A previously observed resource must retain its exact project ID. */
async function resolveBlobProject(
	dispatch: Dispatch,
	credential: SecretValue,
	options: VercelResolverOptions,
	request: ResolveRequest,
	desired: BlobRequested,
): Promise<BlobDesired> {
	const prior = request.observed?.projectId;
	if (
		prior !== undefined &&
		(!isJsonString(prior) || !/^prj_[A-Za-z0-9_-]{1,128}$/u.test(prior))
	)
		throw new ResolverError(
			"RESOLVER_PRODUCT_UNSUPPORTED",
			"invalid pinned project observation",
		);
	if (desired.projectId && isJsonString(prior) && desired.projectId !== prior)
		throw new ResolverError(
			"RESOLVER_PROVIDER_REJECTED",
			"Blob project differs from the pinned project observation",
		);
	if (knownPhysicalId(request) && !desired.projectId && !isJsonString(prior))
		throw new ResolverError(
			"RESOLVER_PRODUCT_UNSUPPORTED",
			"Blob retirement or recovery requires a pinned project observation",
		);
	const projectId =
		desired.projectId ?? (isJsonString(prior) ? prior : undefined);
	const selected = projectId ?? desired.projectName;
	if (!selected) throw new Error("Blob project selector missing");
	const project = await getProjectView(
		dispatch,
		credential,
		options,
		selected,
		projectId !== undefined,
	);
	if (!project || !/^prj_[A-Za-z0-9_-]{1,128}$/u.test(project.id))
		throw new ResolverError(
			"RESOLVER_PROVIDER_REJECTED",
			"selected Vercel project does not exist in this team",
		);
	if (desired.projectName && project.name !== desired.projectName)
		throw new ResolverError(
			"RESOLVER_PROVIDER_REJECTED",
			"returned project identity differs from the approved project name",
		);
	return { ...desired, projectId: project.id };
}

function blobView(
	record: JsonObject,
	options: VercelResolverOptions,
): BlobView {
	const op = "Blob store observation";
	const id = requiredString(record, "id", op);
	const name = requiredString(record, "name", op);
	const region = requiredString(record, "region", op);
	const access = requiredString(record, "access", op);
	const owners = [record.ownerId, record.accountId, record.teamId].filter(
		(owner) => owner !== undefined,
	);
	if (
		!/^store_[A-Za-z0-9]+$/u.test(id) ||
		record.type !== "blob" ||
		(access !== "private" && access !== "public") ||
		!options.teamId ||
		owners.length === 0 ||
		owners.some((owner) => owner !== options.teamId)
	)
		throw unparseable(
			op,
			"store type, identity or owner does not match the selected Vercel account",
		);
	if (
		record.status !== undefined &&
		record.status !== null &&
		!isJsonString(record.status)
	)
		throw unparseable(op, "store status is invalid");
	if (
		record.status === "deleted" ||
		record.status === "disabled" ||
		record.status === "suspended" ||
		(record.billingState !== undefined && record.billingState !== "active")
	)
		throw new ResolverError(
			"RESOLVER_PROVIDER_REJECTED",
			"vercel Blob store is not available",
		);
	if (
		record.projectsMetadata !== undefined &&
		!isJsonArray(record.projectsMetadata)
	)
		throw unparseable(op, "project connection inventory is invalid");
	const connections = (record.projectsMetadata ?? []).map(
		(entry): BlobConnection => {
			if (
				!isJsonObject(entry) ||
				!isJsonArray(entry.environments) ||
				(entry.environmentVariables !== undefined &&
					!isJsonArray(entry.environmentVariables)) ||
				entry.environments.some(
					(item) =>
						!isJsonString(item) ||
						!["production", "preview", "development"].includes(item),
				) ||
				(isJsonArray(entry.environmentVariables) &&
					entry.environmentVariables.some((item) => !isJsonString(item)))
			)
				throw unparseable(op, "project connection metadata is incomplete");
			return {
				id: requiredString(entry, "id", op),
				projectId: requiredString(entry, "projectId", op),
				environments: entry.environments.filter(isJsonString),
				...(isJsonArray(entry.environmentVariables)
					? {
							environmentVariables:
								entry.environmentVariables.filter(isJsonString),
						}
					: undefined),
			};
		},
	);
	const count = record.count;
	if (
		count !== undefined &&
		(!isJsonNumber(count) || !Number.isSafeInteger(count) || count < 0)
	)
		throw unparseable(op, "object count is invalid");
	return {
		id,
		name,
		region,
		access,
		...(isJsonNumber(count) ? { count } : undefined),
		connectionsObserved: isJsonArray(record.projectsMetadata),
		connections,
	};
}

async function getBlob(
	dispatch: Dispatch,
	credential: SecretValue,
	options: VercelResolverOptions,
	id: string,
): Promise<BlobView | undefined> {
	const op = "GET /v1/storage/stores/{id}";
	const response = await callApi(
		dispatch,
		credential,
		{
			method: "GET",
			path: `/v1/storage/stores/${encodeURIComponent(id)}${teamQuery(options.teamId)}`,
		},
		options.call ?? {},
	);
	if (response.status === 404) return undefined;
	if (response.status !== 200)
		throw providerRejected(op, response.status, response.body);
	const body = readJsonObject(response.body, op);
	if (!isJsonObject(body.store)) throw unparseable(op, "store is missing");
	const view = blobView(body.store, options);
	if (view.id !== id)
		throw unparseable(op, "returned store has a different identity");
	return view;
}

async function listBlobStores(
	dispatch: Dispatch,
	credential: SecretValue,
	options: VercelResolverOptions,
): Promise<readonly JsonObject[]> {
	const op = "GET /v1/storage/stores";
	const response = await callApi(
		dispatch,
		credential,
		{ method: "GET", path: `/v1/storage/stores${teamQuery(options.teamId)}` },
		options.call ?? {},
	);
	if (response.status !== 200)
		throw providerRejected(op, response.status, response.body);
	const body = readJsonObject(response.body, op);
	if (
		!isJsonArray(body.stores) ||
		body.hasMore === true ||
		body.next !== undefined ||
		body.cursor !== undefined ||
		body.pagination !== undefined
	)
		throw unparseable(op, "store inventory is missing or incomplete");
	return body.stores.map((entry) => {
		if (!isJsonObject(entry))
			throw unparseable(op, "store inventory contains an invalid entry");
		requiredString(entry, "id", op);
		requiredString(entry, "name", op);
		return entry;
	});
}

async function lookupBlob(
	dispatch: Dispatch,
	credential: SecretValue,
	options: VercelResolverOptions,
	desired: BlobDesired,
	id?: string,
): Promise<BlobView | undefined> {
	if (id) return getBlob(dispatch, credential, options, id);
	const op = "GET /v1/storage/stores";
	const matches = (await listBlobStores(dispatch, credential, options)).filter(
		(entry) => entry.name === desired.name,
	);
	if (matches.length > 1)
		throw new ResolverError(
			"RESOLVER_PROVIDER_REJECTED",
			"multiple Vercel stores have the requested name",
		);
	const match = matches[0];
	if (!match) return undefined;
	const view = await getBlob(
		dispatch,
		credential,
		options,
		requiredString(match, "id", op),
	);
	if (!view || view.name !== desired.name)
		throw unparseable(op, "store disappeared or changed during discovery");
	if (
		!view.connections.some(
			(connection) => connection.projectId === desired.projectId,
		)
	)
		throw new ResolverError(
			"RESOLVER_PROVIDER_REJECTED",
			"matching Blob store is not connected to the selected project; import its exact ID to confirm ownership",
		);
	return view;
}

function blobOutputs(view: BlobView, desired: BlobDesired): JsonObject {
	const connections = view.connections.filter(
		(entry) => entry.projectId === desired.projectId,
	);
	const environments = [
		...new Set(connections.flatMap((entry) => entry.environments)),
	].sort();
	const oidc =
		connections.length === 1 &&
		connections.every(
			(entry) =>
				entry.environmentVariables?.includes("BLOB_STORE_ID") &&
				!entry.environmentVariables.includes("BLOB_READ_WRITE_TOKEN"),
		);
	const ready =
		view.connectionsObserved &&
		view.name === desired.name &&
		view.region === desired.region &&
		view.access === desired.access &&
		oidc &&
		desired.environments.every((environment) =>
			environments.includes(environment),
		);
	return {
		id: view.id,
		name: view.name,
		region: view.region,
		access: view.access,
		projectId: desired.projectId,
		environments,
		oidc,
		ready,
		operationConfirmed: ready,
	};
}

function requireBlobScope(
	options: VercelResolverOptions,
	desired: BlobRequested,
) {
	if (
		!options.teamId ||
		!/^[A-Za-z0-9_-]{1,128}$/u.test(options.teamId) ||
		options.mutationJournal?.persistence !== "durable-cas" ||
		options.mutationScope?.persistence !== "durable-cas"
	)
		throw new ResolverError(
			"RESOLVER_PRODUCT_UNSUPPORTED",
			"vercel Blob mutations require a team-scoped durable mutation journal and shared mutation scope",
		);
	return {
		providerId: "vercel",
		providerAccountId: options.teamId,
		parentId: `blob:${desired.name}`,
	};
}

function assertBlobSettings(view: BlobView, desired: BlobDesired) {
	if (
		view.name !== desired.name ||
		view.region !== desired.region ||
		view.access !== desired.access
	)
		throw new ResolverError(
			"RESOLVER_PROVIDER_REJECTED",
			"existing Blob store differs from the desired name, region or access; no replacement was attempted",
		);
}

function assertBlobConnectionsObserved(view: BlobView) {
	if (!view.connectionsObserved)
		throw unparseable(
			"Blob store observation",
			"project connection inventory is missing",
		);
}

async function runBlobMutation<T>(
	options: VercelResolverOptions,
	scope: ReturnType<typeof requireBlobScope>,
	dispatch: Dispatch,
	action: (tracked: Dispatch) => Promise<T>,
): Promise<T> {
	const mutationScope = options.mutationScope;
	if (!mutationScope) throw new Error("Blob mutation scope unavailable");
	return mutationScope.run(scope, async () => {
		let attempted = false;
		const tracked: Dispatch = async (outbound) => {
			if (outbound.method !== "GET") attempted = true;
			return dispatch(outbound);
		};
		try {
			return await action(tracked);
		} catch (error) {
			if (!attempted) throw new ResourceMutationNotSentError(error);
			throw error;
		}
	});
}

function createBlobResolver(options: VercelResolverOptions): ResourceResolver {
	return {
		providerId: PROVIDER_TARGET,
		productId: VERCEL_BLOB_PRODUCT_ID,
		directives: ["operationId", "deleteWhenEmpty"],
		async read(request, transport) {
			const parsed = parseResolveRequest(
				parseJsonObject(JSON.stringify(request)),
			);
			assertProduct(parsed, VERCEL_BLOB_PRODUCT_ID);
			const requested = blobDesired(parsed);
			assertBlobTeam(options, requested);
			const credential = await resolveCredential(options, parsed.credentialRef);
			const dispatch = guardedDispatch(transport, options, parsed);
			const desired = await resolveBlobProject(
				dispatch,
				credential,
				options,
				parsed,
				requested,
			);
			const view = await lookupBlob(
				dispatch,
				credential,
				options,
				desired,
				knownPhysicalId(parsed),
			);
			return view
				? outcomeOf("noop", view.id, blobOutputs(view, desired), [])
				: undefined;
		},
		async observeAbsence(request, transport) {
			const parsed = parseResolveRequest(
				parseJsonObject(JSON.stringify(request)),
			);
			assertProduct(parsed, VERCEL_BLOB_PRODUCT_ID);
			const requested = blobDesired(parsed);
			assertBlobTeam(options, requested);
			if (!options.teamId || !parsed.ref.physicalId)
				throw new ResolverError(
					"RESOLVER_PRODUCT_UNSUPPORTED",
					"Blob absence requires an explicit team and physical store ID",
				);
			const credential = await resolveCredential(options, parsed.credentialRef);
			const dispatch = guardedDispatch(transport, options, parsed);
			await resolveBlobProject(
				dispatch,
				credential,
				options,
				parsed,
				requested,
			);
			const stores = await listBlobStores(dispatch, credential, options);
			if (stores.some((store) => store.id === parsed.ref.physicalId))
				return false;
			return (
				(await getBlob(
					dispatch,
					credential,
					options,
					parsed.ref.physicalId,
				)) === undefined
			);
		},
		async reconcile(request, transport) {
			const parsed = parseResolveRequest(
				parseJsonObject(JSON.stringify(request)),
			);
			assertProduct(parsed, VERCEL_BLOB_PRODUCT_ID);
			const requested = blobDesired(parsed);
			assertBlobTeam(options, requested);
			const scope = requireBlobScope(options, requested);
			const credential = await resolveCredential(options, parsed.credentialRef);
			return runBlobMutation(
				options,
				scope,
				guardedDispatch(transport, options, parsed),
				async (dispatch) => {
					const desired = await resolveBlobProject(
						dispatch,
						credential,
						options,
						parsed,
						requested,
					);
					const known = knownPhysicalId(parsed);
					let view = await lookupBlob(
						dispatch,
						credential,
						options,
						desired,
						known,
					);
					let created = false;
					let changed = false;
					if (known && !view)
						throw new ResolverError(
							"RESOLVER_PROVIDER_REJECTED",
							"the recorded Blob store no longer exists",
						);
					if (!view) {
						const op = "POST /v1/storage/stores/blob";
						const response = await callApi(
							dispatch,
							credential,
							{
								method: "POST",
								path: `/v1/storage/stores/blob${teamQuery(options.teamId)}`,
								body: {
									name: desired.name,
									region: desired.region,
									access: desired.access,
								},
							},
							options.call ?? {},
						);
						if (response.status < 200 || response.status >= 300)
							throw providerRejected(op, response.status, response.body);
						const body = readJsonObject(response.body, op);
						if (!isJsonObject(body.store))
							throw unparseable(op, "created store is missing");
						const id = requiredString(body.store, "id", op);
						view = await getBlob(dispatch, credential, options, id);
						if (!view)
							throw unparseable(op, "created store cannot be observed");
						created = true;
					}
					assertBlobSettings(view, desired);
					assertBlobConnectionsObserved(view);
					const existing = view.connections.filter(
						(entry) => entry.projectId === desired.projectId,
					);
					if (existing.length > 1)
						throw new ResolverError(
							"RESOLVER_PROVIDER_REJECTED",
							"multiple Blob connections to the project require explicit resolution",
						);
					const connection = existing[0];
					if (
						connection &&
						(!connection.environmentVariables?.includes("BLOB_STORE_ID") ||
							connection.environmentVariables.includes("BLOB_READ_WRITE_TOKEN"))
					)
						throw new ResolverError(
							"RESOLVER_PROVIDER_REJECTED",
							"existing Blob connection is not OIDC-only; migrate it before reconciliation",
						);
					const missing = desired.environments.filter(
						(env) => !connection?.environments.includes(env),
					);
					if (!connection) {
						const op = "POST /v1/storage/stores/{id}/connections";
						const response = await callApi(
							dispatch,
							credential,
							{
								method: "POST",
								path: `/v1/storage/stores/${encodeURIComponent(view.id)}/connections${teamQuery(options.teamId)}`,
								oidc: true,
								body: {
									projectId: desired.projectId,
									envVarEnvironments: [...desired.environments],
									skipReadWriteToken: true,
								},
							},
							options.call ?? {},
						);
						if (response.status < 200 || response.status >= 300)
							throw providerRejected(op, response.status, response.body);
						changed = true;
					} else if (missing.length) {
						const op = "PATCH /v1/storage/stores/{id}/connections/{id}";
						const response = await callApi(
							dispatch,
							credential,
							{
								method: "PATCH",
								path: `/v1/storage/stores/${encodeURIComponent(view.id)}/connections/${encodeURIComponent(connection.id)}${teamQuery(options.teamId)}`,
								body: {
									envVarEnvironments: [
										...new Set([
											...connection.environments,
											...desired.environments,
										]),
									].sort(),
									skipReadWriteToken: true,
								},
							},
							options.call ?? {},
						);
						if (response.status < 200 || response.status >= 300)
							throw providerRejected(op, response.status, response.body);
						changed = true;
					}
					if (changed) {
						view = await getBlob(dispatch, credential, options, view.id);
						if (!view)
							throw unparseable(
								"Blob connection",
								"store disappeared after connecting",
							);
						assertBlobConnectionsObserved(view);
						const projected = blobOutputs(view, desired);
						const projectedEnvironments = projected.environments;
						if (
							projected.oidc !== true ||
							!isJsonArray(projectedEnvironments) ||
							desired.environments.some(
								(env) => !projectedEnvironments.includes(env),
							)
						)
							throw unparseable(
								"Blob connection",
								"OIDC and environment projection were not observed",
							);
					}
					return outcomeOf(
						created ? "create" : changed ? "update" : known ? "noop" : "adopt",
						view.id,
						blobOutputs(view, desired),
						[],
					);
				},
			);
		},
		async delete(request, transport) {
			const parsed = parseResolveRequest(
				parseJsonObject(JSON.stringify(request)),
			);
			assertProduct(parsed, VERCEL_BLOB_PRODUCT_ID);
			const requested = blobDesired(parsed);
			assertBlobTeam(options, requested);
			const scope = requireBlobScope(options, requested);
			const id = knownPhysicalId(parsed);
			if (!id)
				throw new ResolverError(
					"RESOLVER_PRODUCT_UNSUPPORTED",
					"Blob deletion requires the recorded physical store ID",
				);
			const credential = await resolveCredential(options, parsed.credentialRef);
			await runBlobMutation(
				options,
				scope,
				guardedDispatch(transport, options, parsed),
				async (dispatch) => {
					const desired = await resolveBlobProject(
						dispatch,
						credential,
						options,
						parsed,
						requested,
					);
					let view = await getBlob(dispatch, credential, options, id);
					if (!view) return;
					assertBlobSettings(view, desired);
					assertBlobConnectionsObserved(view);
					const matches = view.connections.filter(
						(entry) =>
							entry.projectId === desired.projectId &&
							entry.environments.some((env) =>
								desired.environments.includes(env),
							),
					);
					if (matches.length > 1)
						throw new ResolverError(
							"RESOLVER_PROVIDER_REJECTED",
							"ambiguous Blob project connections cannot be retired safely",
						);
					const connection = matches[0];
					const remaining =
						connection?.environments.filter(
							(env) => !desired.environments.includes(env),
						) ?? [];
					const willBeUnconnected =
						view.connections.length ===
						(connection && remaining.length === 0 ? 1 : 0);
					if (desired.deleteWhenEmpty && willBeUnconnected && view.count !== 0)
						throw new ResolverError(
							"RESOLVER_PROVIDER_REJECTED",
							"Blob store must be verified empty before deletion",
						);
					if (connection) {
						const op = "retire Blob project connection";
						const response = await callApi(
							dispatch,
							credential,
							{
								method: remaining.length ? "PATCH" : "DELETE",
								path: `/v1/storage/stores/${encodeURIComponent(id)}/connections/${encodeURIComponent(connection.id)}${teamQuery(options.teamId)}`,
								...(remaining.length
									? { body: { envVarEnvironments: remaining } }
									: undefined),
							},
							options.call ?? {},
						);
						if (
							response.status !== 404 &&
							(response.status < 200 || response.status >= 300)
						)
							throw providerRejected(op, response.status, response.body);
						view = await getBlob(dispatch, credential, options, id);
						if (!view) return;
						assertBlobConnectionsObserved(view);
						if (
							view.connections.some(
								(entry) =>
									entry.projectId === desired.projectId &&
									entry.environments.some((env) =>
										desired.environments.includes(env),
									),
							)
						)
							throw unparseable(
								op,
								"requested environments still have a connection",
							);
					}
					if (desired.deleteWhenEmpty && view.connections.length === 0) {
						if (view.count !== 0)
							throw new ResolverError(
								"RESOLVER_PROVIDER_REJECTED",
								"Blob store must be verified empty before deletion",
							);
						const op = "DELETE /v1/storage/stores/blob/{id}";
						const response = await callApi(
							dispatch,
							credential,
							{
								method: "DELETE",
								path: `/v1/storage/stores/blob/${encodeURIComponent(id)}${teamQuery(options.teamId)}`,
							},
							options.call ?? {},
						);
						if (
							response.status !== 404 &&
							(response.status < 200 || response.status >= 300)
						)
							throw providerRejected(op, response.status, response.body);
						if (await getBlob(dispatch, credential, options, id))
							throw unparseable(op, "store is still present after deletion");
					}
				},
			);
		},
	};
}

/**
 * Product ids this package catalogs but deliberately cannot resolve.
 *
 * `vercel.edge-function/v1`: functions are produced by a deployment, and Vercel
 * documents no endpoint that creates one as a standalone resource.
 */
export const VERCEL_UNRESOLVED_PRODUCT_IDS = Object.freeze([
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
	VERCEL_BLOB_PRODUCT_ID,
	"vercel.edge-config/v1",
	"vercel.project/v1",
	VERCEL_STATIC_DEPLOY_PRODUCT_ID,
] as const);

/**
 * Every Vercel product this package can resolve over the REST API, ordered by
 * product id so two builds of the registry are identical.
 *
 * `vercel.edge-function/v1` is deliberately absent —
 * see {@link VERCEL_UNRESOLVED_PRODUCT_IDS} and the README.
 */
export function vercelResolvers(
	options: VercelResolverOptions,
): readonly ResourceResolver[] {
	return Object.freeze([
		createBlobResolver(options),
		createEdgeConfigResolver(options),
		createProjectResolver(options),
		createVercelStaticDeploymentResolver(options),
	]);
}

/**
 * The same resolvers behind core's registry lookup. With `metrics` and an
 * injected `nowMs`, every call emits `hobo.cd.resolver.operations` and
 * `hobo.cd.resolver.duration`.
 */
export function vercelResolverRegistry(
	options: VercelResolverOptions & ResolverTelemetryOptions,
): {
	get(productId: string): ResourceResolver | undefined;
	list(): readonly ResourceResolver[];
} {
	return createResolverRegistry(
		instrumentResolvers(vercelResolvers(options), options),
	);
}
