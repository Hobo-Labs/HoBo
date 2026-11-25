export type {
	AggregateEvalOptions,
	GradedSample,
} from "./aggregate.js";
export { aggregateEvalResults } from "./aggregate.js";
export { promotionEventNames } from "./events.js";
export type {
	ChampionChallenger,
	EvalResult,
	LensFlags,
	PromotionDecision,
	PromotionGateInput,
	PromotionThresholds,
} from "./gate.js";
export {
	evaluatePromotionGate,
	PromotionGateParseError,
	PromotionOutcome,
	parseEvalResult,
	parsePromotionThresholds,
} from "./gate.js";
export type {
	AssembleTrajectoryOptions,
	CapturedSpan,
	CapturedSpanKind,
	CapturedTrajectory,
	EndSpanOptions,
	InMemorySpanExporter,
	SpanExporterPort,
	SpanHandle,
	SpanIdGenerator,
	SpanStatus,
	SpanStatusCode,
	StartSpanOptions,
	TrajectoryCapture,
	TrajectoryCaptureOptions,
} from "./trajectory/capture.js";
export {
	ATTR_INPUT_MIME_TYPE,
	ATTR_INPUT_VALUE,
	ATTR_OPENINFERENCE_SPAN_KIND,
	ATTR_OTEL_STATUS_CODE,
	ATTR_OTEL_STATUS_MESSAGE,
	ATTR_OUTPUT_MIME_TYPE,
	ATTR_OUTPUT_VALUE,
	assembleTrajectory,
	createInMemorySpanExporter,
	createTrajectoryCapture,
	MIME_TYPE_JSON,
	parseCapturedSpan,
} from "./trajectory/capture.js";
export type { TrajectoryCapturedEventOptions } from "./trajectory/events.js";
export {
	TRAINING_TRAJECTORY_CAPTURED,
	trajectoryCapturedEvent,
} from "./trajectory/events.js";
export type { TraceContext } from "./trajectory/trace-context.js";
export {
	formatTraceparent,
	generateSpanId,
	generateTraceId,
	parseTraceContext,
	TrajectoryCaptureParseError,
} from "./trajectory/trace-context.js";
