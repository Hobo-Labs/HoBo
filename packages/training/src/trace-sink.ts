// OpenInference-aligned trace capture for the built-in optimizer. Every
// OPTO step records one span into an in-memory sink the caller drains;
// span shapes follow the OpenInference vocabulary (span kind label +
// attributes map) with no external tracing dependency, and carry no wall
// clock so a seeded run replays to identical spans.

// public-contract: OpenInference semantic-convention attribute key for the span kind.
export const OPENINFERENCE_SPAN_KIND_ATTRIBUTE = "openinference.span.kind";

/** OpenInference span-kind labels (Arize OpenInference semantic conventions). */
export type OpenInferenceSpanKindLabel =
	| "LLM"
	| "CHAIN"
	| "TOOL"
	| "RETRIEVER"
	| "RERANKER"
	| "EMBEDDING"
	| "AGENT"
	| "GUARDRAIL"
	| "EVALUATOR"
	| "PROMPT";

/** Keep-best decision recorded on each OPTO step span. */
export type OptimizerStepDecision = "kept" | "rejected";

// domain-view: parse-produced/emitted trace record; wire form is OptimizerTraceSpan in data-models/training_optimizer.proto.
export interface OptimizerTraceSpan {
	readonly id: string;
	readonly parentId: string;
	readonly kind: OpenInferenceSpanKindLabel;
	readonly name: string;
	/** sha256:<hex64> digest of the proposed candidate parameter set. */
	readonly inputDigest: string;
	/** Rubric-derived score of the proposal, in [0, 1]. */
	readonly score: number;
	readonly decision: OptimizerStepDecision;
	readonly attributes: Readonly<Record<string, string>>;
}

/** In-memory sink the optimizer records into and the caller drains. */
export interface OptimizerTraceSink {
	record(span: OptimizerTraceSpan): void;
	/** Returns every recorded span in order and empties the sink. */
	drain(): readonly OptimizerTraceSpan[];
}

/** Creates an empty in-memory trace sink. */
export function createTraceSink(): OptimizerTraceSink {
	let spans: OptimizerTraceSpan[] = [];
	return {
		record(span: OptimizerTraceSpan): void {
			spans.push(span);
		},
		drain(): readonly OptimizerTraceSpan[] {
			const drained = spans;
			spans = [];
			return Object.freeze(drained);
		},
	};
}
