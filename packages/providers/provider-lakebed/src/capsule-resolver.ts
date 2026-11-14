/**
 * Lakebed capsule resolver (plan 0024 WP14, I14; D6, ADR-0127).
 *
 * Lakebed's hosting product is a Capsule deployment. Its realization path is
 * the `lakebed-deploy` driver: one `hobo.driver-program/v1` per deployment id,
 * built by the same `realizeResourcePlans` the CloudProvider uses, so kv, file
 * store and reactive-db resources ride inside the capsule program rather than
 * being separately delivered.
 *
 * The injected `LakebedDeployHost` is the only seam (the driver process the
 * reconciler runs next to; a test double). It receives the deployment-scoped
 * deploy token the host resolves from `credentialRef` at call time. The token
 * never reaches a desired bag, an outcome or an error message (I9).
 *
 * Everything the host reports crosses `parseCapsuleRecord`: a capsule URL must
 * be `https://*.lakebed.app` with no userinfo, port, query or fragment. Readiness
 * is an observation: a GET of that exact URL through the caller's transport
 * (I5). A deployment id runs one artifact; replacing it in place is not a
 * staged transition, so a digest change on a live capsule is refused and the
 * remediation names a new deployment id.
 */
import {
	type CapabilityPortKind,
	createResolverRegistry,
	type HttpTransport,
	parseResolveRequest,
	RESOLVER_CONTRACT,
	type ResolveOutcome,
	type ResolveRequest,
	ResolverError,
	type ResourcePlan,
	type ResourceResolver,
} from "@hobo/core";
import {
	instrumentResolvers,
	type ResolverTelemetryOptions,
} from "./delivery-coverage.js";
import type { DriverProgram } from "./driver-program.js";
import {
	isJsonArray,
	isJsonObject,
	isJsonString,
	type JsonValue,
} from "./json.js";
import { LAKEBED_PROVIDER_TARGET } from "./options.js";
import { isRealizablePort, realizeResourcePlans } from "./realize.js";

// public-contract: Lakebed's hosting product id (a Capsule deployment).
export const LAKEBED_CAPSULE_PRODUCT_ID = "lakebed.capsule/v1";

const PROVIDER_ID = "lakebed";
const DIGEST = /^sha256:[a-f0-9]{64}$/u;
const DEPLOYMENT_ID = /^[a-z0-9][a-z0-9-]{0,62}$/u;
const RESOURCE_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/u;
const DESIRED_KEYS = new Set(["deploymentId", "artifactDigest", "resources"]);
const RESOURCE_KEYS = new Set(["name", "port", "deps"]);
const CAPSULE_HOST = /^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.lakebed\.app$/u;
const PROBE_TIMEOUT_MS = 5_000;
const PROBE_MAX_BYTES = 64 * 1024;
const MAX_RESOURCES = 32;

/** What the driver host reports about a deployment; untrusted until parsed. */
export type LakebedCapsuleRecord =
	| {
			readonly state: "live";
			readonly deploymentId: string;
			readonly url: string;
			/** The content address of the artifact the capsule serves, if known. */
			readonly artifactDigest?: string;
	  }
	| { readonly state: "retired"; readonly deploymentId: string };

/** The seam the `lakebed-deploy` driver implements. */
export interface LakebedDeployHost {
	deploy(input: {
		readonly program: DriverProgram;
		readonly artifactDigest: string;
		readonly token: string;
	}): Promise<{ readonly deploymentId: string }>;
	/** `undefined` means Lakebed has never seen this deployment id. */
	describe(input: {
		readonly deploymentId: string;
		readonly token: string;
	}): Promise<LakebedCapsuleRecord | undefined>;
	retire(input: {
		readonly deploymentId: string;
		readonly token: string;
	}): Promise<void>;
}

export interface LakebedResolverOptions extends ResolverTelemetryOptions {
	readonly host: LakebedDeployHost;
	/** Host-side credential lookup: locator in, deploy token out. */
	readonly resolveCredential: (credentialRef: string) => Promise<string>;
}

const HOST_REMEDIATION =
	"check the lakebed-deploy driver (it runs next to the reconciler) and the brokered deploy token, then reconcile again";

function reject(message: string, remediation?: string): never {
	throw new ResolverError(
		"RESOLVER_PROVIDER_REJECTED",
		remediation ? `${message}. Remediation: ${remediation}` : message,
		LAKEBED_CAPSULE_PRODUCT_ID,
	);
}
function unparseable(message: string): never {
	throw new ResolverError(
		"RESOLVER_OUTPUT_UNPARSEABLE",
		message,
		LAKEBED_CAPSULE_PRODUCT_ID,
	);
}

interface CapsuleResource {
	readonly name: string;
	readonly port: CapabilityPortKind;
	readonly deps: readonly string[];
}

interface Target {
	readonly request: ResolveRequest;
	readonly deploymentId: string;
	readonly artifactDigest: string;
	readonly resources: readonly CapsuleResource[];
}

function parseResources(
	value: JsonValue | undefined,
	logicalId: string,
): readonly CapsuleResource[] {
	if (value === undefined)
		return [{ name: logicalId, port: "compute", deps: [] }];
	if (!isJsonArray(value) || value.length === 0 || value.length > MAX_RESOURCES)
		reject(
			`Lakebed desired.resources must list 1 to ${MAX_RESOURCES} capsule resources`,
		);
	const names = new Set<string>();
	const resources = value.map((entry, index): CapsuleResource => {
		if (!isJsonObject(entry))
			reject(`Lakebed desired.resources[${index}] is not an object`);
		for (const key of Object.keys(entry))
			if (!RESOURCE_KEYS.has(key))
				reject(`Lakebed desired.resources[${index}].${key} is not implemented`);
		const { name, port, deps } = entry;
		if (!isJsonString(name) || !RESOURCE_NAME.test(name) || names.has(name))
			reject(`Lakebed desired.resources[${index}].name is invalid or repeated`);
		names.add(name);
		if (!isJsonString(port) || !isRealizablePort(port))
			reject(
				`Lakebed capsules cannot host port ${JSON.stringify(port)}`,
				"bind that port to a provider that offers it (queue: @hobo/provider-kafka or @hobo/provider-upstash; container: a container host)",
			);
		const parsedDeps =
			deps === undefined
				? []
				: isJsonArray(deps) && deps.every((dep) => isJsonString(dep))
					? deps.filter(isJsonString)
					: reject(`Lakebed desired.resources[${index}].deps must be names`);
		// SAFETY: isRealizablePort narrowed port to a Lakebed-hostable capability port.
		return { name, port: port as CapabilityPortKind, deps: parsedDeps };
	});
	for (const resource of resources)
		for (const dep of resource.deps)
			if (!names.has(dep))
				reject(`Lakebed resource ${resource.name} depends on unknown ${dep}`);
	if (resources[0]?.port !== "compute")
		reject("Lakebed desired.resources must start with the compute capsule");
	return resources;
}

function target(raw: ResolveRequest): Target {
	const request = parseResolveRequest(JSON.parse(JSON.stringify(raw)));
	if (request.ref.productId !== LAKEBED_CAPSULE_PRODUCT_ID)
		throw new ResolverError(
			"RESOLVER_PRODUCT_UNSUPPORTED",
			`Lakebed capsule resolver cannot operate on ${request.ref.productId}`,
			request.ref.productId,
		);
	for (const key of Object.keys(request.desired))
		if (!DESIRED_KEYS.has(key))
			reject(`Lakebed capsule does not implement desired.${key}`);
	const deploymentId = request.desired.deploymentId ?? request.ref.logicalId;
	if (!isJsonString(deploymentId) || !DEPLOYMENT_ID.test(deploymentId))
		reject("Lakebed desired.deploymentId is not a valid deployment id");
	if (
		request.ref.physicalId !== undefined &&
		request.ref.physicalId !== deploymentId
	)
		reject("Lakebed deployment id conflicts with its pinned physical identity");
	const digest = request.desired.artifactDigest;
	if (!isJsonString(digest) || !DIGEST.test(digest))
		reject(
			"Lakebed desired.artifactDigest must be a sha256 content address (promote, never rebuild)",
		);
	return {
		request,
		deploymentId,
		artifactDigest: digest,
		resources: parseResources(request.desired.resources, request.ref.logicalId),
	};
}

type Observed =
	| {
			readonly state: "live";
			readonly url: string;
			readonly artifactDigest?: string;
	  }
	| { readonly state: "retired" }
	| undefined;

function parseCapsuleUrl(value: JsonValue | undefined): string {
	if (!isJsonString(value)) unparseable("Lakebed capsule URL is missing");
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		unparseable("Lakebed capsule URL is malformed");
	}
	if (
		url.protocol !== "https:" ||
		url.username ||
		url.password ||
		url.port ||
		url.search ||
		url.hash ||
		!CAPSULE_HOST.test(url.hostname)
	)
		unparseable(
			"Lakebed driver host reported a capsule URL outside https://*.lakebed.app",
		);
	return url.origin;
}

function parseCapsuleRecord(
	value: JsonValue | undefined,
	deploymentId: string,
): Observed {
	if (value === undefined || value === null) return undefined;
	if (!isJsonObject(value)) unparseable("Lakebed capsule record is malformed");
	if (value.deploymentId !== deploymentId)
		unparseable("Lakebed driver host described another deployment");
	if (value.state === "retired") return { state: "retired" };
	if (value.state !== "live")
		unparseable("Lakebed capsule record has no recognized state");
	const url = parseCapsuleUrl(value.url);
	const digest = value.artifactDigest;
	if (digest !== undefined && (!isJsonString(digest) || !DIGEST.test(digest)))
		unparseable("Lakebed capsule artifact digest is not a content address");
	const live = { state: "live" as const, url };
	return digest === undefined ? live : { ...live, artifactDigest: digest };
}

function plans(parsed: Target): ResourcePlan[] {
	return parsed.resources.map((resource) => {
		const plan: ResourcePlan = {
			name: resource.name,
			port: resource.port,
			provider: LAKEBED_PROVIDER_TARGET,
			deploymentId: parsed.deploymentId,
		};
		if (resource.deps.length > 0) plan.deps = [...resource.deps];
		return plan;
	});
}

/** Build the Lakebed resolvers over an injected deploy-driver host. */
export function createLakebedResolvers(
	options: LakebedResolverOptions,
): readonly ResourceResolver[] {
	const host = options.host;
	if (
		!host ||
		!(host.deploy instanceof Function) ||
		!(host.describe instanceof Function) ||
		!(host.retire instanceof Function) ||
		!(options.resolveCredential instanceof Function)
	)
		throw new ResolverError(
			"RESOLVER_PRODUCT_UNSUPPORTED",
			"Lakebed capsule resolver needs a real lakebed-deploy driver host (deploy, describe, retire) and a host-side credential lookup",
			LAKEBED_CAPSULE_PRODUCT_ID,
		);

	async function token(credentialRef: string): Promise<string> {
		let material: string;
		try {
			material = await options.resolveCredential(credentialRef);
		} catch {
			throw new ResolverError(
				"RESOLVER_CREDENTIAL_MISSING",
				"Lakebed deploy token could not be resolved from its credential ref. Remediation: enroll a brokered lakebed.deploy token for this Camp",
				LAKEBED_CAPSULE_PRODUCT_ID,
			);
		}
		if (!isJsonString(material) || material.length === 0)
			throw new ResolverError(
				"RESOLVER_CREDENTIAL_MISSING",
				"Lakebed deploy token resolved empty",
				LAKEBED_CAPSULE_PRODUCT_ID,
			);
		return material;
	}
	async function call<T>(run: () => Promise<T>, operation: string): Promise<T> {
		try {
			return await run();
		} catch (error) {
			if (error instanceof ResolverError) throw error;
			// The host's own message may echo request material; it is not forwarded.
			reject(`Lakebed driver host failed to ${operation}`, HOST_REMEDIATION);
		}
	}
	async function describe(parsed: Target, secret: string): Promise<Observed> {
		const record = await call(
			() => host.describe({ deploymentId: parsed.deploymentId, token: secret }),
			"describe",
		);
		return parseCapsuleRecord(
			JSON.parse(JSON.stringify(record ?? null)),
			parsed.deploymentId,
		);
	}
	async function probe(url: string, transport: HttpTransport): Promise<number> {
		try {
			const response = await transport({
				method: "GET",
				url,
				headers: { accept: "*/*" },
				timeoutMs: PROBE_TIMEOUT_MS,
				maxResponseBytes: PROBE_MAX_BYTES,
			});
			return Number.isSafeInteger(response.status) ? response.status : 0;
		} catch {
			return 0;
		}
	}
	async function outcome(
		parsed: Target,
		observed: Observed,
		transport: HttpTransport,
		action: ResolveOutcome["action"],
	): Promise<ResolveOutcome | undefined> {
		if (observed === undefined) return undefined;
		if (observed.state === "retired")
			return {
				contract: RESOLVER_CONTRACT,
				action,
				physicalId: parsed.deploymentId,
				outputs: {
					deploymentId: parsed.deploymentId,
					ready: false,
					operationConfirmed: true,
					operationTerminal: true,
					absenceConfirmed: true,
					retirementConfirmed: true,
					lifecycleStatus: "absent",
				},
				diagnostics: ["the lakebed-deploy driver reports the capsule retired"],
			};
		const status = await probe(observed.url, transport);
		const healthy = status >= 200 && status < 300;
		const artifactMatches = observed.artifactDigest === parsed.artifactDigest;
		const ready = healthy && artifactMatches;
		const diagnostics: string[] = [];
		if (!healthy)
			diagnostics.push(
				`capsule probe answered ${status === 0 ? "nothing" : `HTTP ${status}`}; readiness is observed, never assumed`,
			);
		if (!artifactMatches)
			diagnostics.push("the driver has not reported the desired artifact yet");
		const observedOutputs = {
			deploymentId: parsed.deploymentId,
			capsuleUrl: observed.url,
			resources: parsed.resources.map((resource) => resource.name),
			probeStatus: status,
			ready,
			operationConfirmed: ready,
			operationTerminal: ready,
			absenceConfirmed: false,
			lifecycleStatus: ready ? "ready" : "pending",
		};
		// Only a ready capsule names a serving endpoint (I5).
		const serving = ready
			? { ...observedOutputs, servingEndpoint: observed.url }
			: observedOutputs;
		return {
			contract: RESOLVER_CONTRACT,
			action,
			physicalId: parsed.deploymentId,
			outputs:
				observed.artifactDigest === undefined
					? serving
					: { ...serving, artifactDigest: observed.artifactDigest },
			diagnostics,
		};
	}

	const resolver: ResourceResolver = {
		providerId: PROVIDER_ID,
		productId: LAKEBED_CAPSULE_PRODUCT_ID,
		async read(raw, transport) {
			const parsed = target(raw);
			const secret = await token(parsed.request.credentialRef);
			return outcome(
				parsed,
				await describe(parsed, secret),
				transport,
				parsed.request.ref.physicalId === parsed.deploymentId
					? "noop"
					: "adopt",
			);
		},
		async reconcile(raw, transport) {
			const parsed = target(raw);
			const secret = await token(parsed.request.credentialRef);
			let observed = await describe(parsed, secret);
			let action: ResolveOutcome["action"] =
				parsed.request.ref.physicalId === parsed.deploymentId
					? "noop"
					: "adopt";
			if (observed?.state === "retired")
				reject(
					`Lakebed deployment ${parsed.deploymentId} was retired; it is not resurrected silently`,
					"deliver the version to a new deployment id",
				);
			if (
				observed?.state === "live" &&
				observed.artifactDigest !== undefined &&
				observed.artifactDigest !== parsed.artifactDigest
			)
				reject(
					`Lakebed deployment ${parsed.deploymentId} serves another artifact; replacing it in place is not a staged transition`,
					"deliver the new version to a new deployment id and shift traffic in-process",
				);
			if (observed === undefined) {
				const { driver } = realizeResourcePlans(plans(parsed), {
					deploymentId: parsed.deploymentId,
				});
				const deployed = await call(
					() =>
						host.deploy({
							program: driver,
							artifactDigest: parsed.artifactDigest,
							token: secret,
						}),
					"deploy",
				);
				if (deployed?.deploymentId !== parsed.deploymentId)
					unparseable("Lakebed driver host deployed another deployment id");
				observed = await describe(parsed, secret);
				action = "create";
				if (observed?.state !== "live")
					reject(
						`Lakebed deployment ${parsed.deploymentId} was deployed but the driver does not describe it live`,
						HOST_REMEDIATION,
					);
			}
			const result = await outcome(parsed, observed, transport, action);
			if (!result) unparseable("Lakebed capsule disappeared during reconcile");
			return result;
		},
		async delete(raw) {
			const parsed = target(raw);
			const secret = await token(parsed.request.credentialRef);
			const before = await describe(parsed, secret);
			if (before === undefined || before.state === "retired") return;
			await call(
				() => host.retire({ deploymentId: parsed.deploymentId, token: secret }),
				"retire",
			);
			const after = await describe(parsed, secret);
			if (after?.state === "live")
				reject(
					`Lakebed deployment ${parsed.deploymentId} retirement is not confirmed; the driver still reports it live`,
					HOST_REMEDIATION,
				);
		},
	};
	return Object.freeze([resolver]);
}

/** Registry of every Lakebed hosting product with a shipped resolver (I14). */
export function lakebedResolverRegistry(options: LakebedResolverOptions) {
	return createResolverRegistry(
		instrumentResolvers(createLakebedResolvers(options), options),
	);
}
