// `@hobo/cd/telemetry` — DORA, reconcile lag, CI/CD semconv spans and
// metrics, fleet and policy gauges, the OTLP/HTTP JSON sink, alert rules and
// SLOs (WP19, C13, D17).
export {
	type AlertSeverity,
	CD_ALERT_RULES,
	CD_SLOS,
	type CdAlertRule,
	type CdSlo,
} from "./alerts.js";
export {
	computeDora,
	computeReconcileLag,
	createDoraProjection,
	DAY_MS,
	type DoraDeployment,
	type DoraFacts,
	type DoraProjection,
	type DoraQuery,
	type DoraRollback,
	p50,
} from "./dora.js";
export {
	TELEMETRY_FAILURES,
	TelemetryError,
	type TelemetryFailureCode,
} from "./errors.js";
export {
	campInventoryPoints,
	collectFleetMetrics,
	compliancePoints,
	FANOUT_SLOT_STATES,
	type FleetSources,
	failoverCountPoints,
	fanoutCampsPoints,
} from "./fleet.js";
export {
	encodeMetrics,
	encodeTraces,
	OTLP_DELTA_TEMPORALITY,
	OTLP_SPAN_KIND,
	OTLP_STATUS_CODE,
	type OtlpAnyValue,
	type OtlpKeyValue,
	otlpAttributes,
} from "./otlp.js";
export {
	CD_INSTRUMENTATION_SCOPE,
	CD_METRICS,
	CICD,
	CICD_ACTION,
	CICD_METRICS,
	type CicdResult,
	type CicdRunState,
	type CicdTaskType,
	DEPLOYMENT_ENVIRONMENT_NAME,
	ERROR_TYPE,
	HOBO_ATTR,
	SEMCONV,
} from "./semconv.js";
export {
	createTelemetrySink,
	type ExportStats,
	OTLP_DEFAULTS,
	type OtlpTelemetrySink,
	parseOtlpEndpoint,
	type TelemetrySinkOptions,
} from "./sink.js";
export {
	type CampLocator,
	type CampPlacementRef,
	journalPromotionSpans,
	pipelineRunMetrics,
	promotionSpanId,
	promotionSpans,
	promotionTraceId,
} from "./spans.js";
export {
	type CdTelemetryDeps,
	type CdTelemetryService,
	createCdTelemetry,
	DORA_DEFAULT_WINDOW_MS,
} from "./telemetry.js";
