import type { StationCapability } from "./capabilities.js";

// public-contract: wire schema / event catalog constant.
export const STATION_SCHEMA_VERSION = "hobo.station/v1" as const;
// public-contract: wire schema / event catalog constant.
export const RAIL_SCHEMA_VERSION = "hobo.rail/v1" as const;
// public-contract: wire schema / event catalog constant.
export const STATION_CONTRACT_VERSION =
	"hobo.control-plane-occupancy/v1" as const;

export type StationStatus = "open" | "closed";
export type RailActivationStatus = "draft" | "approved" | "active" | "retired";

export type StationIsolation = Readonly<{
	tenant: string;
	residency: string;
	airgap: boolean;
	trustDomain: string;
	/**
	 * Environment isolation class (ADR-0133). Station tagged to exactly one class.
	 * Reachable only under that class's isolation + chaining rules.
	 */
	isolationClass?:
		| "local-dev"
		| "preview"
		| "development"
		| "staging"
		| "production"
		| "ephemeral";
}>;

/** How a Camp converges (plan 0024, D14). Neutral: no engine or cluster vocabulary. */
export type RailReconcilerMode = "conductor" | "agent" | "publisher";

/**
 * Neutral delivery policy. `publisher` names a `@hobo/cd-gitops` publisher
 * target (for example `argo-cd` or `flux`) and is present only in
 * `publisher` mode. The legacy `engine` field is deprecated on the wire, never
 * read, and mapped by `neutralRailDeliveryPolicy`.
 */
export type RailDeliveryPolicy = Readonly<{
	reconcilerMode: RailReconcilerMode;
	publisher?: string;
	syncMode: "auto" | "manual";
	prune: boolean;
}>;

/** A JSON value inside the opaque Rail `delivery` object. */
export type RailDeliveryValue =
	| string
	| number
	| boolean
	| null
	| readonly RailDeliveryValue[]
	| RailDeliveryObject;
export type RailDeliveryObject = Readonly<{ [key: string]: RailDeliveryValue }>;

export type RailPolicyEngine = Readonly<{
	kind: "ts" | "opa" | "cedar";
	config?: Readonly<Record<string, string>>;
	endpoint?: string;
}>;

/**
 * Station-owned Rail: named, versioned, content-addressed policy profile.
 * Not Guardrail (effect language); Rail is the profile.
 */
export type Rail = Readonly<{
	schemaVersion: typeof RAIL_SCHEMA_VERSION;
	id: string;
	name: string;
	version: string;
	contentHash: `sha256:${string}`;
	stationId: string;
	activationStatus: RailActivationStatus;
	isBootstrap: boolean;
	policyPacks: readonly string[];
	policyEngine: RailPolicyEngine;
	placementDefaults: Readonly<{
		objective: "min-cost" | "pinned";
		allowedProviders: readonly string[];
		deniedProviders: readonly string[];
		allowedRegions: readonly string[];
	}>;
	billingPolicy: Readonly<{
		quota: string;
		quotaUsed: number;
		quotaLimit: number;
		budgetUsd: number;
		spendCapUsd: number;
	}>;
	deliveryPolicy: RailDeliveryPolicy;
	requiredConnectorKinds: readonly string[];
	catalogSnapshotPin?: string;
	approvedProviders: readonly string[];
	obligationDefaults: readonly string[];
	guardrailEnvelope: Readonly<Record<string, string>>;
	metadata: Readonly<Record<string, string>>;
	/**
	 * Opaque delivery object (plan 0024, D20). Part of the canonical content and
	 * the digest; Stations never interprets it. `@hobo/cd` parses it as
	 * `RailDeliveryRecord`. Absent on Rails published before it existed.
	 */
	delivery?: RailDeliveryObject;
	publishedAt: string;
}>;

export type Station = Readonly<{
	kind: "station";
	contract: typeof STATION_CONTRACT_VERSION;
	schemaVersion: typeof STATION_SCHEMA_VERSION;
	id: string;
	name: string;
	isolation: StationIsolation;
	status: StationStatus;
	/** Optional rail refs declared on the Station Bindle; ownership stays on Station. */
	railRefs: readonly string[];
	/**
	 * Capabilities this Station declaration expects its occupying host to
	 * offer (ADR-0155). Matching against host evidence produces a
	 * StationCapabilityManifest; declared-but-unobserved is missing (fail-closed).
	 */
	capabilities: readonly StationCapability[];
	metadata: Readonly<Record<string, string>>;
}>;

export type StationConfig = Readonly<{
	isolation: {
		tenant?: string;
		residency?: string;
		airgap?: boolean;
		trustDomain?: string;
		/** ADR-0133 isolation class the declaration commits to (passed through verbatim). */
		isolationClass?: StationIsolation["isolationClass"];
	};
	rails?: readonly string[];
	capabilities?: readonly StationCapability[];
	metadata?: Readonly<Record<string, string>>;
}>;

export type StationOccupancy = Readonly<{
	stationId: string;
	dataDir: string;
	status: StationStatus;
	isolation: StationIsolation;
	activeRailHash?: `sha256:${string}`;
	bootstrapRailHash?: `sha256:${string}`;
	bootstrapActive: boolean;
	connectionCount: number;
	createdAt: string;
	updatedAt: string;
	seq: number;
}>;
