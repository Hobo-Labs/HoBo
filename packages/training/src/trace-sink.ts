
export const OPENINFERENCE_SPAN_KIND_ATTRIBUTE = "openinference.span.kind";

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

export type OptimizerStepDecision = "kept" | "rejected";

export interface OptimizerTraceSpan {
	readonly id: string;
	readonly parentId: string;
	readonly kind: OpenInferenceSpanKindLabel;
	readonly name: string;
	readonly inputDigest: string;
	readonly score: number;
	readonly decision: OptimizerStepDecision;
	readonly attributes: Readonly<Record<string, string>>;
}

export interface OptimizerTraceSink {
	record(span: OptimizerTraceSpan): void;
	drain(): readonly OptimizerTraceSpan[];
}

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
