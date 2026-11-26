import { createHash } from "node:crypto";
import { create, fromJson, toJson } from "@bufbuild/protobuf";
import {
	HostingTransitionAction as Action,
	canonicalHostingEvidence,
	type DeploymentPlan,
	foldHostingTransition,
	type HostingDestinationLiability,
	type HostingOperationRequest,
	type HostingTransitionProvider,
	hashDeploymentPlan,
	hostingTransitionContracts,
	hostingTransitionStream,
} from "@hobo/cloud";
import {
	CAPABILITY_SLOTS,
	type CapabilitySlot,
	type DurableEventStore,
	type HttpTransport,
	observeResolverLifecycle,
	type PrincipalRef,
	parseResolveOutcome,
	parseResolveRequest,
	parseResourceLifecycleObservation,
	parseRoutingPlan,
	type ResolvedResourceRef,
	type ResourceLifecycleContext,
	type ResourceLifecycleObservation,
	ResourceLifecycleObservationRecordSchema,
	type ResourceMutationJournal,
	type ResourceResolver,
	type RoutingPlan,
	type TrafficRoutingPort,
} from "@hobo/core";
import {
	DIGITALOCEAN_APP_JOB_PRODUCT_ID,
	DIGITALOCEAN_APP_SERVICE_PRODUCT_ID,
	DIGITALOCEAN_APP_STATIC_SITE_PRODUCT_ID,
	DIGITALOCEAN_APP_WORKER_PRODUCT_ID,
} from "@hobo/provider-digitalocean";
import { RAILWAY_SERVICE_PRODUCT_ID } from "@hobo/provider-railway";
import { aggregateHostingBillingObservations } from "./hosting-billing-observations.js";
import { createDurableHostingMutationScope } from "./hosting-mutation-scope.js";
import { assertHostingServingEndpoints } from "./hosting-serving-endpoint.js";
import {
	cloneAsJson,
	isJsonNumber,
	isJsonObject,
	isJsonString,
	type JsonObject,
	parseJsonValue,
} from "./json.js";

export interface HostingOperatingLiabilityInput {
	readonly request: HostingOperationRequest;
	readonly node: DeploymentPlan["resources"][number];
	readonly artifactId: string;
	readonly resourceId: string;
	readonly physicalId?: string;
	readonly nowMs: number;
	readonly transport: HttpTransport;
}

/** The reader must obtain native, independently authenticated evidence. Desired
 * expiry, soft quotas and timers are not enforceable financial bounds. */
export type HostingOperatingLiabilityReader = (
	input: HostingOperatingLiabilityInput,
) => Promise<{
	readonly liability: HostingDestinationLiability;
	readonly finalized: boolean;
}>;

export type HostingResourceLifecycleReader = (
	input: HostingOperatingLiabilityInput & {
		readonly context: ResourceLifecycleContext;
	},
) => Promise<ResourceLifecycleObservation>;

export interface HostingDesiredInput {
	readonly productId: string;
	readonly source: boolean;
	readonly physicalId?: string;
	readonly parameters: JsonObject;
	readonly artifactId: string;
	readonly contentDigest?: string;
	readonly logicalId: string;
	readonly operationId: string;
	readonly ownershipRef: string;
}

export interface ProductionResolverBinding {
	readonly prepareDesired?: (input: HostingDesiredInput) => JsonObject;
	readonly observeLifecycle?: HostingResourceLifecycleReader;
	readonly observeOperatingLiability: HostingOperatingLiabilityReader;
	readonly registry: { get(productId: string): ResourceResolver | undefined };
	readonly transport: HttpTransport;
	readonly credentialRef: string;
	readonly providerAccountId: string;
	verifyCredentialScope(input: {
		tenantId: string;
		providerId: string;
		providerAccountId: string;
		credentialRef: string;
		operationId: string;
		nowMs: number;
	}): Promise<void>;
}

/** Provider-independent execution wiring. Provider API semantics remain owned by
 * the shipped ResourceResolvers; all state advances require their readbacks. */
export interface ResolverHostingProviderOptions {
	readonly store: DurableEventStore;
	readonly context: {
		readonly tenantId: string;
		readonly actor: PrincipalRef;
		readonly fenceToken: bigint;
	};
	readonly mutationJournal: ResourceMutationJournal;
	readonly artifacts: ReadonlyMap<string, DeploymentPlan>;
	/** Independently observed image/code identity expected from each approved plan.
	 * This is distinct from the plan's graph/financial hash. */
	readonly resourceArtifacts: ReadonlyMap<string, ReadonlyMap<string, string>>;
	readonly resourceIdentities?: ReadonlyMap<
		string,
		ReadonlyMap<string, ResolvedResourceRef>
	>;
	readonly providers: ReadonlyMap<string, ProductionResolverBinding>;
	readonly destructiveResourceApprovals?: ReadonlyMap<
		string,
		ReadonlySet<string>
	>;
	readonly routing: ReadonlyMap<
		string,
		{
			readonly port: TrafficRoutingPort;
			readonly providerAccountId: string;
			readonly credentialRef: string;
			readonly verifyCredentialScope: ProductionResolverBinding["verifyCredentialScope"];
			readonly source: RoutingPlan;
			readonly target: RoutingPlan;
		}
	>;
	readonly health: ReadonlyMap<
		string,
		{
			readonly url: string;
			readonly additionalUrls?: readonly string[];
			readonly transport: HttpTransport;
		}
	>;
	readonly billing: {
		observe(
			request: HostingOperationRequest,
		): Promise<readonly ResourceLifecycleObservation[]>;
	};
	/** Explicit loopback-only fixture policy. Real provider endpoints require HTTPS. */
	readonly allowInsecureLocalEndpoints?: boolean;
	readonly nowMs: () => number;
}

const slots = new Map<string, CapabilitySlot>([
	...CAPABILITY_SLOTS.map((slot): readonly [string, CapabilitySlot] => [
		slot,
		slot,
	]),
	["compute", "service"],
	["objectStore", "bucket"],
]);

/** Drives real provider resolvers and the selected Station routing adapter. No
 * accepted request, positive estimate, or DELETE ack is interpreted as success. */
export function createResolverHostingTransitionProvider(
	options: ResolverHostingProviderOptions,
): HostingTransitionProvider {
	if (options.mutationJournal.persistence !== "durable-cas")
		throw new Error("production hosting requires a durable mutation journal");
	const mutationScope = createDurableHostingMutationScope({
		store: options.store,
		...options.context,
		nowMs: options.nowMs,
	});
	const providers = new Map(
		[...options.providers].map(([id, binding]) => [
			id,
			Object.freeze({ ...binding }),
		]),
	);
	const resourceArtifacts = new Map(
		[...options.resourceArtifacts].map(([id, hashes]) => [id, new Map(hashes)]),
	);
	const resourceIdentities = new Map(
		[...(options.resourceIdentities ?? [])].map(([id, refs]) => [
			id,
			new Map(
				[...refs].map(([name, ref]) => [name, Object.freeze({ ...ref })]),
			),
		]),
	);
	const routes = new Map(
		[...options.routing].map(([id, value]) => [
			id,
			{
				...value,
				source: parseRoutingPlan(cloneAsJson(value.source)),
				target: parseRoutingPlan(cloneAsJson(value.target)),
			},
		]),
	);
	const probes = new Map(
		[...options.health].map(([id, value]) => [
			id,
			Object.freeze({
				...value,
				additionalUrls: Object.freeze([...(value.additionalUrls ?? [])]),
			}),
		]),
	);
	const destructive = new Map(
		[...(options.destructiveResourceApprovals ?? [])].map(([id, names]) => [
			id,
			new Set(names),
		]),
	);
	const artifacts: ReadonlyMap<string, DeploymentPlan> = new Map(
		[...options.artifacts].map(([hash, plan]) => {
			if (hashDeploymentPlan(plan) !== hash)
				throw new Error("hosting artifact does not match its content address");
			return [hash, structuredClone(plan)] as const;
		}),
	);
	function artifact(id: string) {
		const plan = artifacts.get(id);
		if (!plan) throw new Error("approved hosting artifact is unavailable");
		return plan;
	}
	function shared(
		request: Pick<HostingOperationRequest, "plan">,
		node: DeploymentPlan["resources"][number],
	) {
		if (request.plan.intent === "decommission") return false;
		const source = artifact(request.plan.sourcePlanId).resources.find(
			(row) => row.name === node.name,
		);
		const target = artifact(request.plan.targetPlanId).resources.find(
			(row) => row.name === node.name,
		);
		return Boolean(
			source &&
				target &&
				source.provider === target.provider &&
				source.productId === target.productId &&
				canonicalHostingEvidence(source.realizationParameters) ===
					canonicalHostingEvidence(target.realizationParameters),
		);
	}
	function assertStagingIsolation(plan: HostingOperationRequest["plan"]) {
		if (plan.intent === "decommission") return;
		for (const target of artifact(plan.targetPlanId).resources) {
			if (
				target.productId !== RAILWAY_SERVICE_PRODUCT_ID ||
				shared({ plan }, target)
			)
				continue;
			const targetBinding = providers.get(target.provider);
			if (
				targetBinding?.registry.get(RAILWAY_SERVICE_PRODUCT_ID)?.providerId !==
				"railway"
			)
				continue;
			const serviceId = target.realizationParameters?.serviceId;
			if (!isJsonString(serviceId) || !serviceId)
				throw new Error(
					"Railway staging requires an explicit approved service parent",
				);
			for (const source of artifact(plan.sourcePlanId).resources) {
				const sourceBinding = providers.get(source.provider);
				if (
					source.productId === RAILWAY_SERVICE_PRODUCT_ID &&
					source.realizationParameters?.serviceId === serviceId &&
					sourceBinding?.registry === targetBinding.registry &&
					sourceBinding.providerAccountId === targetBinding.providerAccountId
				)
					throw new Error(
						"Railway staging must use a distinct service parent; an in-place deployment can replace the incumbent before Station cutover",
					);
			}
		}
	}
	function fundedPayer(
		request: HostingOperationRequest,
		providerAccountId: string,
	) {
		if (
			!request.plan.commitment?.allocations.some((allocation) =>
				allocation.providerCharges.some(
					(charge) => charge.providerAccountId === providerAccountId,
				),
			)
		)
			throw new Error("provider mutation account has no funded exposure");
	}
	async function verifyMutation(
		request: HostingOperationRequest,
		binding: ProductionResolverBinding,
		providerId: string,
	) {
		fundedPayer(request, binding.providerAccountId);
		await binding.verifyCredentialScope({
			tenantId: request.plan.tenantId,
			providerId,
			providerAccountId: binding.providerAccountId,
			credentialRef: binding.credentialRef,
			operationId: request.operation.operationId,
			nowMs: options.nowMs(),
		});
	}
	function destructionAllowed(
		request: HostingOperationRequest,
		node: DeploymentPlan["resources"][number],
	) {
		if (
			!["compute", "service", "route", "endpoint"].includes(node.port) &&
			!destructive.get(request.plan.deploymentId)?.has(node.name)
		)
			throw new Error(
				"stateful resource destruction requires explicit resource-scoped retention policy approval",
			);
	}
	function checkedTransport(
		request: HostingOperationRequest,
		transport: HttpTransport,
		readOnly = false,
	): HttpTransport {
		const deadlineAtMs = readOnly
			? options.nowMs() + request.plan.operationTimeoutMs
			: request.operation.deadlineAtMs;
		return async (call) => {
			if (request.signal.aborted || options.nowMs() >= deadlineAtMs)
				throw new Error("hosting operation expired before provider I/O");
			return transport({
				...call,
				timeoutMs: Math.min(
					call.timeoutMs,
					Math.max(1, deadlineAtMs - options.nowMs()),
				),
			});
		};
	}
	function incarnation(request: HostingOperationRequest, artifactId: string) {
		const value =
			artifactId === request.plan.sourcePlanId
				? request.plan.sourceIncarnationId
				: request.plan.transitionId;
		if (!value && artifact(artifactId).resources.length)
			throw new Error(
				"existing source requires an approved immutable native incarnation identity",
			);
		return value;
	}
	function metadataStream(
		request: HostingOperationRequest,
		artifactId: string,
		resourceId: string,
	) {
		const identity = JSON.stringify([
			options.context.tenantId,
			request.plan.deploymentId,
			incarnation(request, artifactId),
			artifactId,
			resourceId,
		]);
		return `hosting-resource:${createHash("sha256").update(identity).digest("hex")}`;
	}
	async function located(
		request: HostingOperationRequest,
		artifactId: string,
		resourceId: string,
	) {
		let observation: ResourceLifecycleObservation | undefined;
		let seq = 0;
		const streamId = metadataStream(request, artifactId, resourceId);
		for await (const event of options.store.read(streamId)) {
			if (
				event.tenant !== options.context.tenantId ||
				event.streamId !== streamId ||
				event.seq !== seq + 1 ||
				event.type !== "hosting.ResourceLocated"
			)
				throw new Error("foreign resource identity history");
			const decoded = fromJson(
				ResourceLifecycleObservationRecordSchema,
				JSON.parse(JSON.stringify(event.data)),
			);
			observation = parseResourceLifecycleObservation(decoded, {
				tenantId: request.plan.tenantId,
				providerId: decoded.providerId,
				providerAccountId: decoded.providerAccountId,
				productId: decoded.productId,
				resourceId: decoded.resourceId,
				operationId: decoded.operationId,
				physicalId: decoded.physicalId,
				nowMs: options.nowMs(),
				maxAgeMs: Number.MAX_SAFE_INTEGER,
			});
			seq = event.seq;
		}
		return { observation, seq };
	}
	async function recordLocation(
		request: HostingOperationRequest,
		artifactId: string,
		node: DeploymentPlan["resources"][number],
		logicalId: string,
		physicalId: string,
		providerId: string,
		accountId: string,
	) {
		const previous = await located(request, artifactId, node.name);
		if (previous.observation?.physicalId === physicalId) return;
		if (previous.observation)
			throw new Error("provider changed an immutable resource identity");
		const observation = create(ResourceLifecycleObservationRecordSchema, {
			tenantId: request.plan.tenantId,
			providerId,
			providerAccountId: accountId,
			productId: node.productId ?? "",
			resourceId: logicalId,
			physicalId,
			operationId: request.operation.operationId,
			status: "pending",
			observedAtMs: options.nowMs(),
			evidenceRef: `provider-ack:${request.operation.operationId}:${node.name}`,
		});
		await options.store.commit({
			streamId: metadataStream(request, artifactId, node.name),
			append: {
				tenant: options.context.tenantId,
				actor: options.context.actor,
				fenceToken: request.fenceToken,
				expectedSeq: previous.seq,
			},
			events: [
				{
					type: "hosting.ResourceLocated",
					data: toJson(ResourceLifecycleObservationRecordSchema, observation),
				},
			],
		});
	}
	async function resource(
		request: HostingOperationRequest,
		artifactId: string,
		node: DeploymentPlan["resources"][number],
		readOnly = false,
	) {
		const binding = providers.get(node.provider);
		if (!binding || !node.productId || !node.realizationParameters)
			throw new Error(
				"hosting resource lacks an exact provider/product/parameter binding",
			);
		const resolver = binding.registry.get(node.productId);
		const slot = slots.get(node.port);
		if (!resolver?.read || !slot)
			throw new Error(
				"hosting provider lacks authoritative lifecycle reads for the selected product",
			);
		const expectedArtifact = resourceArtifacts.get(artifactId)?.get(node.name);
		if (
			(node.port === "compute" || node.port === "service") &&
			(!expectedArtifact || !/^sha256:[a-f0-9]{64}$/.test(expectedArtifact))
		)
			throw new Error(
				"application resource requires an approved content digest independent of plan geometry",
			);
		if (artifactId === request.plan.targetPlanId) {
			const allocation = request.plan.commitment?.allocations.find(
				(row) => row.resourceName === node.name,
			);
			const quote = request.plan.commitment?.evidence?.quotes.find(
				(row) =>
					row.id === allocation?.quoteId && row.resourceName === node.name,
			);
			if (
				!quote ||
				quote.providerId !== node.provider ||
				quote.providerAccountId !== binding.providerAccountId
			)
				throw new Error(
					"provider account or resource differs from its funded quote",
				);
		}
		const identityArtifact =
			artifactId === request.plan.targetPlanId && shared(request, node)
				? request.plan.sourcePlanId
				: artifactId;
		const prior = await located(request, identityArtifact, node.name);
		const inventory =
			identityArtifact === request.plan.sourcePlanId
				? resourceIdentities.get(identityArtifact)?.get(node.name)
				: undefined;
		const nativeIdentity = JSON.stringify([
			request.plan.tenantId,
			request.plan.deploymentId,
			incarnation(request, identityArtifact),
			identityArtifact,
			node.name,
		]);
		const generatedId = `hobo-${createHash("sha256").update(nativeIdentity).digest("hex").slice(0, 26)}`;
		if (
			prior.observation &&
			(prior.observation.tenantId !== request.plan.tenantId ||
				prior.observation.providerId !== resolver.providerId ||
				prior.observation.providerAccountId !== binding.providerAccountId ||
				prior.observation.productId !== node.productId ||
				!prior.observation.physicalId ||
				prior.observation.resourceId !== (inventory?.logicalId ?? generatedId))
		)
			throw new Error(
				"durable native identity belongs to another resource, account or incarnation",
			);
		const logicalId =
			prior.observation?.resourceId ?? inventory?.logicalId ?? generatedId;
		if (
			identityArtifact === request.plan.sourcePlanId &&
			!prior.observation &&
			!inventory
		)
			throw new Error(
				"existing source requires an explicit immutable resource inventory",
			);
		const context = {
			tenantId: request.plan.tenantId,
			providerId: resolver.providerId,
			providerAccountId: binding.providerAccountId,
			productId: node.productId,
			resourceId: logicalId,
			operationId: request.operation.operationId,
			nowMs: options.nowMs(),
			maxAgeMs: request.plan.constraints?.observationMaxAgeMs ?? 0,
			evidenceRef: `provider-read:${resolver.providerId}:${encodeURIComponent(node.productId)}:${encodeURIComponent(node.name)}:${request.operation.operationId}`,
		};
		const observedContext = expectedArtifact
			? { ...context, artifactDigest: expectedArtifact }
			: context;
		const physicalId = prior.observation?.physicalId ?? inventory?.physicalId;
		if (identityArtifact === request.plan.sourcePlanId && !physicalId)
			throw new Error(
				"existing source requires an exact pinned native physical identity",
			);
		const ref = physicalId
			? { slot, productId: node.productId, logicalId, physicalId }
			: { slot, productId: node.productId, logicalId };
		const completeContext = physicalId
			? { ...observedContext, physicalId }
			: observedContext;
		const stableOperationId = `hosting:${createHash("sha256").update(nativeIdentity).digest("hex")}`;
		const ownershipRef = `${request.plan.tenantId}/${request.plan.deploymentId}/${incarnation(request, identityArtifact)}/${node.name}`;
		const parameters = cloneAsJson(node.realizationParameters);
		if (!isJsonObject(parameters))
			throw new Error(
				"native realization parameters must be a canonical JSON object",
			);
		const desired = binding.prepareDesired
			? binding.prepareDesired({
					productId: node.productId,
					source: identityArtifact === request.plan.sourcePlanId,
					...(physicalId ? { physicalId } : undefined),
					parameters,
					artifactId: identityArtifact,
					...(expectedArtifact
						? { contentDigest: expectedArtifact }
						: undefined),
					logicalId,
					operationId: stableOperationId,
					ownershipRef,
				})
			: {
					...node.realizationParameters,
					planDigest: artifactId,
					operationId: stableOperationId,
					ownershipRef,
				};
		const resolve = parseResolveRequest({
			ref,
			desired,
			credentialRef: binding.credentialRef,
		});
		return {
			binding,
			resolver,
			identityArtifact,
			context: completeContext,
			resolve,
			transport: checkedTransport(request, binding.transport, readOnly),
		};
	}
	async function operatingLiabilities(
		request: HostingOperationRequest,
		readOnly = false,
		source = false,
	) {
		const actual: HostingDestinationLiability[] = [];
		let finalized = true;
		const artifactId = source
			? request.plan.sourcePlanId
			: request.plan.targetPlanId;
		const expected = source
			? request.plan.sourceLiabilities
			: request.plan.destinationLiabilities;
		const graph = artifact(artifactId);
		if (expected.length !== graph.resources.length)
			throw new Error(
				"every source and destination resource requires an enforceable native liability bound",
			);
		for (const node of graph.resources) {
			const bound = await resource(request, artifactId, node, readOnly);
			await verifyMutation(request, bound.binding, bound.resolver.providerId);
			const observed = await bound.binding.observeOperatingLiability({
				request,
				node,
				artifactId,
				resourceId: bound.resolve.ref.logicalId,
				...(bound.resolve.ref.physicalId
					? { physicalId: bound.resolve.ref.physicalId }
					: undefined),
				nowMs: options.nowMs(),
				transport: bound.transport,
			});
			const proof = observed.liability;
			const expiredSettlement =
				(request.operation.action === Action.SETTLE ||
					(source && request.plan.intent === "decommission")) &&
				proof.expiresAtMs > 0 &&
				observed.finalized === true;
			if (
				!Number.isSafeInteger(proof.maximumMicros) ||
				proof.maximumMicros < 0 ||
				!Number.isSafeInteger(proof.expiresAtMs) ||
				proof.expiresAtMs < 0 ||
				proof.resourceName !== node.name ||
				proof.providerId !== node.provider ||
				proof.providerAccountId !== bound.binding.providerAccountId ||
				proof.artifactDigest !==
					resourceArtifacts.get(artifactId)?.get(node.name) ||
				(proof.mode !== "provider-funded-zero" &&
					proof.mode !== "native-finite-term") ||
				(proof.mode === "provider-funded-zero" && proof.maximumMicros !== 0) ||
				(proof.expiresAtMs > 0 &&
					proof.expiresAtMs <= options.nowMs() &&
					!expiredSettlement) ||
				(proof.expiresAtMs > 0 &&
					proof.expiresAtMs < request.operation.deadlineAtMs &&
					!expiredSettlement) ||
				canonicalHostingEvidence(proof) !==
					canonicalHostingEvidence(
						expected.find((row) => row.resourceName === node.name),
					)
			)
				throw new Error(
					"native destination liability does not match its approved resource, account, artifact and funded lifetime",
				);
			actual.push(structuredClone(proof));
			finalized &&= observed.finalized === true;
		}
		return {
			liabilities: actual.sort((a, b) =>
				a.resourceName.localeCompare(b.resourceName),
			),
			finalized,
		};
	}
	async function mutateResource<T>(
		_request: HostingOperationRequest,
		node: DeploymentPlan["resources"][number],
		bound: Awaited<ReturnType<typeof resource>>,
		action: () => Promise<T>,
	): Promise<T> {
		const appProducts = [
			DIGITALOCEAN_APP_SERVICE_PRODUCT_ID,
			DIGITALOCEAN_APP_STATIC_SITE_PRODUCT_ID,
			DIGITALOCEAN_APP_WORKER_PRODUCT_ID,
			DIGITALOCEAN_APP_JOB_PRODUCT_ID,
		];
		if (!appProducts.includes(node.productId ?? "")) return action();
		const component =
			node.productId === DIGITALOCEAN_APP_WORKER_PRODUCT_ID ||
			node.productId === DIGITALOCEAN_APP_JOB_PRODUCT_ID;
		const parentId = component
			? node.realizationParameters?.appName
			: bound.resolve.ref.logicalId;
		if (!isJsonString(parentId) || !parentId)
			throw new Error(
				"native app mutation requires its exact shared parent name",
			);
		return mutationScope.run(
			{
				providerId: bound.resolver.providerId,
				providerAccountId: bound.binding.providerAccountId,
				parentId,
			},
			action,
		);
	}
	async function observations(
		request: HostingOperationRequest,
		artifactId: string,
		retiringOnly = false,
	) {
		const rows: ResourceLifecycleObservation[] = [];
		for (const node of artifact(artifactId).resources) {
			if (retiringOnly && shared(request, node)) continue;
			const bound = await resource(
				request,
				shared(request, node) ? request.plan.sourcePlanId : artifactId,
				node,
				true,
			);
			const observed = bound.binding.observeLifecycle
				? await bound.binding.observeLifecycle({
						request,
						node,
						artifactId,
						resourceId: bound.resolve.ref.logicalId,
						...(bound.resolve.ref.physicalId
							? { physicalId: bound.resolve.ref.physicalId }
							: undefined),
						nowMs: options.nowMs(),
						transport: bound.transport,
						context: bound.context,
					})
				: await observeResolverLifecycle({
						resolver: bound.resolver,
						request: bound.resolve,
						transport: bound.transport,
						context: bound.context,
						nowMs: options.nowMs,
					});
			const checked = parseResourceLifecycleObservation(observed, {
				...bound.context,
				nowMs: options.nowMs(),
			});
			if (checked.physicalId)
				await recordLocation(
					request,
					bound.identityArtifact,
					node,
					bound.resolve.ref.logicalId,
					checked.physicalId,
					bound.resolver.providerId,
					bound.binding.providerAccountId,
				);
			rows.push(checked);
		}
		return rows;
	}
	async function billingResources(request: HostingOperationRequest) {
		const rows = [];
		const graphs =
			request.plan.intent === "decommission"
				? [request.plan.sourcePlanId]
				: [request.plan.sourcePlanId, request.plan.targetPlanId];
		for (const artifactId of graphs)
			for (const node of artifact(artifactId).resources) {
				const bound = await resource(request, artifactId, node, true);
				if (!bound.resolve.ref.physicalId)
					throw new Error(
						"final billing requires every deployed native physical identity to be independently located",
					);
				rows.push({
					providerId: bound.resolver.providerId,
					providerAccountId: bound.binding.providerAccountId,
					productId: bound.resolve.ref.productId,
					resourceId: bound.resolve.ref.logicalId,
					physicalId: bound.resolve.ref.physicalId,
				});
			}
		return rows;
	}
	function routing(request: HostingOperationRequest) {
		const plans = routes.get(request.plan.deploymentId);
		if (
			!plans ||
			plans.source.intent.tenantId !== request.plan.tenantId ||
			plans.target.intent.tenantId !== request.plan.tenantId
		)
			throw new Error("hosting routing configuration is missing or foreign");
		return plans;
	}
	async function health(
		request: HostingOperationRequest,
		artifactId: string,
		observedRows: readonly ResourceLifecycleObservation[],
	) {
		const probe = probes.get(artifactId);
		if (!probe)
			throw new Error("independent application health probe is required");
		const plans = routing(request),
			plan =
				artifactId === request.plan.sourcePlanId ? plans.source : plans.target;
		const servingRows = observedRows.filter((_row, index) =>
			["compute", "service"].includes(
				artifact(artifactId).resources[index]?.port ?? "",
			),
		);
		const urls = assertHostingServingEndpoints({
			observations: servingRows,
			routing: plan,
			healthUrls: [probe.url, ...(probe.additionalUrls ?? [])],
			allowInsecureLoopback: options.allowInsecureLocalEndpoints === true,
		});
		let healthyBackends = 0,
			latencyMs = 0,
			jurisdiction = "";
		const evidence: string[] = [];
		for (const url of urls) {
			const started = options.nowMs();
			const response = await checkedTransport(
				request,
				probe.transport,
				true,
			)({
				method: "GET",
				url,
				headers: { accept: "application/json" },
				timeoutMs: request.plan.operationTimeoutMs,
				maxResponseBytes: 65_536,
			});
			const body = parseJsonValue(response.body);
			if (
				response.status !== 200 ||
				!isJsonObject(body) ||
				body.healthy !== true ||
				body.tenantId !== request.plan.tenantId ||
				body.artifactDigest !== artifactId ||
				!isJsonNumber(body.healthyBackends) ||
				!Number.isSafeInteger(body.healthyBackends) ||
				body.healthyBackends < 1 ||
				!isJsonString(body.jurisdiction) ||
				!request.plan.constraints?.allowedJurisdictions.includes(
					body.jurisdiction,
				) ||
				body.capabilityDigest !==
					request.plan.constraints?.requiredCapabilityDigest
			)
				throw new Error(
					"application health did not prove scoped native artifact, availability and capability",
				);
			healthyBackends += body.healthyBackends;
			if (!Number.isSafeInteger(healthyBackends))
				throw new Error("healthy native backend count overflows safe integer");
			jurisdiction ||= body.jurisdiction;
			latencyMs = Math.max(latencyMs, Math.max(0, options.nowMs() - started));
			evidence.push(`${url}:${response.body}`);
		}
		return {
			healthyBackends,
			jurisdiction,
			latencyMs,
			evidenceRef: `health:${createHash("sha256")
				.update(JSON.stringify([request.operation.operationId, evidence]))
				.digest("hex")}`,
		};
	}

	return {
		contractId: `hobo.hosting-resolver-execution/v2:${createHash("sha256")
			.update(
				canonicalHostingEvidence({
					identityPolicy: "tenant-deployment-incarnation/v2",
					billingCoverage: "complete-native-resource-set/v1",
					movementPolicy: "stateless-with-pinned-data/v1",
					endpointPolicy: "observed-native-station-health/v1",
					allowInsecureLocalEndpoints:
						options.allowInsecureLocalEndpoints === true,
					artifacts: [...artifacts.keys()].sort(),
					resourceArtifacts: [...resourceArtifacts]
						.map(([id, hashes]) => [id, [...hashes].sort()])
						.sort(),
					resourceIdentities: [...resourceIdentities]
						.map(([id, refs]) => [id, [...refs].sort()])
						.sort(),
					providers: [...providers]
						.map(([id, value]) => [
							id,
							value.providerAccountId,
							value.credentialRef,
						])
						.sort(),
					routes: [...routes]
						.map(([id, value]) => [id, value.source, value.target])
						.sort(),
					health: [...probes]
						.map(([id, value]) => [id, value.url, value.additionalUrls])
						.sort(),
					destructive: [...destructive]
						.map(([id, names]) => [id, [...names].sort()])
						.sort(),
				}),
			)
			.digest("hex")}`,
		requiresDestinationLiabilityProof: true,
		requiresSourceLiabilityProofFor: (plan) => {
			assertStagingIsolation(plan);
			return artifact(plan.sourcePlanId).resources.length > 0;
		},
		executionGuarantee: "idempotent-operation",
		mutationJournal: options.mutationJournal,
		effects: hostingTransitionContracts.mutate.effects,
		resilience: hostingTransitionContracts.mutate.resilience,
		async execute(request) {
			if (request.plan.tenantId !== options.context.tenantId)
				throw new Error("hosting operation belongs to another tenant");
			const action = request.operation.action;
			assertStagingIsolation(request.plan);
			if (
				request.plan.intent !== "decommission" &&
				request.plan.constraints?.movementClass !== "stateless"
			)
				throw new Error(
					"native resolver hosting supports stateless moves with pinned data; moving state requires a workload-owned checkpoint and write-fence adapter",
				);
			// A delayed retirement must not leave the old payer with an unbounded
			// bill either. Existing source proof is immutable approved inventory.
			await operatingLiabilities(request, false, true);
			if (
				request.plan.intent !== "decommission" &&
				[Action.PREPARE, Action.SHIFT, Action.RETIRE].includes(action)
			)
				await operatingLiabilities(request);
			if (action === Action.PREPARE) {
				// Validate the complete target before the first billable effect. A
				// later unsupported resource must not leave a partially created plan.
				const plan = artifact(request.plan.targetPlanId);
				for (const name of plan.dependencyOrder) {
					const node = plan.resources.find((row) => row.name === name);
					if (!node)
						throw new Error(
							"hosting artifact dependency order names an unknown resource",
						);
					if (shared(request, node)) continue;
					const bound = await resource(
						request,
						request.plan.targetPlanId,
						node,
					);
					await verifyMutation(
						request,
						bound.binding,
						bound.resolver.providerId,
					);
					const outcome = parseResolveOutcome(
						cloneAsJson(
							await mutateResource(request, node, bound, () =>
								bound.resolver.reconcile(bound.resolve, bound.transport),
							),
						),
					);
					await recordLocation(
						request,
						request.plan.targetPlanId,
						node,
						bound.resolve.ref.logicalId,
						outcome.physicalId,
						bound.resolver.providerId,
						bound.binding.providerAccountId,
					);
				}
			} else if (action === Action.SHIFT || action === Action.RESTORE) {
				const plans = routing(request),
					plan = action === Action.SHIFT ? plans.target : plans.source;
				const servingArtifact =
					action === Action.SHIFT
						? request.plan.targetPlanId
						: request.plan.sourcePlanId;
				await health(
					request,
					servingArtifact,
					await observations(request, servingArtifact),
				);
				fundedPayer(request, plans.providerAccountId);
				await plans.verifyCredentialScope({
					tenantId: request.plan.tenantId,
					providerId: plans.port.provider,
					providerAccountId: plans.providerAccountId,
					credentialRef: plans.credentialRef,
					operationId: request.operation.operationId,
					nowMs: options.nowMs(),
				});
				if (
					request.signal.aborted ||
					options.nowMs() >= request.operation.deadlineAtMs
				)
					throw new Error("hosting operation expired before routing I/O");
				const result = await plans.port.apply(plan);
				if (
					result.planId !== plan.planId ||
					result.provider !== plans.port.provider ||
					result.realized !== "full"
				)
					throw new Error(
						"routing adapter did not realize the exact approved plan",
					);
				if (action === Action.RESTORE) {
					// Cleanup only follows positive source routing and business health.
					const status = await plans.port.status(plan.planId);
					if (
						status?.planId !== plan.planId ||
						!status.active ||
						status.realized !== "full"
					)
						throw new Error("source routing restoration remains unconfirmed");
					await health(
						request,
						request.plan.sourcePlanId,
						await observations(request, request.plan.sourcePlanId),
					);
					const target = artifact(request.plan.targetPlanId);
					for (const name of [...target.dependencyOrder].reverse()) {
						const node = target.resources.find((row) => row.name === name);
						if (!node) throw new Error("unknown target cleanup resource");
						if (shared(request, node)) continue;
						destructionAllowed(request, node);
						const bound = await resource(
							request,
							request.plan.targetPlanId,
							node,
						);
						await verifyMutation(
							request,
							bound.binding,
							bound.resolver.providerId,
						);
						await mutateResource(request, node, bound, () =>
							bound.resolver.delete(bound.resolve, bound.transport),
						);
					}
				}
			} else if (action === Action.RETIRE) {
				const source = artifact(request.plan.sourcePlanId);
				for (const name of [...source.dependencyOrder].reverse()) {
					const node = source.resources.find((row) => row.name === name);
					if (!node) throw new Error("unknown source retirement resource");
					if (shared(request, node)) continue;
					destructionAllowed(request, node);
					const bound = await resource(
						request,
						request.plan.sourcePlanId,
						node,
					);
					await verifyMutation(
						request,
						bound.binding,
						bound.resolver.providerId,
					);
					await mutateResource(request, node, bound, () =>
						bound.resolver.delete(bound.resolve, bound.transport),
					);
				}
			} else
				throw new Error(
					"hosting observation actions cannot mutate provider state",
				);
		},
		async observe(request) {
			if (request.plan.tenantId !== options.context.tenantId)
				throw new Error("hosting observation belongs to another tenant");
			const constraints = request.plan.constraints;
			if (!constraints)
				throw new Error("approved hosting constraints are required");
			const history = [];
			for await (const event of options.store.read(
				hostingTransitionStream(
					request.plan.tenantId,
					request.plan.transitionId,
				),
			))
				history.push(event);
			const current = foldHostingTransition(history);
			const action = request.operation.action,
				restoring =
					action === Action.RESTORE ||
					(action === Action.SETTLE && current?.restorationConfirmed === true);
			const decommission = request.plan.intent === "decommission";
			const liability =
				decommission || restoring
					? { liabilities: [], finalized: true }
					: await operatingLiabilities(request, true);
			const servingArtifact = restoring
				? request.plan.sourcePlanId
				: request.plan.targetPlanId;
			const rows = decommission
				? []
				: await observations(request, servingArtifact);
			let ready = rows.every(
				(row) => row.status === "ready" && row.operationTerminal,
			);
			const expiredDestination =
				liability.liabilities.length > 0 &&
				liability.liabilities.every(
					(proof) =>
						proof.expiresAtMs > 0 && proof.expiresAtMs <= options.nowMs(),
				);
			let sourceRetired = false,
				targetRetired =
					!restoring &&
					!decommission &&
					expiredDestination &&
					liability.finalized &&
					rows.every((row) => row.status === "absent" && row.operationTerminal),
				usageFinal = false,
				settledMicros = 0;
			const billingEvidence: string[] = [];
			if (action !== Action.PREPARE && !decommission && !targetRetired) {
				const plans = routing(request),
					plan = restoring ? plans.source : plans.target;
				const status = await plans.port.status(plan.planId);
				ready &&=
					status?.planId === plan.planId &&
					status.active &&
					status.realized === "full";
			}
			if (action === Action.RETIRE || (action === Action.SETTLE && !restoring))
				sourceRetired = (
					await observations(request, request.plan.sourcePlanId, true)
				).every((row) => row.status === "absent" && row.operationTerminal);
			if (restoring)
				targetRetired = (
					await observations(request, request.plan.targetPlanId, true)
				).every((row) => row.status === "absent" && row.operationTerminal);
			if (action === Action.SETTLE || restoring) {
				const records = await options.billing.observe(request);
				const payers = new Set(
					request.plan.commitment?.allocations.flatMap((allocation) =>
						allocation.providerCharges.map(
							(charge) => charge.providerAccountId,
						),
					) ?? [],
				);
				const billing = aggregateHostingBillingObservations({
					tenantId: request.plan.tenantId,
					operationId: request.operation.operationId,
					providerAccountIds: payers,
					records,
					requiredResources: await billingResources(request),
					nowMs: options.nowMs(),
					maxAgeMs: request.plan.constraints?.observationMaxAgeMs ?? 0,
				});
				usageFinal = billing.usageFinal;
				settledMicros = billing.settledMicros;
				billingEvidence.push(...billing.evidenceRefs);
			}
			const observed =
				decommission || targetRetired
					? {
							healthyBackends: 0,
							jurisdiction: "",
							latencyMs: 0,
							evidenceRef: "decommission:no-active-service",
						}
					: !ready
						? {
								healthyBackends: 0,
								jurisdiction: "",
								latencyMs: 0,
								evidenceRef: "native-resource-pending",
							}
						: await health(request, servingArtifact, rows);
			if (decommission) ready = sourceRetired;
			const evidenceRef = `sha256:${createHash("sha256")
				.update(
					JSON.stringify({
						operation: request.operation.operationId,
						resources: rows.map((row) => row.evidenceRef),
						health: observed.evidenceRef,
						billing: billingEvidence,
					}),
				)
				.digest("hex")}`;
			return {
				tenantId: request.plan.tenantId,
				transitionId: request.plan.transitionId,
				operationId: request.operation.operationId,
				operationDigest: request.operation.operationDigest,
				sourcePlanId: request.plan.sourcePlanId,
				targetPlanId: request.plan.targetPlanId,
				observedAtMs: options.nowMs(),
				outcome: ready ? "applied" : "pending",
				ready,
				evidenceRef,
				healthyBackends: observed.healthyBackends,
				jurisdiction: observed.jurisdiction,
				latencyMs: observed.latencyMs,
				capabilityDigest: decommission
					? ""
					: constraints.requiredCapabilityDigest,
				sourceRetired,
				targetRetired,
				usageFinal,
				settledMicros,
				destinationLiabilities: liability.liabilities,
				destinationLiabilityFinalized: liability.finalized,
			};
		},
	};
}
