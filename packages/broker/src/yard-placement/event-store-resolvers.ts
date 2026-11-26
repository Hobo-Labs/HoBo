/**
 * Provider-owned resolvers for the Yard event-store fold slot.
 *
 * Each cloud/local provider registers a fold resolver that:
 *  1. Normalizes provider-native control-plane signals → yard.* events
 *  2. Optionally enriches fold state with provider-scoped projections
 *  3. Declares a PrimitiveResolverDescriptor on slot "event-store"
 *
 * The core fold (`foldYardEventStore`) remains provider-neutral; provider
 * resolvers wrap it after normalization.
 */
import {
	isJsonNumber,
	isJsonObject,
	isJsonString,
	type JsonValue,
} from "../json.js";
import { YARD_EVENTS, type YardEvent, yardEvent } from "./events.js";
import {
	emptyYardEventStoreState,
	foldYardEventStore,
	type YardEventStoreState,
} from "./folds.js";
import type {
	PrimitiveResolverDescriptor,
	YardInstanceRegistration,
} from "./types.js";
import { contentHashOf, YARD_INSTANCE_SCHEMA } from "./types.js";

export const EVENT_STORE_SLOT = "event-store" as const;

export interface ProviderNativeSignal {
	readonly providerId: string;
	readonly kind: string;
	readonly payload: Readonly<Record<string, JsonValue>>;
	readonly observedAt?: string;
}

/**
 * Provider fold resolver: deterministic lowering of provider signals + fold.
 */
export interface YardEventStoreFoldResolver {
	readonly descriptor: PrimitiveResolverDescriptor;
	readonly providerId: string;
	/**
	 * Map provider-native control-plane signals into yard.* facts.
	 * Must not emit credentials.
	 */
	normalize(signal: ProviderNativeSignal): readonly YardEvent[];
	/** Initial empty projection for this provider scope. */
	initialState(brokerId: string): YardEventStoreState;
	/**
	 * Fold a yard.* (or already-normalized) event. Default: core fold.
	 * Providers may wrap to attach provider-scoped annotations only.
	 */
	fold(state: YardEventStoreState, event: YardEvent): YardEventStoreState;
	/**
	 * Apply a batch: normalize provider signals then fold all yard events.
	 */
	foldAll(
		brokerId: string,
		inputs: readonly (YardEvent | ProviderNativeSignal)[],
	): YardEventStoreState;
}

export function isProviderNativeSignal(value: JsonValue | undefined): boolean {
	if (!isJsonObject(value)) return false;
	return (
		isJsonString(value.providerId) &&
		isJsonString(value.kind) &&
		(isJsonObject(value.payload) || Array.isArray(value.payload))
	);
}

function asProviderNativeSignal(
	value: YardEvent | ProviderNativeSignal,
): ProviderNativeSignal | undefined {
	if (!isJsonObject(value)) return undefined;
	if (
		!isJsonString(value.providerId) ||
		!isJsonString(value.kind) ||
		!(isJsonObject(value.payload) || Array.isArray(value.payload))
	) {
		return undefined;
	}
	const payload = isJsonObject(value.payload) ? value.payload : {};
	return {
		providerId: value.providerId,
		kind: value.kind,
		payload,
		...(isJsonString(value.observedAt)
			? { observedAt: value.observedAt }
			: undefined),
	};
}

/**
 * Shared base for provider fold resolvers. Subclasses override normalize().
 */
export function createYardEventStoreFoldResolver(options: {
	readonly providerId: string;
	readonly resolverId: string;
	readonly version?: string;
	readonly normalize?: (signal: ProviderNativeSignal) => readonly YardEvent[];
	readonly afterFold?: (
		state: YardEventStoreState,
		event: YardEvent,
	) => YardEventStoreState;
}): YardEventStoreFoldResolver {
	const providerId = options.providerId;
	const descriptor: PrimitiveResolverDescriptor = Object.freeze({
		schemaVersion: "hobo.primitive-resolver/v1",
		id: options.resolverId,
		version: options.version ?? "1",
		providerId,
		primitiveKind: "yard",
		slot: EVENT_STORE_SLOT,
		additive: false,
		source: "provider-default",
		default: true,
		priority: 200,
		requiresCapabilities: Object.freeze(["event-store"]),
		providesCapabilities: Object.freeze([
			"event-store",
			"yard-inventory-fold",
			"yard-generation-fold",
		]),
		implementationRef: `${providerId}/resolvers/event-store-fold`,
		remediation: `Register ${options.resolverId} for yard event-store folds on provider ${providerId}`,
	});

	const normalize =
		options.normalize ??
		((signal: ProviderNativeSignal) => defaultNormalize(signal));

	const fold = (
		state: YardEventStoreState,
		event: YardEvent,
	): YardEventStoreState => {
		const next = foldYardEventStore(state, event);
		return options.afterFold ? options.afterFold(next, event) : next;
	};

	return Object.freeze({
		descriptor,
		providerId,
		normalize,
		initialState: emptyYardEventStoreState,
		fold,
		foldAll(
			brokerId: string,
			inputs: readonly (YardEvent | ProviderNativeSignal)[],
		): YardEventStoreState {
			let state = emptyYardEventStoreState(brokerId);
			let seq = 0;
			for (const input of inputs) {
				const signal = asProviderNativeSignal(input);
				const events =
					signal !== undefined
						? normalize(signal)
						: [
								{
									type:
										"type" in input && isJsonString(input.type)
											? input.type
											: "",
									data:
										"data" in input && isJsonObject(input.data)
											? input.data
											: {},
									...("seq" in input && isJsonNumber(input.seq)
										? { seq: input.seq }
										: undefined),
								},
							];
				for (const event of events) {
					seq += 1;
					state = fold(state, {
						...event,
						seq: event.seq ?? seq,
					});
				}
			}
			return state;
		},
	});
}

/**
 * Default signal mapping used when a provider does not specialize.
 */
export function defaultNormalize(
	signal: ProviderNativeSignal,
): readonly YardEvent[] {
	const at = signal.observedAt ?? new Date().toISOString();
	const p = signal.payload;
	switch (signal.kind) {
		case "yard.registered":
		case "controlPlane.registered":
			return [
				yardEvent(
					YARD_EVENTS.Registered,
					{
						yard: payloadToYardInstance(signal.providerId, p),
					},
					{ occurredAt: at },
				),
			];
		case "yard.ready":
		case "controlPlane.ready":
			return [
				yardEvent(
					YARD_EVENTS.Ready,
					{
						yardId: String(p.yardId ?? p.id ?? ""),
						...(p.attemptId ? { attemptId: String(p.attemptId) } : undefined),
					},
					{ occurredAt: at },
				),
			];
		case "yard.attesting":
			return [
				yardEvent(
					YARD_EVENTS.AttestationStarted,
					{ yardId: String(p.yardId ?? p.id ?? "") },
					{ occurredAt: at },
				),
			];
		case "yard.attested":
			return [
				yardEvent(
					YARD_EVENTS.Attested,
					{ yardId: String(p.yardId ?? p.id ?? "") },
					{ occurredAt: at },
				),
			];
		case "generation.started":
			return [
				yardEvent(
					YARD_EVENTS.GenerationStarted,
					{
						attemptId: String(p.attemptId ?? ""),
						idempotencyKey: String(p.idempotencyKey ?? ""),
						providerId: signal.providerId,
						runtimeId: String(p.runtimeId ?? ""),
						expectedYardId: String(p.expectedYardId ?? ""),
					},
					{ occurredAt: at },
				),
			];
		case "generation.provisioned":
			return [
				yardEvent(
					YARD_EVENTS.GenerationProvisioned,
					{
						attemptId: String(p.attemptId ?? ""),
						idempotencyKey: String(p.idempotencyKey ?? ""),
						providerId: signal.providerId,
						yardId: String(p.yardId ?? ""),
						// SAFETY: assertion required at this I/O or test boundary.
						externalRefs: (p.externalRefs as Record<string, string>) ?? {},
					},
					{ occurredAt: at },
				),
			];
		case "generation.failed":
			return [
				yardEvent(
					YARD_EVENTS.GenerationFailed,
					{
						attemptId: String(p.attemptId ?? ""),
						idempotencyKey: String(p.idempotencyKey ?? ""),
						providerId: signal.providerId,
						failure: {
							code: String(p.code ?? "generation-failed"),
							message: String(p.message ?? "failed"),
							retryable: p.retryable === true,
						},
					},
					{ occurredAt: at },
				),
			];
		default:
			return [
				yardEvent(
					YARD_EVENTS.ProviderSignalNormalized,
					{
						providerId: signal.providerId,
						kind: signal.kind,
						payload: p,
					},
					{ occurredAt: at },
				),
			];
	}
}

function payloadToYardInstance(
	providerId: string,
	p: Readonly<Record<string, JsonValue>>,
): YardInstanceRegistration {
	const yardId = String(p.yardId ?? p.id ?? `yard:${providerId}`);
	const now = new Date().toISOString();
	return Object.freeze({
		schemaVersion: YARD_INSTANCE_SCHEMA,
		yardId,
		ownerTenantId: String(p.ownerTenantId ?? "local"),
		providerId,
		runtimeId: String(p.runtimeId ?? `${providerId}-runtime`),
		layout: Object.freeze({
			providerId,
			regions: Object.freeze(
				Array.isArray(p.regions) ? p.regions.map(String) : ["local"],
			),
			require: Object.freeze([]),
			prefer: Object.freeze([]),
			residency: Object.freeze(
				Array.isArray(p.residency) ? p.residency.map(String) : [],
			),
			isolation: Object.freeze([]),
			network: Object.freeze([]),
			componentHosts: Object.freeze(
				Array.isArray(p.componentHosts) ? p.componentHosts.map(String) : [],
			),
			labels: Object.freeze({}),
			properties: Object.freeze(isJsonObject(p.properties) ? p.properties : {}),
			camps: Object.freeze([]),
		}),
		capabilities: Object.freeze(
			Array.isArray(p.capabilities)
				? p.capabilities.map(String)
				: ["managed-http-runtime"],
		),
		status: "registering",
		health: Object.freeze({
			observedAt: now,
			generation: 1,
			signals: Object.freeze(["registered"]),
		}),
		capacity: Object.freeze({
			classes: Object.freeze({ default: 1000 }),
			reservations: Object.freeze({}),
		}),
		// SAFETY: assertion required at this I/O or test boundary.
		registryCatalogHash: contentHashOf(
			`${providerId}-registry`,
		) as `sha256:${string}`,
		// SAFETY: assertion required at this I/O or test boundary.
		resolverCatalogHash: contentHashOf(
			`${providerId}-resolvers`,
		) as `sha256:${string}`,
		// SAFETY: assertion required at this I/O or test boundary.
		conformanceHash: contentHashOf(
			`${providerId}-conformance`,
		) as `sha256:${string}`,
		labels: Object.freeze({}),
		registrationSeq: 1,
	});
}

/**
 * Registry of fold resolvers keyed by providerId.
 * Selection uses the selected Yard's provider — never Bindle pins.
 */
export interface EventStoreFoldResolverRegistry {
	readonly get: (providerId: string) => YardEventStoreFoldResolver | undefined;
	readonly all: () => readonly YardEventStoreFoldResolver[];
	readonly descriptors: () => readonly PrimitiveResolverDescriptor[];
}

export function createEventStoreFoldResolverRegistry(
	resolvers: readonly YardEventStoreFoldResolver[],
): EventStoreFoldResolverRegistry {
	const map = new Map<string, YardEventStoreFoldResolver>();
	for (const r of resolvers) {
		map.set(r.providerId, r);
	}
	return {
		get: (providerId) => map.get(providerId),
		all: () => Object.freeze([...map.values()]),
		descriptors: () => Object.freeze(resolvers.map((r) => r.descriptor)),
	};
}

/** Built-in local provider fold resolver (zero-config path). */
export function createLocalYardEventStoreFoldResolver(
	providerId = "local",
): YardEventStoreFoldResolver {
	return createYardEventStoreFoldResolver({
		providerId,
		resolverId: `${providerId}.yard.event-store/v1`,
		normalize(signal) {
			// Local accepts component-host ready signals.
			if (signal.kind === "componentHost.ready") {
				const yardId = String(signal.payload.yardId ?? "yard:local");
				return [
					yardEvent(YARD_EVENTS.Registered, {
						yard: payloadToYardInstance(providerId, {
							...signal.payload,
							yardId,
							componentHosts: signal.payload.componentHosts ?? [
								"local",
								"wasm",
								"oci",
							],
						}),
					}),
					yardEvent(YARD_EVENTS.Ready, { yardId }),
				];
			}
			return defaultNormalize(signal);
		},
	});
}

/** Azure ARM / ACA control-plane fold resolver. */
export function createAzureYardEventStoreFoldResolver(): YardEventStoreFoldResolver {
	return createYardEventStoreFoldResolver({
		providerId: "azure",
		resolverId: "azure.yard.event-store/v1",
		normalize(signal) {
			const p = signal.payload;
			const at = signal.observedAt;
			switch (signal.kind) {
				case "resourceGroup.created":
				case "Microsoft.Resources/resourceGroups/write":
					return [
						yardEvent(
							YARD_EVENTS.GenerationProgressed,
							{
								attemptId: String(p.attemptId ?? ""),
								idempotencyKey: String(p.idempotencyKey ?? ""),
								providerId: "azure",
								status: "started",
								externalRefs: {
									resourceGroup: String(p.resourceGroup ?? p.name ?? ""),
									subscriptionRef: String(p.subscriptionRef ?? ""),
								},
							},
							at ? { occurredAt: at } : undefined,
						),
					];
				case "managedEnvironment.created":
				case "Microsoft.App/managedEnvironments/write":
					return [
						yardEvent(
							YARD_EVENTS.GenerationProvisioned,
							{
								attemptId: String(p.attemptId ?? ""),
								idempotencyKey: String(p.idempotencyKey ?? ""),
								providerId: "azure",
								yardId: String(p.yardId ?? p.environmentId ?? ""),
								externalRefs: {
									managedEnvironmentId: String(
										p.managedEnvironmentId ?? p.id ?? "",
									),
								},
							},
							at ? { occurredAt: at } : undefined,
						),
					];
				case "managedEnvironment.ready": {
					const yardId = String(p.yardId ?? p.id ?? "yard:azure");
					return [
						yardEvent(YARD_EVENTS.Registered, {
							yard: payloadToYardInstance("azure", { ...p, yardId }),
						}),
						yardEvent(YARD_EVENTS.AttestationStarted, { yardId }),
						yardEvent(YARD_EVENTS.Attested, { yardId }),
						yardEvent(YARD_EVENTS.Ready, {
							yardId,
							attemptId: String(p.attemptId ?? ""),
						}),
					];
				}
				default:
					return defaultNormalize(signal);
			}
		},
	});
}

/** AWS ECS/VPC fold resolver. */
export function createAwsYardEventStoreFoldResolver(): YardEventStoreFoldResolver {
	return createYardEventStoreFoldResolver({
		providerId: "aws",
		resolverId: "aws.yard.event-store/v1",
		normalize(signal) {
			const p = signal.payload;
			switch (signal.kind) {
				case "vpc.created":
				case "ec2:CreateVpc":
					return [
						yardEvent(YARD_EVENTS.GenerationProgressed, {
							attemptId: String(p.attemptId ?? ""),
							idempotencyKey: String(p.idempotencyKey ?? ""),
							providerId: "aws",
							status: "started",
							externalRefs: { vpcId: String(p.vpcId ?? p.id ?? "") },
						}),
					];
				case "ecs.cluster.created":
				case "ecs:CreateCluster":
					return [
						yardEvent(YARD_EVENTS.GenerationProvisioned, {
							attemptId: String(p.attemptId ?? ""),
							idempotencyKey: String(p.idempotencyKey ?? ""),
							providerId: "aws",
							yardId: String(p.yardId ?? p.clusterArn ?? ""),
							externalRefs: {
								clusterArn: String(p.clusterArn ?? p.id ?? ""),
							},
						}),
					];
				case "ecs.cluster.ready": {
					const yardId = String(p.yardId ?? p.clusterArn ?? "yard:aws");
					return [
						yardEvent(YARD_EVENTS.Registered, {
							yard: payloadToYardInstance("aws", { ...p, yardId }),
						}),
						yardEvent(YARD_EVENTS.AttestationStarted, { yardId }),
						yardEvent(YARD_EVENTS.Attested, { yardId }),
						yardEvent(YARD_EVENTS.Ready, {
							yardId,
							attemptId: String(p.attemptId ?? ""),
						}),
					];
				}
				default:
					return defaultNormalize(signal);
			}
		},
	});
}

/** GCP Cloud Run / VPC fold resolver. */
export function createGcpYardEventStoreFoldResolver(): YardEventStoreFoldResolver {
	return createYardEventStoreFoldResolver({
		providerId: "gcp",
		resolverId: "gcp.yard.event-store/v1",
		normalize(signal) {
			const p = signal.payload;
			switch (signal.kind) {
				case "network.created":
				case "compute.networks.create":
					return [
						yardEvent(YARD_EVENTS.GenerationProgressed, {
							attemptId: String(p.attemptId ?? ""),
							idempotencyKey: String(p.idempotencyKey ?? ""),
							providerId: "gcp",
							status: "started",
							externalRefs: { network: String(p.network ?? p.name ?? "") },
						}),
					];
				case "cloudRun.service.created":
				case "run.services.create":
					return [
						yardEvent(YARD_EVENTS.GenerationProvisioned, {
							attemptId: String(p.attemptId ?? ""),
							idempotencyKey: String(p.idempotencyKey ?? ""),
							providerId: "gcp",
							yardId: String(p.yardId ?? p.serviceName ?? ""),
							externalRefs: {
								serviceName: String(p.serviceName ?? p.id ?? ""),
							},
						}),
					];
				case "cloudRun.ready": {
					const yardId = String(p.yardId ?? p.serviceName ?? "yard:gcp");
					return [
						yardEvent(YARD_EVENTS.Registered, {
							yard: payloadToYardInstance("gcp", { ...p, yardId }),
						}),
						yardEvent(YARD_EVENTS.AttestationStarted, { yardId }),
						yardEvent(YARD_EVENTS.Attested, { yardId }),
						yardEvent(YARD_EVENTS.Ready, {
							yardId,
							attemptId: String(p.attemptId ?? ""),
						}),
					];
				}
				default:
					return defaultNormalize(signal);
			}
		},
	});
}

/** All built-in provider event-store fold resolvers. */
export function createDefaultEventStoreFoldResolvers(): readonly YardEventStoreFoldResolver[] {
	return Object.freeze([
		createLocalYardEventStoreFoldResolver("local"),
		createLocalYardEventStoreFoldResolver("@hobo/provider-local-host"),
		createAzureYardEventStoreFoldResolver(),
		createAwsYardEventStoreFoldResolver(),
		createGcpYardEventStoreFoldResolver(),
	]);
}
