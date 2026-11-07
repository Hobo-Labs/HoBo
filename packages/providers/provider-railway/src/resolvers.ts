import { createHash } from "node:crypto";
import { create, fromJson, toJson } from "@bufbuild/protobuf";
import {
	canonicalJson,
	createResolverRegistry,
	type DurableEventStore,
	guardTransport,
	type HttpTransport,
	type PrincipalRef,
	parseResolveRequest,
	RESOLVER_CONTRACT,
	type ResolveOutcome,
	type ResolveRequest,
	ResolverError,
	type ResourceMutationJournal,
	type ResourceResolver,
	type TransportResponse,
} from "@hobo/core";
import {
	type RailwayDeploymentIdentity,
	RailwayDeploymentIdentitySchema,
} from "./_generated/deployment_identity_pb.js";
import {
	isJsonArray,
	isJsonObject,
	isJsonString,
	type JsonObject,
	type JsonValue,
	parseJsonObject,
} from "./json.js";

// public-contract: Railway's authenticated service product, keyed by the resolver registry.
export const RAILWAY_SERVICE_PRODUCT_ID = "railway.service/v1";
// public-contract: the documented public GraphQL endpoint; callers cannot redirect credentials.
export const RAILWAY_GRAPHQL_ENDPOINT =
	"https://backboard.railway.com/graphql/v2";

/** Scope is supplied by the host, not inferred from a credential or a plan. */
export interface RailwayResolverOptions {
	readonly projectId: string;
	readonly environmentId: string;
	readonly resolveCredential: (ref: string) => Promise<string>;
	readonly mutationJournal?: ResourceMutationJournal;
	readonly deploymentStore?: {
		readonly store: DurableEventStore;
		readonly tenantId: string;
		readonly actor: PrincipalRef;
		readonly fenceToken: bigint;
		readonly nowMs: () => number;
	};
}

const PROJECT_TOKEN =
	"query hoboProjectToken { projectToken { projectId environmentId } }";
const SERVICE =
	"query hoboService($id: String!) { service(id: $id) { id name projectId } }";
const SERVICE_INSTANCE =
	"query hoboServiceInstance($serviceId: String!, $environmentId: String!) { serviceInstance(serviceId: $serviceId, environmentId: $environmentId) { id serviceId environmentId latestDeployment { id } } }";
const DEPLOYMENT =
	"query hoboDeployment($id: String!) { deployment(id: $id) { id projectId environmentId serviceId status deploymentStopped url meta } }";
const DEPLOY =
	"mutation hoboDeploy($serviceId: String!, $environmentId: String!, $commitSha: String!) { serviceInstanceDeployV2(serviceId: $serviceId, environmentId: $environmentId, commitSha: $commitSha) }";
const STOP = "mutation hoboStop($id: String!) { deploymentStop(id: $id) }";
const TERMINAL = new Set(["REMOVED", "FAILED", "CRASHED", "SKIPPED"]);
const STATUSES = new Set([
	"BUILDING",
	"DEPLOYING",
	"INITIALIZING",
	"NEEDS_APPROVAL",
	"REMOVING",
	"SUCCESS",
	"FAILED",
	"CRASHED",
	"REMOVED",
	"SLEEPING",
	"SKIPPED",
	"WAITING",
	"QUEUED",
]);

function reject(message: string): never {
	throw new ResolverError(
		"RESOLVER_PROVIDER_REJECTED",
		message,
		RAILWAY_SERVICE_PRODUCT_ID,
	);
}
function identifier(value: JsonValue | undefined, field: string): string {
	if (!isJsonString(value) || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(value))
		reject(`Railway ${field} must be an explicit resource identifier`);
	return value;
}
function record(value: JsonValue | undefined, field: string): JsonObject {
	if (!isJsonObject(value))
		throw new ResolverError(
			"RESOLVER_OUTPUT_UNPARSEABLE",
			`Railway ${field} is missing or malformed`,
			RAILWAY_SERVICE_PRODUCT_ID,
		);
	return value;
}

/**
 * Authenticated, environment-scoped operations over Railway's documented API.
 *
 * deployOnce is intentionally separate from the convergent ResourceResolver:
 * serviceInstanceDeployV2 creates a deployment and has no documented idempotency
 * key. Its caller MUST journal a single dispatch before calling it; a lost reply
 * remains uncertain. No name scan is presented as an exactly-once create.
 * An existing Railway service is adopted by physical id; this adapter never
 * deletes an entire service (which would delete its other environments too).
 */
export function createRailwayDeploymentClient(options: RailwayResolverOptions) {
	const projectId = identifier(options.projectId, "projectId");
	const environmentId = identifier(options.environmentId, "environmentId");
	function request(raw: ResolveRequest) {
		const parsed = parseResolveRequest(parseJsonObject(JSON.stringify(raw)));
		if (
			parsed.ref.productId !== RAILWAY_SERVICE_PRODUCT_ID ||
			parsed.ref.slot !== "service"
		)
			reject(
				"Railway service resolver cannot operate on another product or slot",
			);
		const serviceId = identifier(
			parsed.desired.serviceId,
			"approved parent service id",
		);
		if (
			parsed.desired.projectId !== projectId ||
			parsed.desired.environmentId !== environmentId
		)
			reject(
				"Railway desired scope differs from the host's bound project/environment",
			);
		return { parsed, serviceId };
	}
	async function session(
		target: ReturnType<typeof request>,
		supplied: HttpTransport,
	) {
		const token = await options.resolveCredential(target.parsed.credentialRef);
		if (!/^[!-~]{1,8192}$/u.test(token))
			throw new ResolverError(
				"RESOLVER_CREDENTIAL_MISSING",
				"Railway project token is missing or invalid",
				RAILWAY_SERVICE_PRODUCT_ID,
			);
		const transport = guardTransport(supplied, {
			allowedHosts: ["backboard.railway.com"],
			allowedPathPrefixes: ["/graphql/v2"],
			maxTimeoutMs: 30_000,
			maxResponseBytes: 1024 * 1024,
		});
		async function query(
			document: string,
			variables: JsonObject = {},
		): Promise<JsonObject> {
			let response: TransportResponse;
			try {
				response = await transport({
					method: "POST",
					url: RAILWAY_GRAPHQL_ENDPOINT,
					headers: {
						"content-type": "application/json",
						"project-access-token": token,
					},
					body: JSON.stringify({ query: document, variables }),
					timeoutMs: 30_000,
					maxResponseBytes: 1024 * 1024,
				});
			} catch {
				reject(
					"Railway transport outcome is uncertain; reconcile without repeating a mutation",
				);
			}
			if (response.status < 200 || response.status >= 300)
				reject(
					`Railway API returned HTTP ${response.status}; no mutation was retried`,
				);
			const body = parseJsonObject(response.body);
			if (
				body.errors !== undefined &&
				(!isJsonArray(body.errors) || body.errors.length > 0)
			)
				reject(
					"Railway GraphQL returned errors; partial data cannot confirm the operation",
				);
			return record(body.data, "GraphQL data");
		}
		const scope = record(
			(await query(PROJECT_TOKEN)).projectToken,
			"project token scope",
		);
		if (scope.projectId !== projectId || scope.environmentId !== environmentId)
			reject("Railway credential is scoped to another project/environment");
		const service = record(
			(await query(SERVICE, { id: target.serviceId })).service,
			"service",
		);
		if (service.id !== target.serviceId || service.projectId !== projectId)
			reject("Railway returned a foreign service identity");
		return { ...target, query };
	}
	function expectedDeployment(parsed: ResolveRequest): string {
		if (
			parsed.ref.physicalId &&
			parsed.desired.deploymentId !== undefined &&
			parsed.desired.deploymentId !== parsed.ref.physicalId
		)
			reject(
				"Railway deployment identity differs from its pinned physical identity",
			);
		return identifier(
			parsed.ref.physicalId ??
				parsed.desired.deploymentId ??
				parsed.observed?.deploymentId,
			"deploymentId",
		);
	}
	async function inspect(
		active: Awaited<ReturnType<typeof session>>,
		deploymentId: string,
	): Promise<ResolveOutcome> {
		const data = await active.query(DEPLOYMENT, { id: deploymentId });
		if (data.deployment === null) {
			// Pruned history cannot prove that an uncertain operation cannot apply later.
			return outcome(active.serviceId, deploymentId, "UNKNOWN", "", false);
		}
		const found = record(data.deployment, "deployment");
		if (
			found.id !== deploymentId ||
			found.serviceId !== active.serviceId ||
			found.projectId !== projectId ||
			found.environmentId !== environmentId
		)
			reject("Railway returned a foreign deployment identity or scope");
		if (found.deploymentStopped !== true && found.deploymentStopped !== false)
			throw new ResolverError(
				"RESOLVER_OUTPUT_UNPARSEABLE",
				"Railway deployment stop evidence is missing",
				RAILWAY_SERVICE_PRODUCT_ID,
			);
		if (!isJsonString(found.status) || !STATUSES.has(found.status))
			throw new ResolverError(
				"RESOLVER_OUTPUT_UNPARSEABLE",
				"Railway deployment status is not recognized",
				RAILWAY_SERVICE_PRODUCT_ID,
			);
		let endpoint = "";
		if (found.url !== undefined && found.url !== null && found.url !== "") {
			if (!isJsonString(found.url))
				reject("Railway deployment URL is malformed");
			let url: URL;
			try {
				url = new URL(found.url);
			} catch {
				reject("Railway deployment URL must be absolute HTTPS");
			}
			if (
				url.protocol !== "https:" ||
				url.username ||
				url.password ||
				url.hash ||
				url.search
			)
				reject("Railway deployment URL must be credential-free HTTPS");
			endpoint = url.toString();
		}
		const result = outcome(
			active.serviceId,
			deploymentId,
			found.status,
			endpoint,
			true,
			found.deploymentStopped,
		);
		const meta = isJsonObject(found.meta) ? found.meta : undefined;
		const observedCommit = meta?.commitHash;
		const validCommit =
			isJsonString(observedCommit) &&
			/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(observedCommit);
		if (validCommit)
			Object.assign(result.outputs, { observedCommitSha: observedCommit });
		if (
			active.parsed.desired.commitSha !== undefined &&
			(!validCommit || active.parsed.desired.commitSha !== observedCommit)
		)
			Object.assign(result.outputs, {
				ready: false,
				commitMatches: false,
				lifecycleStatus:
					result.outputs.lifecycleStatus === "ready"
						? "pending"
						: result.outputs.lifecycleStatus,
			});
		if (result.outputs.ready === true)
			Object.assign(result.outputs, { servingEndpoint: endpoint });
		return result;
	}
	function outcome(
		serviceId: string,
		deploymentId: string,
		status: string,
		endpoint: string,
		observed: boolean,
		stopped = false,
	): ResolveOutcome {
		const terminal = observed && (status === "SUCCESS" || TERMINAL.has(status));
		const retired = terminal && stopped;
		return {
			contract: RESOLVER_CONTRACT,
			action: "noop",
			physicalId: deploymentId,
			outputs: {
				projectId,
				environmentId,
				serviceId,
				deploymentId,
				status,
				ready: status === "SUCCESS" && endpoint !== "" && !stopped,
				operationConfirmed: terminal,
				retirementConfirmed: retired,
				absenceConfirmed: retired,
				operationTerminal: terminal,
				lifecycleStatus: retired
					? "absent"
					: status === "FAILED" || status === "CRASHED"
						? "failed"
						: status === "SUCCESS"
							? "ready"
							: "pending",
				endpoint,
			},
			diagnostics: observed
				? []
				: ["deployment outcome is unknown; retain financial exposure"],
		};
	}
	return {
		async deployOnce(
			raw: ResolveRequest,
			transport: HttpTransport,
		): Promise<ResolveOutcome> {
			const target = request(raw);
			const commitSha = target.parsed.desired.commitSha;
			if (
				!isJsonString(commitSha) ||
				!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(commitSha)
			)
				reject("Railway deployment requires a pinned full commit SHA");
			const active = await session(target, transport);
			const instance = record(
				(
					await active.query(SERVICE_INSTANCE, {
						serviceId: active.serviceId,
						environmentId,
					})
				).serviceInstance,
				"service instance",
			);
			if (
				instance.serviceId !== active.serviceId ||
				instance.environmentId !== environmentId
			)
				reject("Railway returned a foreign parent service instance");
			if (instance.latestDeployment !== null)
				reject(
					"Railway new deployment requires a fresh approved parent service instance with no deployment history; in-place replacement is not a staged hosting transition",
				);
			const data = await active.query(DEPLOY, {
				serviceId: active.serviceId,
				environmentId,
				commitSha,
			});
			const deploymentId = identifier(
				data.serviceInstanceDeployV2,
				"created deployment id",
			);
			const accepted = outcome(
				active.serviceId,
				deploymentId,
				"QUEUED",
				"",
				false,
			);
			return {
				...accepted,
				action: "update",
				diagnostics: [
					"deployment accepted; independent readiness observation required",
				],
			};
		},
		async read(
			raw: ResolveRequest,
			transport: HttpTransport,
		): Promise<ResolveOutcome> {
			const target = request(raw);
			const deploymentId = expectedDeployment(target.parsed);
			const active = await session(target, transport);
			return inspect(active, deploymentId);
		},
		async stop(
			raw: ResolveRequest,
			transport: HttpTransport,
		): Promise<ResolveOutcome> {
			const target = request(raw);
			const deploymentId = expectedDeployment(target.parsed);
			const active = await session(target, transport);
			const current = await inspect(active, deploymentId);
			if (current.outputs.retirementConfirmed === true) return current;
			if (current.outputs.status === "UNKNOWN")
				reject("Railway cannot stop an unobserved deployment");
			const stopped = await active.query(STOP, { id: deploymentId });
			if (stopped.deploymentStop !== true)
				reject("Railway did not acknowledge deployment stop");
			return inspect(active, deploymentId);
		},
	};
}

/** Read/adopt an explicitly identified deployment; creation is single-dispatch above. */
export function createRailwayResolvers(
	options: RailwayResolverOptions,
): readonly ResourceResolver[] {
	const client = createRailwayDeploymentClient(options);
	function deployment(raw: ResolveRequest) {
		const parsed = parseResolveRequest(parseJsonObject(JSON.stringify(raw)));
		if (
			parsed.ref.productId !== RAILWAY_SERVICE_PRODUCT_ID ||
			parsed.ref.slot !== "service"
		)
			reject("Railway resolver requires the exact service product");
		const serviceId = identifier(
			parsed.desired.serviceId,
			"approved parent service id",
		);
		if (
			parsed.desired.projectId !== options.projectId ||
			parsed.desired.environmentId !== options.environmentId
		)
			reject("Railway deployment scope differs from its configured parents");
		const explicit =
			parsed.ref.physicalId ??
			parsed.desired.deploymentId ??
			parsed.observed?.deploymentId;
		if (
			parsed.ref.physicalId &&
			parsed.desired.deploymentId !== undefined &&
			parsed.desired.deploymentId !== parsed.ref.physicalId
		)
			reject(
				"Railway deployment physical identity conflicts with desired deploymentId",
			);
		return {
			parsed,
			serviceId,
			explicit:
				explicit === undefined
					? undefined
					: identifier(explicit, "deploymentId"),
		};
	}
	function creation(target: ReturnType<typeof deployment>) {
		const commitSha = target.parsed.desired.commitSha,
			operationId = target.parsed.desired.operationId;
		if (
			!isJsonString(commitSha) ||
			!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(commitSha)
		)
			reject("Railway creation requires a pinned full commit SHA");
		if (
			!isJsonString(operationId) ||
			!operationId ||
			operationId.length > 1000 ||
			/[\s\p{Cc}]/u.test(operationId)
		)
			reject("Railway creation requires a stable operation identity");
		for (const field of Object.keys(target.parsed.desired))
			if (
				![
					"projectId",
					"environmentId",
					"serviceId",
					"commitSha",
					"operationId",
					"deploymentId",
				].includes(field)
			)
				reject(`Railway deployment does not implement desired.${field}`);
		const config = options.deploymentStore;
		if (
			!config?.tenantId ||
			config.fenceToken < 1n ||
			options.mutationJournal?.persistence !== "durable-cas"
		)
			reject(
				"Railway deployment creation requires durable identity storage and a durable-cas mutation journal",
			);
		const identity = {
			tenantId: config.tenantId,
			projectId: options.projectId,
			environmentId: options.environmentId,
			serviceId: target.serviceId,
			logicalId: target.parsed.ref.logicalId,
			operationId,
			commitSha,
		};
		const mutationId = canonicalJson([
			"railway-deployment",
			identity.tenantId,
			identity.projectId,
			identity.environmentId,
			identity.serviceId,
			identity.logicalId,
			operationId,
		]);
		const requestDigest = `sha256:${createHash("sha256")
			.update(
				canonicalJson({
					...identity,
					credentialRef: target.parsed.credentialRef,
				}),
			)
			.digest("hex")}`;
		const streamId = `railway-deployment:${createHash("sha256").update(mutationId).digest("hex")}`;
		return { identity, mutationId, requestDigest, streamId, config };
	}
	async function receipt(
		context: ReturnType<typeof creation>,
	): Promise<RailwayDeploymentIdentity | undefined> {
		let identity: RailwayDeploymentIdentity | undefined;
		for await (const event of context.config.store.read(context.streamId)) {
			if (
				event.tenant !== context.config.tenantId ||
				event.streamId !== context.streamId ||
				event.seq !== 1 ||
				identity
			)
				reject(
					"Railway deployment identity history is foreign or not immutable",
				);
			const found = fromJson(
				RailwayDeploymentIdentitySchema,
				JSON.parse(JSON.stringify(event.data)),
			);
			for (const field of [
				"tenantId",
				"projectId",
				"environmentId",
				"serviceId",
				"logicalId",
				"operationId",
				"commitSha",
			] as const)
				if (found[field] !== context.identity[field])
					reject("Railway deployment identity was reused with another request");
			if (
				found.requestDigest !== context.requestDigest ||
				!Number.isSafeInteger(found.recordedAtMs) ||
				found.recordedAtMs < 0
			)
				reject("Railway deployment identity digest or timestamp is invalid");
			identifier(found.deploymentId, "stored native deployment id");
			identity = found;
		}
		return identity;
	}
	function pinned(
		target: ReturnType<typeof deployment>,
		deploymentId: string,
	): ResolveRequest {
		return parseResolveRequest({
			ref: { ...target.parsed.ref, physicalId: deploymentId },
			desired: { ...target.parsed.desired, deploymentId },
			credentialRef: target.parsed.credentialRef,
		});
	}
	async function read(
		raw: ResolveRequest,
		transport: HttpTransport,
	): Promise<ResolveOutcome | undefined> {
		const target = deployment(raw);
		if (target.explicit)
			return client.read(pinned(target, target.explicit), transport);
		if (
			!options.deploymentStore ||
			options.mutationJournal?.persistence !== "durable-cas"
		)
			return undefined;
		const stored = await receipt(creation(target));
		return stored
			? client.read(pinned(target, stored.deploymentId), transport)
			: undefined;
	}
	return [
		{
			providerId: "railway",
			productId: RAILWAY_SERVICE_PRODUCT_ID,
			read,
			async reconcile(raw, transport) {
				const target = deployment(raw);
				if (target.explicit)
					return client.read(pinned(target, target.explicit), transport);
				const context = creation(target),
					stored = await receipt(context);
				if (stored)
					return client.read(pinned(target, stored.deploymentId), transport);
				const journal = options.mutationJournal;
				if (!journal) reject("Railway durable mutation journal is missing");
				const claim = await journal.claim({
					mutationId: context.mutationId,
					requestDigest: context.requestDigest,
				});
				if (claim.status !== "claimed") {
					const recovered = await receipt(context);
					if (recovered)
						return client.read(
							pinned(target, recovered.deploymentId),
							transport,
						);
					reject(
						"Railway deployment outcome is uncertain and has no durable native identity; a second deployment mutation is forbidden",
					);
				}
				try {
					const accepted = await client.deployOnce(target.parsed, transport);
					const deploymentId = identifier(
							accepted.physicalId,
							"created native deployment id",
						),
						recordedAtMs = context.config.nowMs();
					if (!Number.isSafeInteger(recordedAtMs) || recordedAtMs < 0)
						reject("Railway deployment journal clock is invalid");
					const identity = create(RailwayDeploymentIdentitySchema, {
						...context.identity,
						deploymentId,
						requestDigest: context.requestDigest,
						recordedAtMs,
					});
					await context.config.store.commit({
						streamId: context.streamId,
						append: {
							expectedSeq: 0,
							tenant: context.config.tenantId,
							actor: context.config.actor,
							fenceToken: context.config.fenceToken,
						},
						events: [
							{
								type: "railway.DeploymentLocated",
								data: toJson(RailwayDeploymentIdentitySchema, identity),
							},
						],
					});
					await journal.acknowledge(context.mutationId, context.requestDigest);
					return { ...accepted, action: "create" };
				} catch (error) {
					await journal.uncertain(context.mutationId, context.requestDigest);
					throw error;
				}
			},
			async delete(request, transport) {
				const target = deployment(request);
				const stored = target.explicit
					? undefined
					: await receipt(creation(target));
				const deploymentId = target.explicit ?? stored?.deploymentId;
				if (!deploymentId)
					reject(
						"Railway retirement requires an exact native deployment identity; absence is unknown",
					);
				const result = await client.stop(
					pinned(target, deploymentId),
					transport,
				);
				if (result.outputs.retirementConfirmed !== true)
					reject(
						"Railway retirement is pending; a stop acknowledgement does not prove retirement",
					);
			},
		},
	];
}

export function railwayResolverRegistry(options: RailwayResolverOptions) {
	return createResolverRegistry(createRailwayResolvers(options));
}
