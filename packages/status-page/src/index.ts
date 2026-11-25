/**
 * @hobo/status-page — event-sourced status pages for every HoBo scope.
 *
 * ADR-0077 (per-project status pages), ADR-0078 (availability stays
 * internal), ADR-0086 (replay-safe pure folds), ADR-0145 (platform-applied
 * trait with opt-out). See README.md for the architecture walkthrough.
 */

export {
	type IncidentOpenedData,
	type IncidentResolvedData,
	type IncidentUpdatedData,
	type MaintenanceScheduledData,
	type MaintenanceUpdatedData,
	type SloMeasuredData,
	STATUS_PAGE_EVENTS,
	STATUS_SIGNAL_EVENTS,
	type StatusEnvelopeOptions,
	type StatusPageIncidentPostedData,
	type StatusPagePublishedData,
	type StatusPageUnpublishedData,
	statusEnvelope,
} from "./events.js";
export {
	DEFAULT_FRESHNESS_BUDGET_MS,
	DEFAULT_RECENT_INCIDENT_WINDOW_MS,
	describeIndicator,
	type EvaluateOptions,
	INDICATOR_DESCRIPTIONS,
	overallIndicatorFor,
	toStatusPageModel,
} from "./model.js";
export {
	type ComponentRow,
	createStatusPageProjection,
	defaultScopeKey,
	HISTORY_DAY_LIMIT,
	STATUS_PAGE_PROJECTION,
	type StatusPageProjectionOptions,
	type StatusPageRow,
	statusFromAttainment,
} from "./projection.js";
export {
	assertPublishable,
	contentHashOf,
	type PublishedStatusPage,
	type PublishOptions,
	publishStatusPage,
	REDACTION_RULES,
	type RedactionRule,
	type RedactionViolation,
	type ScanOptions,
	StatusPageRedactionError,
	scanRenderedOutput,
} from "./redaction.js";
export { escapeHtml, renderStatusPageHtml } from "./render.js";
export {
	type BindleStatusPlan,
	DEFAULT_PROJECT,
	type DisabledComponent,
	deriveBindleStatusPlan,
	deriveProjectStatusPlans,
	type ProjectStatusPlan,
	primitiveComponents,
	primitivesStatusScope,
	stationCapabilityComponents,
	stationStatusScope,
} from "./scopes.js";
export {
	type StatusSitePage,
	type WriteStatusSiteOptions,
	type WrittenStatusPage,
	writeStatusSite,
} from "./site.js";
export {
	type StatuspageComponent,
	type StatuspageComponentStatus,
	type StatuspageIncident,
	type StatuspageIncidentUpdate,
	type StatuspageIndicator,
	type StatuspageMaintenance,
	type StatuspageSummary,
	type StatuspageSummaryOptions,
	toStatuspageStatus,
	toStatuspageSummary,
} from "./statuspage-json.js";
export {
	STATUS_PAGE_FORBIDDEN_HEX,
	STATUS_PAGE_TOKEN_VALUES,
	STATUS_PAGE_TOKENS,
	type StatusPageTokenName,
} from "./tokens.js";
export {
	advanceIncidentState,
	advanceMaintenanceState,
	COMPONENT_KINDS,
	COMPONENT_STATUSES,
	type ComponentKind,
	type ComponentSpec,
	type ComponentStatus,
	type ComponentStatusRecord,
	type DailyStatusRecord,
	INCIDENT_IMPACTS,
	INCIDENT_STATE_RANK,
	INCIDENT_STATES,
	type IncidentImpact,
	type IncidentRecord,
	type IncidentState,
	type IncidentUpdateRecord,
	MAINTENANCE_STATES,
	type MaintenanceRecord,
	type MaintenanceState,
	OVERALL_INDICATORS,
	type OverallIndicator,
	parseComponentSpec,
	parseIncidentRecord,
	parseMaintenanceRecord,
	parseStatusScope,
	STATUS_PAGE_SCHEMA,
	STATUS_SCOPE_KINDS,
	type StatusPageModel,
	StatusPageParseError,
	type StatusScope,
	type StatusScopeKind,
	worstComponentStatus,
} from "./types.js";
