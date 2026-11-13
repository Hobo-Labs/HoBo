// "./reconcile" (WP7): fenced pull reconcilers, the in-process
// transport, observation hygiene, retained fields, drift routing, departure.

// The realizer adapters this module drives (src/adapters, WP7).
export {
	createHostingTransitionRealizer,
	HOSTING_TRANSITION_KIND,
	type HostingCoordinator,
	type HostingTransitionRealizerDeps,
	transitionStatus,
} from "../adapters/hosting-transition.js";
export {
	createOrchestratorRealizer,
	diffGraph,
	failFastExecutor,
	type HostAttestor,
	ORCHESTRATOR_LEDGER,
	type OrchestratorRealizerDeps,
	RealizeExecFailed,
	resourceNodeHash,
} from "../adapters/orchestrator.js";
export { backoffMs, jitterFraction, RECONCILE_BACKOFF } from "./backoff.js";
export {
	type DeparturePlan,
	type DirectedRealizeInput,
	defaultDepartureAction,
	keepOf,
	keptButMissing,
	planDeparture,
	type RealizeDirectives,
} from "./departure.js";
export {
	combineRoutes,
	createDriftPolicy,
	DEFAULT_DRIFT_BLAST_RADIUS,
	DEFAULT_DRIFT_ROUTES,
	type DriftDecision,
	type DriftFinding,
	type DriftPolicyOptions,
	decideDrift,
	driftFindings,
	driftFingerprint,
	isDataResource,
} from "./drift.js";
export {
	messageOf,
	RECONCILE_FAILURES,
	ReconcileError,
	type ReconcileFailureCode,
	reason,
	refuse,
} from "./errors.js";
export {
	type AttributeTrim,
	blockedObservation,
	isConvergedOn,
	redactSecret,
	type SanitizeInput,
	sanitizeObservation,
	trimAttributes,
} from "./observation.js";
export {
	type CampReconcilerDeps,
	createCampReconciler,
	RECONCILE_METRICS,
	RECONCILE_OBSERVE_INTERVAL_MS,
} from "./reconciler.js";
export {
	applyRetained,
	DRIFT_CLASSES,
	type DriftClass,
	type DriftKind,
	formatDriftKind,
	mappingRetained,
	mergeRetained,
	parseDriftKind,
	parseRetainProperty,
	RETAIN_PROPERTY,
	RETAINED_FIELDS,
	tableRetained,
} from "./retained.js";
export {
	observationJson,
	parseObservation,
	RECONCILE_EVENTS,
	RECONCILE_STATUS_SCHEMA,
	statusEventsFor,
} from "./status-events.js";
export {
	createInProcessTransport,
	type InProcessTransportDeps,
	leaseHolder,
} from "./transport.js";
