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
	isolationClass?:
		| "local-dev"
		| "preview"
		| "development"
		| "staging"
		| "production"
		| "ephemeral";
}>;

export type RailReconcilerMode = "conductor" | "agent" | "publisher";

export type RailDeliveryPolicy = Readonly<{
	reconcilerMode: RailReconcilerMode;
	publisher?: string;
	syncMode: "auto" | "manual";
	prune: boolean;
}>;

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
	railRefs: readonly string[];
	capabilities: readonly StationCapability[];
	metadata: Readonly<Record<string, string>>;
}>;

export type StationConfig = Readonly<{
	isolation: {
		tenant?: string;
		residency?: string;
		airgap?: boolean;
		trustDomain?: string;
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
