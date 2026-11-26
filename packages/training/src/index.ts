// @hobo/training — the built-in engine behind core's hobo:training-engine
// port (ADR-0025). Internal-only: never re-exported
// through the app SDK surface; the platform selects it per tenant/Camp.

export {
	BUILTIN_TRAINING_ENGINE_ID,
	BUILTIN_TRAINING_ENGINE_VERSION,
	type BuiltinTrainingEngine,
	createBuiltinTrainingEngine,
	type OptimizerConfig,
	parseOptimizerConfig,
	TrainingOptimizerParseError,
} from "./optimizer.js";
export { createSeededPrng, type SeededPrng } from "./prng.js";
export {
	createTraceSink,
	OPENINFERENCE_SPAN_KIND_ATTRIBUTE,
	type OpenInferenceSpanKindLabel,
	type OptimizerStepDecision,
	type OptimizerTraceSink,
	type OptimizerTraceSpan,
} from "./trace-sink.js";
