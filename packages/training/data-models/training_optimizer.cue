// CUE constraints for every protobuf type in training_optimizer.proto, so
// the architecture guard can confirm the built-in optimizer's config and
// trace-record shapes are bounded at parse time.

package training_optimizer

#OpenInferenceSpanKindLabel: "LLM" | "CHAIN" | "TOOL" | "RETRIEVER" |
	"RERANKER" | "EMBEDDING" | "AGENT" | "GUARDRAIL" | "EVALUATOR" | "PROMPT"

#OptimizerConfig: {
	engine_id?:           string & !=""
	seed:                 int & >=0 & <=4294967295
	max_iterations?:      int & >=1
	demos_per_candidate?: int & >=1
}

#OptimizerTraceSpan: {
	id:           string & !=""
	parent_id?:   string
	kind:         #OpenInferenceSpanKindLabel
	name:         string & !=""
	input_digest: string & =~"^sha256:[a-f0-9]{64}$"
	score:        number & >=0 & <=1
	decision:     "kept" | "rejected"
	attributes: {[string]: string}
}
