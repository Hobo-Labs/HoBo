package data_models

#OpenInferenceSpanKind: "OPEN_INFERENCE_SPAN_KIND_UNSPECIFIED" |
	"OPEN_INFERENCE_SPAN_KIND_LLM" |
	"OPEN_INFERENCE_SPAN_KIND_CHAIN" |
	"OPEN_INFERENCE_SPAN_KIND_TOOL" |
	"OPEN_INFERENCE_SPAN_KIND_RETRIEVER" |
	"OPEN_INFERENCE_SPAN_KIND_RERANKER" |
	"OPEN_INFERENCE_SPAN_KIND_EMBEDDING" |
	"OPEN_INFERENCE_SPAN_KIND_AGENT" |
	"OPEN_INFERENCE_SPAN_KIND_GUARDRAIL" |
	"OPEN_INFERENCE_SPAN_KIND_EVALUATOR" |
	"OPEN_INFERENCE_SPAN_KIND_PROMPT"

#GeneratedRegion: {
	region_id:    string & !=""
	artifact_ref: string & !=""
	start_offset: int & >=0
	end_offset:   int & >0
	owner:        string & !=""
}

#TrajectoryAgent: {
	id:            string & !=""
	principal_ref: string & !=""
}

#TrajectoryRun: {
	id:        string & !=""
	tenant_id: string & !=""
	bindle:    string & !=""
	agent:     #TrajectoryAgent
}

#TrajectorySubject: {
	method:           string & !=""
	contract_ref:     string & !=""
	generated_region: #GeneratedRegion
}

#OpenInferenceSpan: {
	id:            string & !=""
	parent_id?:    string
	kind:          #OpenInferenceSpanKind & !="OPEN_INFERENCE_SPAN_KIND_UNSPECIFIED"
	name:          string & !=""
	start_time:    string & !=""
	end_time:      string & !=""
	attributes: {[string]: string}
	inputs_json?:  string
	outputs_json?: string
}

#TrajectoryReward: {
	source:       string & !=""
	rubric_ref:   string & !=""
	event_id?:    string
	score:        number & >=0 & <=1
	observed_at?: string
}

#TrajectoryPayload: {
	classification?: string
	redaction?:      "none" | "tokenized" | "encrypted"
	token_ref?:      string
	encrypted_ref?:  string
	value_json?:     string
}

#Trajectory: {
	id:          string & !=""
	traceparent: string & =~"^00-[a-f0-9]{32}-[a-f0-9]{16}-[a-f0-9]{2}$"
	run:         #TrajectoryRun
	subject:     #TrajectorySubject
	spans: [...#OpenInferenceSpan] & [_, ...]
	payloads: {[string]: #TrajectoryPayload}
	reward: #TrajectoryReward
}

#TrainingRubric: {
	id:        string & !=""
	objective: string & !=""
	thresholds?: {[string]: number}
}

#ContractRef: {
	ref:               string & !=""
	method:            string & !=""
	allowed_region_id: string & !=""
}

#OptimizeRequest: {
	request_id:       string & !=""
	generated_region: #GeneratedRegion
	trajectories: [...#Trajectory] & [_, ...]
	rubric:   #TrainingRubric
	contract: #ContractRef
}

#CandidateEdit: {
	start_offset: int & >=0
	end_offset:   int & >=0
	replacement:  string & !=""
}

#CandidatePatch: {
	region: #GeneratedRegion
	edits: [...#CandidateEdit] & [_, ...]
}

#TrainingArtifact: {
	engine_id:      string & !=""
	engine_version: string & !=""
	method_ref:     string & !=""
	program_json:   string & !=""
}

#TrainingArtifactProgram: {
	instructions: string & !=""
	demos: [...#ProgramDemo]
	engine_payload_json?: string
}

#ProgramDemo: {
	input_json:  string & !=""
	output_json: string & !=""
}

#CandidateProvenance: {
	trajectory_hashes: [...string & =~"^sha256:[a-f0-9]{64}$"] & [_, ...]
	rubric_ref:   string & !=""
	contract_ref: string & !=""
}

#TrainingCandidate: {
	id:         string & !=""
	engine_id:  string & !=""
	provenance: #CandidateProvenance
	{patch: #CandidatePatch} | {artifact: #TrainingArtifact}
}
