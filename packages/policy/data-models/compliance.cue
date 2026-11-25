// CUE constraints for every protobuf type in compliance.proto, so the
// architecture guard can confirm the compliance shapes are bounded at parse
// time.

package policy

#ResidencyPolicyDecisionRecord: {
	allowed: bool
	effect:  "allow" | "warn" | "deny"
	rule_id: string & !=""
	reasons: [...string & !=""]
	classification: "public" | "internal" | "pii" | "phi" | "pci" | "secret"
	region:         string & !=""
	jurisdictions: [...string & !=""]
}

#ControlEvidenceRefRecord: {
	kind: "event-stream" | "gate" | "artifact" | "retention"
	ref:  string & !=""
}

#ControlMappingRecord: {
	control_id: string & !=""
	title:      string & !=""
	evidence: [...#ControlEvidenceRefRecord] & [_, ...]
	status: "implemented" | "partial" | "planned"
}

#ControlEvidencePackRecord: {
	schema:    "hobo.control-evidence-pack/v1"
	framework: string & !=""
	version:   string & !=""
	controls: [...#ControlMappingRecord] & [_, ...]
}

#ControlCoverageReportRecord: {
	framework: string & !=""
	total:     uint32
	satisfied: uint32 & <=total
	missing_control_ids: [...string & !=""]
}

#OscalExportSummaryRecord: {
	kind:          "component-definition" | "assessment-results"
	framework:     string & !=""
	version:       string & !=""
	control_count: uint32
}
