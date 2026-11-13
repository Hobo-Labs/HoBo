/**
 * @hobo/yard-world — pure yard-world model for HoBo observability.
 *
 * Public surface: the typed event model + reducer, the OTLP/JSON mappers
 * (traces, logs, metrics), the bounded trace index, layout-as-data with
 * validation, and the deterministic simulator. No I/O here — the node-only
 * layout persistence lives behind the `@hobo/yard-world/layout-store` subpath.
 */

export {
	CD_FLEET_METRICS,
	CD_SPAN_ATTR,
	type CdResult,
	type CdSpan,
	COMPLIANCE_WATCH_RATIO,
	type ComplianceCell,
	type ComplianceHeatmap,
	complianceHeatmap,
	type FleetCampRow,
	type FleetView,
	type FreightTimeline,
	type FreightTimelineEntry,
	fleetView,
	freightTimeline,
	type HeatBand,
	heatBand,
	type PipelineGraph,
	type PipelineGraphEdge,
	type PipelineGraphNode,
	type PromotionTraceRendering,
	parseCdSpans,
	pipelineGraph,
	renderPromotionTrace,
} from "./cd-views.js";
export {
	applyLayout,
	deriveLayout,
	findPath,
	insideRect,
	isContiguous,
	type LayoutRoom,
	type LayoutValidation,
	MAX_GRID,
	MIN_ROOM_H,
	MIN_ROOM_W,
	rectsOverlap,
	stationCampIds,
	syncLayout,
	validateLayout,
	type WorldLayout,
} from "./layout-model.js";
export {
	ACTIVITY_LIMIT,
	ActivityLog,
	type AgentEvent,
	type AgentState,
	applyEvent,
	BUBBLE_TTL_MS,
	type Camp,
	type Character,
	type CharacterActivity,
	emptyWorld,
	type Junction,
	junctionForCamps,
	LONG_BLOCK_MS,
	type LogActivity,
	type MetricActivity,
	type Packet,
	type PrimitiveKind,
	type SpanActivity,
	type SpanKind,
	type SpanStatus,
	type Station,
	stateForSpan,
	type TilePoint,
	type TileRect,
	visibleCharacters,
	type WorldState,
	type Yard,
} from "./model.js";
export {
	attributesToRecord,
	characterIdFor,
	ensureCharacter,
	liftCdTopology,
	METRIC_HEALTH_MAP,
	mapLogsPayload,
	mapMetricsPayload,
	mapTracePayload,
	type OtlpLogsRequest,
	type OtlpMetricsRequest,
	type OtlpTraceRequest,
	severityFromOtlp,
	spanKindFromOtlp,
} from "./otel-mapper.js";
export {
	createRng,
	createSimulation,
	SIM_TICK_MS,
	type Simulation,
} from "./simulator.js";
export {
	type IndexedSpan,
	TRACE_INDEX_MAX_ENTRIES,
	TRACE_INDEX_TTL_MS,
	TraceIndex,
} from "./trace-index.js";
