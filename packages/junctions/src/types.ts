import type { WitnessedEnvelope } from "@hobo/fleet";
import type { Yard } from "@hobo/yards";

// public-contract: version tag on every parsed junction record — consumers reject incompatible authoring surfaces.
export const JUNCTION_CONTRACT_VERSION = "hobo.junction-objects/v1" as const;

// public-contract: event appended when the junction derives its cross-cloud connectivity plan.
export const JUNCTION_PLAN_DERIVED_EVENT = "junction.PlanDerived" as const;

// public-contract: event carrying the frozen JunctionDefinition snapshot, mirroring topology.CampComposed.
export const JUNCTION_COMPOSED_EVENT = "topology.JunctionComposed" as const;

/**
 * The five-tier connectivity model from the tier-one..tier-five draft proofs.
 * Lower level means a more private path; selection never widens beyond what
 * both member manifests declare.
 */
export type ConnectivityTierName =
	| "private-network"
	| "cross-region"
	| "private-interconnect"
	| "overlay-mesh"
	| "public-mtls";

// public-contract: numeric levels of the connectivity tiers; wire form is the
// ConnectivityTier enum in data-models/junction.proto.
export const CONNECTIVITY_TIER_LEVELS: Readonly<
	Record<ConnectivityTierName, 1 | 2 | 3 | 4 | 5>
> = Object.freeze({
	"private-network": 1,
	"cross-region": 2,
	"private-interconnect": 3,
	"overlay-mesh": 4,
	"public-mtls": 5,
});

// Parsed member manifest: region is string | null instead of proto3's
// empty-string sentinel.
// domain-view: parse-produced manifest; wire form is JunctionMemberManifest in data-models/junction.proto.
export interface JunctionMemberManifest {
	readonly yardName: string;
	readonly providerId: string;
	readonly region: string | null;
	readonly capabilities: readonly ConnectivityTierName[];
	/**
	 * Residency tags data crossing to this member must satisfy (ADR-0103 #4):
	 * a jurisdiction id ("eu") or "classification:jurisdiction" ("pii:eu").
	 */
	readonly residency: readonly string[];
}

// A member pair that failed the residency hard guard: no edge, no halves,
// an explicit diagnostic instead (ADR-0103 #3-4 fail-closed rule).
// domain-view: parse-produced diagnostic; wire form is ResidencyConflict in data-models/junction.proto.
export interface ResidencyConflict {
	readonly sourceYard: string;
	readonly targetYard: string;
	readonly diagnostic: string;
}

// domain-view: parse-produced junction value holding live Yard references and a
// literal `kind` discriminant; wire form is JunctionTopology in
// data-models/junction.proto.
export interface JunctionDefinition {
	readonly kind: "junction";
	readonly contract: typeof JUNCTION_CONTRACT_VERSION;
	readonly name: string;
	readonly yards: readonly Yard[];
	readonly members: readonly JunctionMemberManifest[];
}

// Parsed peering edge carries a tier name instead of the proto enum ordinal.
// domain-view: parse-produced edge; wire form is PeeringEdge in data-models/junction.proto.
export interface PeeringEdge {
	readonly id: string;
	readonly sourceYard: string;
	readonly targetYard: string;
	readonly tier: ConnectivityTierName;
	readonly tierLevel: number;
}

// One yard's mirrored half of a peering edge.
// domain-view: parse-produced half; wire form is ConnectivityHalf in data-models/junction.proto.
export interface ConnectivityHalf {
	readonly edgeId: string;
	readonly yardName: string;
	readonly peerYardName: string;
	readonly role: "source" | "target";
	readonly tier: ConnectivityTierName;
	readonly tierLevel: number;
}

// Federated-domain record narrowed to the CNAME shape this derivation emits.
// domain-view: narrowed record; wire form is DnsRecord in data-models/junction.proto.
export interface DnsRecord {
	readonly recordName: string;
	readonly recordType: "CNAME";
	readonly target: string;
	readonly ownerYard: string;
}

// Trust exchange entry between two member yards: `fromYard`'s HoBo Fleet trust
// record (ADR-0182), witnessed, for `toYard` to pin. Federation between Yards
// is an exchange of trust records; there is no second trust format. `null`
// until `fromYard` has published its trust record.
// domain-view: kind-discriminated entry; wire form is TrustAnchorExchange in data-models/junction.proto.
export interface TrustAnchorExchange {
	readonly kind: "trust-anchor-exchange";
	readonly fromYard: string;
	readonly toYard: string;
	readonly trust: WitnessedEnvelope | null;
}

/** Each member Yard's witnessed fleet trust record, by Yard name. */
export type YardTrustRecords = Readonly<Record<string, WitnessedEnvelope>>;

// Signed policy-pack distribution entry for one member yard.
// domain-view: kind-discriminated entry; wire form is PolicyPackDistribution in data-models/junction.proto.
export interface PolicyPackDistribution {
	readonly kind: "policy-pack-distribution";
	readonly toYard: string;
	readonly packRef: string;
	readonly signed: true;
}

// Signed registry-bundle distribution entry between two member yards.
// domain-view: kind-discriminated entry; wire form is RegistryBundleDistribution in data-models/junction.proto.
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

// Derived connectivity plan grouped into nested dns/federation sub-plans plus
// a halves-by-yard projection.
// domain-view: richer parse-produced plan; wire form is JunctionConnectivityPlan in data-models/junction.proto.
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

// One yard's extractable half of the junction plan, split into realize/resolve DNS sets.
// domain-view: per-yard projection; wire form is YardConnectivityHalfPlan in data-models/junction.proto.
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

/** Typed parse failure raised at the junction authoring boundary. */
export class JunctionParseError extends TypeError {
	readonly code: JunctionParseErrorCode;

	constructor(code: JunctionParseErrorCode, message: string) {
		super(message);
		this.name = "JunctionParseError";
		this.code = code;
	}
}
