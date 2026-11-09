package data_models

#PortRequestRecord: {
	port: string & !=""
	features?: [...string]
	negotiation?: "prefer" | "require"
	region?: string
}

#CapabilityMatchRecord: {
	kind: "full" | "partial" | "none"
	missing?: [...string]
}

#FreeTierRecord: {
	unit:     string & !=""
	included: number & >=0
	reset:    string & !=""
}

#CostSignalRecord: {
	currency:       string & !=""
	sku:            string & !=""
	unit:           string & !=""
	marginal_price: string & !=""
	free_tier:      #FreeTierRecord
	pricing_status?: "unknown" | "estimate" | "verified-zero"
}

#IacResourceRecord: {
	name:        string & !=""
	type:        string & !=""
	provider:    string & !=""
	inputs_json: string
	outputs: [...string]
}

#IacProgramRecord: {
	api_version:   "hobo.iac-program/v1"
	kind:          "iac-program"
	provider:      string & !=""
	deployment_id: string & !=""
	stack:         string & !=""
	resources: [...#IacResourceRecord]
	stack_outputs: {[string]: string}
}

#BuildArtifactRecord: {
	id:     string & !=""
	source: string & !=""
	target: string & !=""
}

#BuildSpecRecord: {
	kind: "hobo.build-spec/v1"
	artifacts: [...#BuildArtifactRecord]
}

#ResourcePlanRecord: {
	name:     string & !=""
	port:     string & !=""
	provider: string & !=""
	options_json?: [...string]
	deps?: [...string]
	strategy?:      string
	region?:        string
	deployment_id?: string
	build?:         #BuildArtifactRecord
}
