export {
	loadStationCapabilityManifest,
	type MatchedStationCapability,
	matchStationCapabilities,
	persistStationCapabilityManifest,
	STATION_CAPABILITY_MANIFEST_SCHEMA,
	STATION_CAPABILITY_SCHEMA,
	type StationCapability,
	type StationCapabilityKind,
	type StationCapabilityManifest,
	type StationCapabilityObservation,
	type StationCapabilityProvenance,
	type StationCapabilitySpec,
	type StationCapabilityStatus,
	stationCapabilitiesPath,
	stationCapability,
} from "./capabilities.js";
export {
	type AggregateStationCapabilitiesInput,
	aggregateStationCapabilities,
	renderStationCapabilityCoverage,
	type ServedStationCapability,
	STATION_CAPABILITY_COVERAGE_SCHEMA,
	STATION_CAPABILITY_PROFILE_PATTERN,
	type StationCapabilityCoverage,
	StationCapabilityCoverageError,
	type StationCapabilityCoverageErrorCode,
	type StationCapabilityGap,
	type StationCapabilityOffering,
	type StationProviderConcentration,
	type StationYardBindingRowInput,
	type StationYardCatalogInput,
} from "./capability-coverage.js";
export {
	type CiBudgetRoutingBridge,
	type CiBudgetRoutingClient,
	type CiBudgetRoutingOutcome,
	createCiBudgetRoutingBridge,
} from "./ci-routing.js";
export {
	createStationBindleRuntimeContext,
	type StationConnectionResolver,
} from "./connector-context.js";
export {
	STATION_AUDIT_RETENTION,
	STATION_EVENT_SCHEMA,
	STATION_EVENTS,
	type StationEvent,
	type StationEventType,
	stationEvent,
} from "./events.js";
export {
	createHostedCiBudgetRoutingBridge,
	type HostedCiBudgetRoutingClient,
} from "./hosted-ci-routing.js";
export {
	type CreateStationOfferingRegistryOptions,
	createStationOfferingRegistry,
	type StationOfferingRegistration,
	type StationOfferingRegistry,
} from "./offering-registry.js";
export {
	type AuditSink,
	type CreatePrivilegedAccessGatewayOptions,
	createBoundaryPamGateway,
	createJumpServerPamGateway,
	createNativePamGateway,
	createPamAuditSink,
	createPrivilegedAccessGateway,
	createTeleportPamGateway,
	PAM_GATEWAY_SCHEMA,
	PAM_RAIL_CAPABILITY,
	type PamAuditEvent,
	type PamIsolationClass,
	type PamKind,
	type PrivilegedAccessGateway,
	type PrivilegedAccessGatewayHandle,
	railEnablesPam,
	type SessionHandle,
	type SessionRequest,
	type SessionTarget,
	type StationContext,
} from "./privileged-access-gateway.js";
export {
	createBootstrapRail,
	createRail,
	railContentHash,
	railFromBrokerConfig,
} from "./rail.js";
export { station } from "./station.js";
export {
	assertConnectionStationAccess,
	createStationClient,
	type InitStationResult,
	initStation,
	listStationIds,
	loadStationEvents,
	persistStationEvents,
	resolveStationContext,
	type StationClient,
	type StationPins,
	stationEventsPath,
	stationRoot,
} from "./station-client.js";
export {
	foldStationEvents,
	StationService,
	type StationState,
} from "./station-service.js";
export {
	type BackendCostModel,
	createRoutingControlLoop,
	ROUTING_LOOP_EVENTS,
	type RoutingControlLoop,
	type RoutingControlLoopOptions,
	type RoutingControlOutcome,
	type RoutingControlSignal,
	type RoutingStabilityPolicy,
} from "./traffic-routing/control-loop.js";
export {
	CUTOVER_EVENTS,
	type CutoverHealthGate,
	type CutoverHealthObservation,
	type CutoverPrecondition,
	type CutoverTtlPrecondition,
	DEFAULT_CONSECUTIVE_FAILURES_TO_ROLLBACK,
	DEFAULT_RAMP_STEPS,
	executeRoutingCutover,
	type RoutingCutoverOptions,
	type RoutingCutoverResult,
	routingCutoverEffects,
	routingMutationResilience,
	routingObservationResilience,
} from "./traffic-routing/cutover.js";
export {
	applyRoutingObservations,
	type RoutingBackendObservation,
	type RoutingObservations,
	topologyWithObservations,
} from "./traffic-routing/observations.js";
export {
	type RoutingSynthesisDenial,
	type RoutingSynthesisResult,
	type RoutingTopology,
	synthesizeRoutingPlan,
} from "./traffic-routing/synthesize.js";
export type {
	Rail,
	RailActivationStatus,
	RailPolicyEngine,
	Station,
	StationConfig,
	StationIsolation,
	StationOccupancy,
	StationStatus,
} from "./types.js";
export {
	RAIL_SCHEMA_VERSION,
	STATION_CONTRACT_VERSION,
	STATION_SCHEMA_VERSION,
} from "./types.js";

// public-contract: stable package identity for Station integrations and diagnostics.
export const HOBO_STATIONS_PACKAGE = "@hobo/stations";

export {
	type RoutingControlStateRecord,
	RoutingControlStateRecordSchema,
} from "./_generated/routing_control_pb.js";
