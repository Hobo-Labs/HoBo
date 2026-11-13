// `@hobo/cd/pipelines` (WP5): the pipeline graph with lineage (D4), fleet
// nodes (D21) and policy delivery nodes (D24).
export type {
	AvailabilityInput,
	FreightFacts,
	NodeAvailability,
	PlacedView,
} from "./availability.js";
export {
	freightAvailability,
	quorumThreshold,
	VIA_APPROVAL,
} from "./availability.js";
export type {
	PipelineControllerDeps,
	PlacementContextResolver,
} from "./controller.js";
export {
	createPipelineController,
	fanoutWithDefaults,
	pipelineKey,
} from "./controller.js";
export type { GraphFacts } from "./graph.js";
export {
	effectiveAvailability,
	isPlaced,
	isPreview,
	normalizePipeline,
	projectOf,
	subjectOf,
	topologicalOrder,
	validatePipeline,
} from "./graph.js";
export {
	ORIGIN_SOURCES,
	PIPELINE_METRIC,
	PIPELINE_REASON,
	PROJECT_LABEL,
} from "./reasons.js";
