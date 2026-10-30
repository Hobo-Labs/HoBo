// Domain views of the wire contracts in data-models/broker.proto. The parsers
// in policies.ts / broker.ts / connector-registry.ts apply the protobuf + CUE
// constraints (parse, don't validate), so these parsed domain types are
// unrepresentable in an invalid state past the parser boundary.

import type {
	GuestResolutionEvidence,
	GuestResolutionInput,
} from "./guest-evidence.js";

// public-contract: the broker wire schema version every receipt/rejection pins.
export const BROKER_SCHEMA_VERSION = "hobo.broker/v1";

export const SCOPE_KINDS = ["bindle", "camp", "yard", "junction"] as const;
export type ScopeKind = (typeof SCOPE_KINDS)[number];

export const PLACEMENT_OBJECTIVES = ["min-cost", "pinned"] as const;
export type PlacementObjective = (typeof PLACEMENT_OBJECTIVES)[number];

export const CONNECTOR_KINDS = [
	"github-app",
	"pulumi",
	"azure",
	"vercel",
	"cloudflare",
	"custom",
] as const;
export type ConnectorKind = (typeof CONNECTOR_KINDS)[number];

export const REJECTION_PLANES = [
	"policy",
	"contracts",
	"billing",
	"placement",
	"connectors",
	"residency",
] as const;
export type RejectionPlane = (typeof REJECTION_PLANES)[number];

export const SCALE_DIRECTIONS = ["up", "down", "zero"] as const;
export type ScaleDirection = (typeof SCALE_DIRECTIONS)[number];

export const DELIVERY_ENGINES = ["argo", "in-proc"] as const;
export type DeliveryEngine = (typeof DELIVERY_ENGINES)[number];

// domain-view: branded canonical digest of a parsed BrokerPolicySet; wire form is the policy_hash field of ResolutionReceipt in data-models/broker.proto.
export type PolicyHash = string & { readonly __brand: "PolicyHash" };

// domain-view: parsed per-scope placement policy; wire form is PlacementPolicy in data-models/broker.proto.
export interface PlacementPolicy {
	id: string;
	scopeKind: ScopeKind;
	objective: PlacementObjective;
	pinnedProviderId?: string;
	allowedProviders: readonly string[];
	deniedProviders: readonly string[];
	allowedRegions: readonly string[];
	requireExplicitCamps: boolean;
}

// domain-view: parsed billing enforcement policy; wire form is BillingPolicy in data-models/broker.proto.
export interface BillingPolicy {
	quota: string;
	quotaUsed: number;
	quotaLimit: number;
	budgetUsd: number;
	spendCapUsd: number;
	/** Explicit unlimited mode; numeric zero otherwise means no paid admission. */
	budgetUnlimited?: boolean;
	spendCapUnlimited?: boolean;
}

// domain-view: parsed delivery-plane policy; wire form is DeliveryPolicy in data-models/broker.proto.
export interface DeliveryPolicy {
	engine: DeliveryEngine;
	syncMode: "auto" | "manual";
	prune: boolean;
	gitopsRepo?: string;
	destinationNamespace?: string;
}

// domain-view: parsed connector registration; wire form is ConnectorConfig in data-models/broker.proto.
export interface ConnectorConfig {
	id: string;
	kind: ConnectorKind;
	displayName: string;
	settings: Readonly<Record<string, string>>;
	credentialRef?: string;
	enabled: boolean;
}

// domain-view: the parsed policy state the broker maintains; wire form is BrokerPolicySet in data-models/broker.proto.
export interface BrokerPolicySet {
	schemaVersion: typeof BROKER_SCHEMA_VERSION;
	brokerId: string;
	placementPolicies: readonly PlacementPolicy[];
	billing: BillingPolicy;
	delivery: DeliveryPolicy;
	requiredConnectorKinds: readonly ConnectorKind[];
}

// domain-view: parsed topology scope of a request; wire form is TopologyScope in data-models/broker.proto.
export interface TopologyScope {
	bindleId: string;
	campId?: string;
	yardId?: string;
	junctionId?: string;
}

// domain-view: parsed per-resource requirement; wire form is ResourceRequirement in data-models/broker.proto.
export interface ResourceRequirement {
	resourceId: string;
	port: string;
	features: readonly string[];
	region?: string;
}

// domain-view: parsed brokering command; wire form is BrokerRequest in data-models/broker.proto.
export interface BrokerRequest {
	schemaVersion: typeof BROKER_SCHEMA_VERSION;
	requestId: string;
	scope: TopologyScope;
	requirements: readonly ResourceRequirement[];
	spendEstimateUsd: number;
	/** Anonymous/pre-claim resolution inputs (ADR-0151); absent for an owned deployment. */
	guest?: GuestResolutionInput;
}

// domain-view: one decided placement; wire form is PlacementDecision in data-models/broker.proto.
export interface PlacementDecision {
	resourceId: string;
	providerId: string;
	definitionId: string;
	region: string;
	sku: string;
	unit: string;
	marginalPrice: string;
}

// domain-view: accepted-resolution receipt; wire form is ResolutionReceipt in data-models/broker.proto.
export interface ResolutionReceipt {
	schemaVersion: typeof BROKER_SCHEMA_VERSION;
	requestId: string;
	brokerId: string;
	catalogHash: string;
	policyHash: PolicyHash;
	placementPolicyId: string;
	placements: readonly PlacementDecision[];
	/** Station occupancy — required on every receipt. */
	stationId: string;
	/** Content-addressed active Rail hash — required on every receipt. */
	railHash: string;
	/** Claim-relevant evidence for a guest deployment (ADR-0151); never bearer material. */
	guest?: GuestResolutionEvidence;
}

// domain-view: machine-readable per-plane refusal; wire form is RejectionReason in data-models/broker.proto.
export interface RejectionReason {
	plane: RejectionPlane;
	code: string;
	message: string;
}

// domain-view: refused-resolution record; wire form is ResolutionRejection in data-models/broker.proto.
export interface ResolutionRejection {
	schemaVersion: typeof BROKER_SCHEMA_VERSION;
	requestId: string;
	brokerId: string;
	policyHash: PolicyHash;
	reasons: readonly RejectionReason[];
	stationId: string;
	railHash: string;
}

// domain-view: parsed spin-up/spin-down command; wire form is ScaleDirective in data-models/broker.proto.
export interface ScaleDirective {
	resourceId: string;
	direction: ScaleDirection;
	replicas: number;
}

// Structural mirror of @hobo/cloud's PlannerRegistry / ResourceDefinition
// (packages/cloud/src/registry/catalog.ts). The broker depends on the
// catalog's *layout*, not on @hobo/cloud, so a real PlannerRegistry satisfies
// BrokerCatalog structurally and broker stays inward of cloud.
export interface BrokerCatalogDefinition {
	id: string;
	providerId: string;
	port: string;
	features: readonly string[];
	regions: readonly string[];
	cost: { sku: string; unit: string; marginalPrice: string };
	satisfies(req: { port: string; features?: string[] }): {
		kind: string;
		missing?: string[];
	};
}

export interface BrokerCatalog {
	catalogHash: string;
	definitions(): BrokerCatalogDefinition[];
}
