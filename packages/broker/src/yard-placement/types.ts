import { createHash } from "node:crypto";
import type {
	BudgetReservation,
	HostingPolicyProof,
	HostingQuote,
} from "../budget-authority.js";
import {
	cloneAsJson,
	isJsonBoolean,
	isJsonNumber,
	isJsonObject,
	isJsonString,
	type JsonObject,
	type JsonValue,
} from "../json.js";

/** Schema versions for yard-first placement records. */
// public-contract: yard instance registration schema id.
export const YARD_INSTANCE_SCHEMA = "hobo.yard-instance/v1" as const;
// public-contract: yard inventory snapshot schema id.
export const YARD_INVENTORY_SCHEMA = "hobo.yard-inventory/v1" as const;
// public-contract: yard runtime registration schema id.
export const YARD_RUNTIME_SCHEMA = "hobo.yard-runtime/v1" as const;
// public-contract: yard runtime catalog schema id.
export const YARD_RUNTIME_CATALOG_SCHEMA =
	"hobo.yard-runtime-catalog/v1" as const;
// public-contract: yard generation plan schema id.
export const YARD_GENERATION_PLAN_SCHEMA =
	"hobo.yard-generation-plan/v1" as const;
// public-contract: bindle deployment request schema id.
export const BINDLE_DEPLOYMENT_REQUEST_SCHEMA =
	"hobo.bindle-deployment-request/v1" as const;
// public-contract: yard placement receipt schema id.
export const YARD_PLACEMENT_RECEIPT_SCHEMA =
	"hobo.yard-placement-receipt/v1" as const;

export type ContentHash = `sha256:${string}`;

export type YardSelectionMode =
	| "exact"
	| "compatible"
	| "compatible-or-generate";

export type { JsonObject, JsonValue } from "../json.js";

export interface CampLayout {
	readonly id?: string;
	readonly env?: string;
	readonly envType?: string;
	readonly require: readonly string[];
	readonly prefer: readonly string[];
	readonly labels: Readonly<Record<string, string>>;
	readonly runtimeRequirements: readonly string[];
}

/**
 * Planning record comparing requested Yard to live instances / runtimes.
 * Not a topology primitive.
 */
// domain-view: planning/placement domain type (wire form in broker.proto when present).
export interface YardLayout {
	readonly providerId?: string;
	readonly runtimeId?: string;
	readonly regions: readonly string[];
	readonly require: readonly string[];
	readonly prefer: readonly string[];
	readonly residency: readonly string[];
	readonly isolation: readonly string[];
	readonly network: readonly string[];
	readonly componentHosts: readonly string[];
	readonly labels: Readonly<Record<string, string>>;
	readonly properties: Readonly<Record<string, JsonValue>>;
	readonly camps: readonly CampLayout[];
}

// domain-view: planning/placement domain type (wire form in broker.proto when present).
export interface YardPlacementRequest {
	readonly requestId: string;
	readonly selectionMode: YardSelectionMode;
	readonly requestedYardId?: string;
	readonly requestedLayout: YardLayout;
	readonly bindleManifestHash: ContentHash;
	readonly bindleRequirementsHash: ContentHash;
	/** Request only — never authorizes generation. Broker policy is authoritative. */
	readonly allowGenerationRequested: boolean;
}

export type YardInstanceStatus =
	| "registering"
	| "attesting"
	| "ready"
	| "degraded"
	| "draining"
	| "offline";

// domain-view: planning/placement domain type (wire form in broker.proto when present).
export interface YardInstanceRegistration {
	readonly schemaVersion: typeof YARD_INSTANCE_SCHEMA;
	readonly yardId: string;
	readonly ownerTenantId: string;
	readonly providerId: string;
	readonly runtimeId: string;
	readonly layout: YardLayout;
	readonly capabilities: readonly string[];
	readonly status: YardInstanceStatus;
	readonly health: {
		readonly observedAt: string;
		readonly generation: number;
		readonly signals: readonly string[];
	};
	readonly capacity: {
		readonly classes: Readonly<Record<string, number>>;
		readonly reservations: Readonly<Record<string, number>>;
	};
	readonly registryCatalogHash: ContentHash;
	readonly resolverCatalogHash: ContentHash;
	readonly conformanceHash: ContentHash;
	readonly labels: Readonly<Record<string, string>>;
	readonly registrationSeq: number;
}

// domain-view: planning/placement domain type (wire form in broker.proto when present).
export interface YardInventorySnapshot {
	readonly schemaVersion: typeof YARD_INVENTORY_SCHEMA;
	readonly brokerId: string;
	readonly seq: number;
	readonly yards: readonly YardInstanceRegistration[];
	readonly contentHash: ContentHash;
}

/**
 * Broker-approved runtime template capable of hosting/generating a Yard.
 * Not an app runtime backend and not a live Yard instance.
 */
// domain-view: planning/placement domain type (wire form in broker.proto when present).
export interface YardRuntimeRegistration {
	readonly schemaVersion: typeof YARD_RUNTIME_SCHEMA;
	readonly runtimeId: string;
	readonly providerId: string;
	readonly version: string;
	readonly supportedLayout: {
		readonly regions: readonly string[];
		readonly capabilities: readonly string[];
		readonly requireProperties: readonly string[];
	};
	readonly resolverCatalogHash: ContentHash;
	readonly generatorConnectorId?: string;
	readonly generatorKind?: string;
	readonly default: boolean;
	readonly priority: number;
	readonly requiredPermissions: readonly string[];
	readonly conformanceRef: string;
	readonly conformanceHash: ContentHash;
	readonly status: "registered" | "approved" | "disabled";
}

export interface YardRuntimeCatalogSnapshot {
	readonly schemaVersion: typeof YARD_RUNTIME_CATALOG_SCHEMA;
	readonly seq: number;
	readonly runtimes: readonly YardRuntimeRegistration[];
	readonly contentHash: ContentHash;
}

export interface YardMatchSpecificity {
	readonly exactId: 0 | 1;
	readonly provider: 0 | 1;
	readonly runtime: 0 | 1;
	readonly exactLabels: number;
	readonly exactProperties: number;
	readonly hardCapabilities: number;
}

export interface YardCandidateDecision {
	readonly yardId: string;
	readonly compatible: boolean;
	readonly hardFailures: readonly string[];
	readonly specificity: YardMatchSpecificity;
	readonly rankInputs: Readonly<Record<string, number | string>>;
}

export interface YardMatchDecision {
	readonly requestedYardId?: string;
	readonly selectionMode: YardSelectionMode;
	readonly requestedLayoutHash: ContentHash;
	readonly inventoryHash: ContentHash;
	readonly winnerYardId?: string;
	readonly candidates: readonly YardCandidateDecision[];
	readonly contributingPolicyIds: readonly string[];
	readonly outcome: "existing-yard" | "generation-required" | "rejected";
	readonly rationale: string;
}

export interface YardGenerationPolicy {
	readonly id: string;
	readonly effect: "deny" | "allow-if-no-match" | "require-dedicated";
	readonly allowedRuntimeIds: readonly string[];
	readonly deniedRuntimeIds: readonly string[];
	readonly allowedProviderIds: readonly string[];
	readonly deniedProviderIds: readonly string[];
	readonly allowedConnectorIds: readonly string[];
	readonly maxConcurrentGenerations: number;
	readonly maxYardsPerTenant: number;
	readonly requireApproval: boolean;
	readonly requireAttestation: boolean;
	readonly lockedProperties: readonly string[];
}

export interface YardGenerationPlan {
	readonly schemaVersion: typeof YARD_GENERATION_PLAN_SCHEMA;
	readonly attemptId: string;
	readonly idempotencyKey: ContentHash;
	readonly requestedLayout: YardLayout;
	readonly requestedLayoutHash: ContentHash;
	readonly runtimeId: string;
	readonly providerId: string;
	readonly generatorConnectorId: string;
	readonly expectedYardId: string;
	readonly requiredPermissions: readonly string[];
	readonly credentialScopeRef: string;
	readonly inputs: Readonly<Record<string, JsonValue>>;
	readonly planHash: ContentHash;
}

export interface YardGenerationResult {
	readonly attemptId: string;
	readonly status:
		| "started"
		| "provisioned"
		| "registered"
		| "ready"
		| "failed";
	readonly yardId?: string;
	readonly externalRefs: Readonly<Record<string, string>>;
	readonly outputHash: ContentHash;
	readonly failure?: {
		readonly code: string;
		readonly message: string;
		readonly retryable: boolean;
	};
}

export interface CampPlacementRequest {
	readonly selectionMode: YardSelectionMode;
	readonly campId?: string;
	readonly layout: CampLayout;
}

export interface BindleRequirementsView {
	readonly require: readonly string[];
	readonly prefer: readonly string[];
	readonly runtimes: readonly string[];
	readonly labels: Readonly<Record<string, string>>;
}

// domain-view: planning/placement domain type (wire form in broker.proto when present).
export interface BindleDeploymentRequest {
	readonly schemaVersion: typeof BINDLE_DEPLOYMENT_REQUEST_SCHEMA;
	readonly requestId: string;
	readonly bindleName: string;
	readonly manifestHash: ContentHash;
	readonly bindleRequirements: BindleRequirementsView;
	readonly yard: YardPlacementRequest;
	readonly camp?: CampPlacementRequest;
	readonly objective: string;
	readonly spendEstimateUsd: number;
	readonly ownerTenantId: string;
	/** Resource requirements for residual placement under selected Yard provider. */
	readonly resources: readonly {
		readonly resourceId: string;
		readonly port: string;
		readonly features: readonly string[];
		readonly region?: string;
	}[];
}

export interface ScopeSelector {
	readonly kind: "bindle" | "camp" | "yard" | "junction";
	readonly id?: string;
	readonly labels: Readonly<Record<string, string>>;
	readonly providerId?: string;
	readonly envType?: string;
	readonly tenantId?: string;
}

export interface ResolverPin {
	readonly slot: string;
	readonly resolverId: string;
}

export interface PrimitiveResolverConfig {
	readonly require: readonly string[];
	readonly prefer: readonly string[];
	readonly pins: readonly ResolverPin[];
	readonly properties: Readonly<Record<string, JsonValue>>;
	readonly labels: Readonly<Record<string, string>>;
}

export interface PrimitiveResolverDescriptor {
	readonly schemaVersion: "hobo.primitive-resolver/v1";
	readonly id: string;
	readonly version: string;
	readonly providerId?: string;
	readonly primitiveKind: "bindle" | "camp" | "yard" | "junction";
	readonly slot: string;
	readonly additive: boolean;
	readonly source:
		| "provider-default"
		| "yard-runtime-default"
		| "platform-defined";
	readonly default: boolean;
	readonly priority: number;
	readonly requiresCapabilities: readonly string[];
	readonly providesCapabilities: readonly string[];
	readonly implementationRef: string;
	readonly remediation: string;
}

export interface ExecutionUnit {
	readonly unitId: string;
	readonly kind: "yard" | "camp" | "bindle" | "resource" | "shared";
	readonly providerId: string;
	readonly yardId: string;
	readonly destroyWithBindle: boolean;
	readonly claims: readonly string[];
	readonly residualDefinitions: readonly string[];
}

// domain-view: planning/placement domain type (wire form in broker.proto when present).
export interface YardPlacementReceipt {
	readonly budgetReservation?: BudgetReservation;
	readonly hostingQuote?: HostingQuote;
	readonly hostingPolicyProof?: HostingPolicyProof;
	readonly schemaVersion: typeof YARD_PLACEMENT_RECEIPT_SCHEMA;
	readonly requestId: string;
	readonly brokerId: string;
	readonly selectionMode: YardSelectionMode;
	readonly requestedLayoutHash: ContentHash;
	readonly inventoryHash: ContentHash;
	readonly runtimeCatalogHash: ContentHash;
	readonly selectedYardId: string;
	readonly selectedProviderId: string;
	readonly selectedCampId: string;
	readonly generationAttemptId?: string;
	readonly match: YardMatchDecision;
	readonly executionUnits: readonly ExecutionUnit[];
	readonly contributingPolicyIds: readonly string[];
	readonly resolverPins: readonly ResolverPin[];
	readonly contentHash: ContentHash;
}

export function contentHashOf<T>(value: T): ContentHash {
	const canonical = JSON.stringify(sortKeys(cloneAsJson(value)));
	return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
}

export function emptyYardLayout(): YardLayout {
	return Object.freeze({
		// SAFETY: assertion required at this I/O or test boundary.
		regions: Object.freeze([] as string[]),
		// SAFETY: assertion required at this I/O or test boundary.
		require: Object.freeze([] as string[]),
		// SAFETY: assertion required at this I/O or test boundary.
		prefer: Object.freeze([] as string[]),
		// SAFETY: assertion required at this I/O or test boundary.
		residency: Object.freeze([] as string[]),
		// SAFETY: assertion required at this I/O or test boundary.
		isolation: Object.freeze([] as string[]),
		// SAFETY: assertion required at this I/O or test boundary.
		network: Object.freeze([] as string[]),
		// SAFETY: assertion required at this I/O or test boundary.
		componentHosts: Object.freeze([] as string[]),
		labels: Object.freeze({}),
		properties: Object.freeze({}),
		// SAFETY: assertion required at this I/O or test boundary.
		camps: Object.freeze([] as CampLayout[]),
	});
}

export function parseYardLayout(input: JsonValue | undefined): YardLayout {
	if (input === undefined || input === null) return emptyYardLayout();
	if (!isJsonObject(input) || Array.isArray(input)) {
		throw new TypeError("yard layout must be an object");
	}
	// SAFETY: assertion required at this I/O or test boundary.
	const raw = input as JsonObject;
	const base = emptyYardLayout();
	return Object.freeze({
		...(isJsonString(raw.providerId) && raw.providerId.length > 0
			? { providerId: raw.providerId }
			: undefined),
		...(isJsonString(raw.runtimeId) && raw.runtimeId.length > 0
			? { runtimeId: raw.runtimeId }
			: undefined),
		regions: list(raw.regions, base.regions),
		require: list(raw.require, base.require),
		prefer: list(raw.prefer, base.prefer),
		residency: list(raw.residency, base.residency),
		isolation: list(raw.isolation, base.isolation),
		network: list(raw.network, base.network),
		componentHosts: list(raw.componentHosts, base.componentHosts),
		labels: stringMap(raw.labels),
		properties: jsonMap(raw.properties),
		camps: Object.freeze(
			(Array.isArray(raw.camps) ? raw.camps : []).map(parseCampLayout),
		),
	});
}

export function parseCampLayout(input: JsonValue | undefined): CampLayout {
	if (!isJsonObject(input) || input === null || Array.isArray(input)) {
		return Object.freeze({
			// SAFETY: assertion required at this I/O or test boundary.
			require: Object.freeze([] as string[]),
			// SAFETY: assertion required at this I/O or test boundary.
			prefer: Object.freeze([] as string[]),
			labels: Object.freeze({}),
			// SAFETY: assertion required at this I/O or test boundary.
			runtimeRequirements: Object.freeze([] as string[]),
		});
	}
	// SAFETY: assertion required at this I/O or test boundary.
	const raw = input as JsonObject;
	return Object.freeze({
		...(isJsonString(raw.id) ? { id: raw.id } : undefined),
		...(isJsonString(raw.env) ? { env: raw.env } : undefined),
		...(isJsonString(raw.envType) ? { envType: raw.envType } : undefined),
		require: list(raw.require, []),
		prefer: list(raw.prefer, []),
		labels: stringMap(raw.labels),
		runtimeRequirements: list(raw.runtimeRequirements, []),
	});
}

function list(
	value: JsonValue | undefined,
	fallback: readonly string[],
): readonly string[] {
	if (!Array.isArray(value)) return Object.freeze([...fallback]);
	return Object.freeze(
		[
			...new Set(
				value.filter((v): v is string => isJsonString(v) && v.length > 0),
			),
		].sort(),
	);
}

function stringMap(
	value: JsonValue | undefined,
): Readonly<Record<string, string>> {
	if (!value || !isJsonObject(value) || Array.isArray(value)) {
		return Object.freeze({});
	}
	const out: Record<string, string> = {};
	// SAFETY: assertion required at this I/O or test boundary.
	for (const key of Object.keys(value as object).sort()) {
		// SAFETY: assertion required at this I/O or test boundary.
		const v = (value as JsonObject)[key];
		if (isJsonString(v)) out[key] = v;
	}
	return Object.freeze(out);
}

function jsonMap(
	value: JsonValue | undefined,
): Readonly<Record<string, JsonValue>> {
	if (!value || !isJsonObject(value) || Array.isArray(value)) {
		return Object.freeze({});
	}
	const out: Record<string, JsonValue> = {};
	// SAFETY: assertion required at this I/O or test boundary.
	for (const key of Object.keys(value as object).sort()) {
		// SAFETY: assertion required at this I/O or test boundary.
		out[key] = toJson((value as JsonObject)[key]);
	}
	return Object.freeze(out);
}

function toJson(value: JsonValue | undefined): JsonValue {
	if (
		value === null ||
		isJsonBoolean(value) ||
		isJsonNumber(value) ||
		isJsonString(value)
	) {
		return value;
	}
	if (Array.isArray(value)) return value.map(toJson);
	if (value && isJsonObject(value)) {
		return jsonMap(value);
	}
	throw new TypeError("value is not JSON-safe");
}

function sortKeys(value: JsonValue | undefined): JsonValue {
	if (value === undefined) return null;
	if (Array.isArray(value)) return value.map(sortKeys);
	if (!isJsonObject(value)) return value;
	return Object.fromEntries(
		Object.keys(value)
			.sort()
			.map((k) => [k, sortKeys(value[k])]),
	);
}
