import type { Yard } from "@hobo/yards";

export const JUNCTION_CONTRACT_VERSION = "hobo.junction-objects/v1" as const;

export const JUNCTION_PLAN_DERIVED_EVENT = "junction.PlanDerived" as const;

export const JUNCTION_COMPOSED_EVENT = "topology.JunctionComposed" as const;

export type ConnectivityTierName =
	| "private-network"
	| "cross-region"
	| "private-interconnect"
	| "overlay-mesh"
	| "public-mtls";

export const CONNECTIVITY_TIER_LEVELS: Readonly<
	Record<ConnectivityTierName, 1 | 2 | 3 | 4 | 5>
> = Object.freeze({
	"private-network": 1,
	"cross-region": 2,
	"private-interconnect": 3,
	"overlay-mesh": 4,
	"public-mtls": 5,
});

export interface JunctionMemberManifest {
	readonly yardName: string;
	readonly providerId: string;
	readonly region: string | null;
	readonly capabilities: readonly ConnectivityTierName[];
	readonly residency: readonly string[];
}

export interface ResidencyConflict {
	readonly sourceYard: string;
	readonly targetYard: string;
	readonly diagnostic: string;
}

export interface JunctionDefinition {
	readonly kind: "junction";
	readonly contract: typeof JUNCTION_CONTRACT_VERSION;
	readonly name: string;
	readonly yards: readonly Yard[];
	readonly members: readonly JunctionMemberManifest[];
}

export interface PeeringEdge {
	readonly id: string;
	readonly sourceYard: string;
	readonly targetYard: string;
	readonly tier: ConnectivityTierName;
	readonly tierLevel: number;
}

export interface ConnectivityHalf {
	readonly edgeId: string;
	readonly yardName: string;
	readonly peerYardName: string;
	readonly role: "source" | "target";
	readonly tier: ConnectivityTierName;
	readonly tierLevel: number;
}

export interface DnsRecord {
	readonly recordName: string;
	readonly recordType: "CNAME";
	readonly target: string;
	readonly ownerYard: string;
}

export interface TrustAnchorExchange {
	readonly kind: "trust-anchor-exchange";
	readonly fromYard: string;
	readonly toYard: string;
	readonly anchorRef: string;
}

export interface PolicyPackDistribution {
	readonly kind: "policy-pack-distribution";
	readonly toYard: string;
	readonly packRef: string;
	readonly signed: true;
}

export interface RegistryBundleDistribution {
	readonly kind: "registry-bundle-distribution";
	readonly fromYard: string;
	readonly toYard: string;
	readonly bundleRef: string;
	readonly signed: true;
}

export interface JunctionPlanEvent {
	readonly type: typeof JUNCTION_PLAN_DERIVED_EVENT;
	readonly junctionName: string;
	readonly edgeCount: number;
}

export interface JunctionDnsPlan {
	readonly zone: string;
	readonly records: readonly DnsRecord[];
}

export interface JunctionFederationPlan {
	readonly trustExchanges: readonly TrustAnchorExchange[];
	readonly policyPacks: readonly PolicyPackDistribution[];
	readonly registryBundles: readonly RegistryBundleDistribution[];
}

export interface JunctionConnectivityPlan {
	readonly kind: "junction-connectivity-plan";
	readonly contract: typeof JUNCTION_CONTRACT_VERSION;
	readonly junctionName: string;
	readonly members: readonly string[];
	readonly event: JunctionPlanEvent;
	readonly edges: readonly PeeringEdge[];
	readonly halvesByYard: Readonly<Record<string, readonly ConnectivityHalf[]>>;
	readonly dns: JunctionDnsPlan;
	readonly federation: JunctionFederationPlan;
	readonly residencyConflicts: readonly ResidencyConflict[];
}

export interface YardConnectivityHalfPlan {
	readonly junctionName: string;
	readonly yardName: string;
	readonly halves: readonly ConnectivityHalf[];
	readonly dnsRecordsToRealize: readonly DnsRecord[];
	readonly dnsRecordsToResolve: readonly DnsRecord[];
	readonly trustExchanges: readonly TrustAnchorExchange[];
	readonly policyPacks: readonly PolicyPackDistribution[];
	readonly registryBundles: readonly RegistryBundleDistribution[];
}

export type JunctionParseErrorCode =
	| "junction.name.invalid"
	| "junction.members.empty"
	| "junction.members.insufficient"
	| "junction.member.invalid"
	| "junction.member.duplicate"
	| "junction.manifest.unknown-yard"
	| "junction.manifest.invalid"
	| "junction.plan.unknown-yard";

export class JunctionParseError extends TypeError {
	readonly code: JunctionParseErrorCode;

	constructor(code: JunctionParseErrorCode, message: string) {
		super(message);
		this.name = "JunctionParseError";
		this.code = code;
	}
}
