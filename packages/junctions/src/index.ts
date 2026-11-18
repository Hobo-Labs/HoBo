export {
	deriveConnectivityPlan,
	planForYard,
	selectConnectivityTier,
} from "./connectivity.js";
export { deriveFederationPlan } from "./federation.js";
export type {
	JunctionConfig,
	JunctionMemberManifestInput,
} from "./junction.js";
export { junction } from "./junction.js";
export {
	type ActorSignalFederationLink,
	type DeriveMessagingFederationInput,
	deriveMessagingFederationPlan,
	JUNCTION_MESSAGING_FEDERATED_EVENT,
	type JunctionMessagingFederationPlan,
	type TopicFederationLink,
} from "./messaging-federation.js";
export type {
	ConnectivityHalf,
	ConnectivityTierName,
	DnsRecord,
	JunctionConnectivityPlan,
	JunctionDefinition,
	JunctionDnsPlan,
	JunctionFederationPlan,
	JunctionMemberManifest,
	JunctionParseErrorCode,
	JunctionPlanEvent,
	PeeringEdge,
	PolicyPackDistribution,
	RegistryBundleDistribution,
	ResidencyConflict,
	TrustAnchorExchange,
	YardConnectivityHalfPlan,
} from "./types.js";
export {
	CONNECTIVITY_TIER_LEVELS,
	JUNCTION_COMPOSED_EVENT,
	JUNCTION_CONTRACT_VERSION,
	JUNCTION_PLAN_DERIVED_EVENT,
	JunctionParseError,
} from "./types.js";

export const HOBO_JUNCTIONS_PACKAGE = "@hobo/junctions";
