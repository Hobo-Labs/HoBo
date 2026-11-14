/**
 * Convex Cloud deployment resolver (plan 0024 WP13, I14; D6).
 *
 * The hosting product is a Convex Cloud *deployment* inside a project the host
 * binds. The resolver observes it through two documented Management API reads
 * (`GET /v1/token_details`, `GET /v1/projects/{id}/list_deployments`) and
 * adopts it by name. It never creates or deletes one:
 *
 * - creation is not convergent: the Management API mints a new project and
 *   deployment per call with no idempotency key, so a retried create after a
 *   lost reply would leave a second billable deployment;
 * - the only documented deletion is of a whole project, which would remove
 *   every deployment in it.
 *
 * Function code is pushed with a deploy key by `npx convex deploy`; there is no
 * documented HTTP push, so the code version is not observable here
 * (`codeVersionObserved: false`, no `artifactDigest`). A hosting transition
 * that expects an approved artifact therefore fails closed at the lifecycle
 * parse boundary instead of trusting a deployment that merely exists (I5).
 *
 * Credentials: the team access token arrives through the host's
 * `resolveCredential(credentialRef)` and only ever travels in the
 * `authorization` header of a guarded HTTPS request to `api.convex.dev`.
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
	isJsonObject,
	isJsonString,
	type JsonObject,
	type JsonValue,
} from "./json.js";

// public-contract: the Convex Cloud deployment hosting product id.
export const CONVEX_CLOUD_DEPLOYMENT_PRODUCT_ID = "convex.cloud-deployment/v1";
// public-contract: the documented Management API origin; callers cannot redirect credentials.
export const CONVEX_MANAGEMENT_API_ORIGIN = "https://api.convex.dev";

const PROVIDER_ID = "convex";
const SCOPE_ID = /^[0-9]{1,20}$/u;
const DEPLOYMENT_NAME = /^[a-z][a-z0-9-]{0,62}[a-z0-9]$/u;
const DEPLOYMENT_TYPES = new Set(["prod", "dev", "preview", "custom"]);
const DESIRED_KEYS = new Set([
	"teamId",
	"projectId",
	"deploymentName",
	"deploymentType",
]);
const MAX_RESPONSE_BYTES = 1024 * 1024;
const TIMEOUT_MS = 30_000;

/** Scope is supplied by the host, never inferred from a credential or a plan. */
export interface ConvexResolverOptions extends ResolverTelemetryOptions {
	readonly teamId: string;
	readonly projectId: string;
	/** Resolves a credential locator to a Convex team access token. */
	readonly resolveCredential: (ref: string) => Promise<string>;
}

function reject(message: string, remediation?: string): never {
	throw new ResolverError(
		"RESOLVER_PROVIDER_REJECTED",
		remediation ? `${message}. Remediation: ${remediation}` : message,
		CONVEX_CLOUD_DEPLOYMENT_PRODUCT_ID,
	);
}
function unparseable(message: string): never {
	throw new ResolverError(
		"RESOLVER_OUTPUT_UNPARSEABLE",
		message,
		CONVEX_CLOUD_DEPLOYMENT_PRODUCT_ID,
	);
}
function scopeId(value: JsonValue | undefined, field: string): string {
	// A numeric wire id and its decimal string are the same identifier.
	const text = isJsonString(value) ? value : JSON.stringify(value ?? null);
	if (!isJsonString(text) || !SCOPE_ID.test(text))
		throw new ResolverError(
			"RESOLVER_PROVIDER_REJECTED",
			`Convex ${field} must be a numeric identifier`,
			CONVEX_CLOUD_DEPLOYMENT_PRODUCT_ID,
		);
	return text;
}

interface Target {
	readonly request: ResolveRequest;
	readonly deploymentName: string;
	readonly deploymentType: string;
}

/** Build the resolvers for the bound team and project. */
export function createConvexResolvers(
	options: ConvexResolverOptions,
): readonly ResourceResolver[] {
	const teamId = scopeId(options.teamId, "teamId");
	const projectId = scopeId(options.projectId, "projectId");

	function target(raw: ResolveRequest): Target {
		const request = parseResolveRequest(JSON.parse(JSON.stringify(raw)));
		if (request.ref.productId !== CONVEX_CLOUD_DEPLOYMENT_PRODUCT_ID)
			throw new ResolverError(
				"RESOLVER_PRODUCT_UNSUPPORTED",
				`Convex cloud deployment resolver cannot operate on ${request.ref.productId}`,
				request.ref.productId,
			);
		for (const key of Object.keys(request.desired))
			if (!DESIRED_KEYS.has(key))
				reject(`Convex cloud deployment does not implement desired.${key}`);
		if (
			scopeId(request.desired.teamId, "desired.teamId") !== teamId ||
			scopeId(request.desired.projectId, "desired.projectId") !== projectId
		)
			reject(
				"Convex desired scope differs from the host's bound team/project",
				"bind the Camp to the Convex project the Set targets",
			);
		const deploymentName = request.desired.deploymentName;
		if (!isJsonString(deploymentName) || !DEPLOYMENT_NAME.test(deploymentName))
			reject(
				"Convex desired.deploymentName must be an explicit deployment name",
			);
		if (
			request.ref.physicalId !== undefined &&
			request.ref.physicalId !== deploymentName
		)
			reject(
				"Convex deployment name conflicts with its pinned physical identity",
			);
		const deploymentType = request.desired.deploymentType;
		if (!isJsonString(deploymentType) || !DEPLOYMENT_TYPES.has(deploymentType))
			reject(
				"Convex desired.deploymentType must be prod, dev, preview or custom",
			);
		return { request, deploymentName, deploymentType };
	}

	async function session(target: Target, supplied: HttpTransport) {
		const token = await options.resolveCredential(target.request.credentialRef);
		if (!/^[!-~]{1,8192}$/u.test(token))
			throw new ResolverError(
				"RESOLVER_CREDENTIAL_MISSING",
				"Convex team access token is missing or invalid",
				CONVEX_CLOUD_DEPLOYMENT_PRODUCT_ID,
			);
		const transport = guardTransport(supplied, {
			allowedHosts: ["api.convex.dev"],
			allowedPathPrefixes: ["/v1/"],
			maxTimeoutMs: TIMEOUT_MS,
			maxResponseBytes: MAX_RESPONSE_BYTES,
		});
		async function get(path: string): Promise<JsonValue> {
			let response: TransportResponse;
			try {
				response = await transport({
					method: "GET",
					url: `${CONVEX_MANAGEMENT_API_ORIGIN}${path}`,
					headers: {
						accept: "application/json",
						authorization: `Bearer ${token}`,
					},
					timeoutMs: TIMEOUT_MS,
					maxResponseBytes: MAX_RESPONSE_BYTES,
				});
			} catch (error) {
				if (error instanceof ResolverError) throw error;
				reject(
					"Convex Management API read failed in transport",
					"retry the reconcile; reads are side-effect free",
				);
			}
			if (response.status < 200 || response.status >= 300)
				reject(
					`Convex Management API returned HTTP ${response.status}`,
					response.status === 401 || response.status === 403
						? "re-issue the team access token in the Yard broker"
						: "retry the reconcile; reads are side-effect free",
				);
			try {
				// SAFETY: JSON.parse yields a JSON value at this provider boundary.
				return JSON.parse(response.body) as JsonValue;
			} catch {
				unparseable("Convex Management API returned a non-JSON body");
			}
		}
		const details = await get("/v1/token_details");
		if (!isJsonObject(details))
			unparseable("Convex token details are malformed");
		if (details.type !== "teamToken")
			reject(
				"Convex delivery needs a team access token; a project or deployment token cannot list the project's deployments",
				"issue a team access token for the bound team",
			);
		if (scopeId(details.teamId, "token teamId") !== teamId)
			reject("Convex credential is scoped to another team");
		return { get };
	}

	async function observe(
		target: Target,
		transport: HttpTransport,
	): Promise<ResolveOutcome | undefined> {
		const api = await session(target, transport);
		const listing = await api.get(`/v1/projects/${projectId}/list_deployments`);
		if (!isJsonArray(listing))
			unparseable("Convex deployment listing is not an array");
		let found: JsonObject | undefined;
		for (const entry of listing) {
			if (!isJsonObject(entry) || !isJsonString(entry.name))
				unparseable("Convex deployment listing has a malformed entry");
			if (entry.name !== target.deploymentName) continue;
			if (found) unparseable("Convex listing names one deployment twice");
			found = entry;
		}
		// Absence from a listing is not proof of terminal absence (I5).
		if (!found) return undefined;
		if (scopeId(found.projectId, "deployment projectId") !== projectId)
			reject("Convex returned a deployment from another project");
		if (found.deploymentType !== target.deploymentType)
			reject(
				`Convex deployment ${target.deploymentName} is ${JSON.stringify(found.deploymentType)}, not ${target.deploymentType}`,
				"point the Set at a deployment of the intended type",
			);
		const endpoint = `https://${target.deploymentName}.convex.cloud`;
		return {
			contract: RESOLVER_CONTRACT,
			action:
				target.request.ref.physicalId === target.deploymentName
					? "noop"
					: "adopt",
			physicalId: target.deploymentName,
			outputs: {
				teamId,
				projectId,
				deploymentName: target.deploymentName,
				deploymentType: target.deploymentType,
				deploymentUrl: endpoint,
				servingEndpoint: endpoint,
				ready: true,
				operationConfirmed: true,
				operationTerminal: true,
				absenceConfirmed: false,
				lifecycleStatus: "ready",
				codeVersionObserved: false,
			},
			diagnostics: [
				"function code version is pushed by npx convex deploy and is not observable through the Management API",
			],
		};
	}

	const resolver: ResourceResolver = {
		providerId: PROVIDER_ID,
		productId: CONVEX_CLOUD_DEPLOYMENT_PRODUCT_ID,
		async read(raw, transport) {
			return observe(target(raw), transport);
		},
		async reconcile(raw, transport) {
			const parsed = target(raw);
			const observed = await observe(parsed, transport);
			if (!observed)
				reject(
					`Convex deployment ${parsed.deploymentName} is not visible in project ${projectId}; creation is not convergent and is never attempted`,
					"create the deployment once with the Convex dashboard or CLI, then reconcile to adopt it by name",
				);
			return observed;
		},
		async delete(raw) {
			const parsed = target(raw);
			reject(
				`Convex deployment ${parsed.deploymentName} is not deleted by HoBo; the Management API deletes whole projects, not single deployments`,
				"retire the deployment in the Convex dashboard and reconcile to observe it gone",
			);
		},
	};
	return Object.freeze([resolver]);
}

/** Registry of every Convex hosting product with a shipped resolver (I14). */
export function convexResolverRegistry(options: ConvexResolverOptions) {
	return createResolverRegistry(
		instrumentResolvers(createConvexResolvers(options), options),
	);
}
