package yardworld

// CUE constraints for data-models/yard_world.proto. Every proto message
// defined there has a matching definition here.

#SpanRecord: {
	trace_id:        string & =~"^[0-9a-f]{32}$"
	span_id:         string & =~"^[0-9a-f]{16}$"
	parent_span_id:  string & (=~"" | =~"^[0-9a-f]{16}$")
	name:            string & !=""
	kind:            uint & >=0 & <=5
	status_code:     uint & >=0 & <=2
	start_time_unix_nano: uint
	end_time_unix_nano:   uint & >=start_time_unix_nano
}

#LogRecord: {
	trace_id:        string & (=~"" | =~"^[0-9a-f]{32}$")
	severity_number: uint & >=0 & <=24
	severity_text:   string
	body:            string
}

#MetricSample: {
	metric: string & !=""
	value:  number
	// Health-mapped metrics are constrained to the 0..1 range the bar renders.
	if metric == "hobo.health" {
		value: >=0 & <=1
	}
}

#PrimitiveRef: {
	service_name: string & !=""
	station:      string
	yard:         string
	camp:         string
	junction:     string
	primitive:    "" | "bindle" | "crew" | "actor"
}

#CharacterState: 0 | 1 | 2 | 3 | 4

// ── HoBo CD views (plan 0024 WP19) ──────────────────────────────────────────

#CdResult: "success" | "failure" | "error" | "timeout" | "cancellation" | "skip" | "pending"

#FreightTimelineEntryRecord: {
	freight_id:  string & =~"^sha256:"
	run_id:      string & !=""
	pipeline:    string
	node:        string
	camp_id:     string & !=""
	station_id:  string
	environment: string
	result:      #CdResult
	start_ms:    uint
	end_ms:      uint
}

#FreightTimelineRecord: {
	freight_id: string & =~"^sha256:"
	entries: [...#FreightTimelineEntryRecord]
}

#PipelineGraphNodeRecord: {
	id: string & !=""
	camps: [...(string & !="")]
	last_freight_id: string
	last_result:     #CdResult
	last_at_ms:      int
}

#PipelineGraphEdgeRecord: {
	from:          string & !=""
	to:            string & !=""
	freight_count: uint & >=1
}

#PipelineGraphRecord: {
	pipeline: string
	nodes: [...#PipelineGraphNodeRecord]
	edges: [...#PipelineGraphEdgeRecord]
}

#FleetTaintRecord: {
	key:    string & !=""
	effect: "no_place" | "no_run" | "unspecified"
}

#FleetCampRowRecord: {
	camp_id: string & !=""
	conditions: [string]: "true" | "false" | "unknown" | "unspecified"
	taints: [...#FleetTaintRecord]
}

#ComplianceCellRecord: {
	rail:    string & =~"^sha256:"
	control: string & !=""
	mode:    "enforce" | "inform"
	ratio:   number & >=0 & <=1
	band:    "ok" | "watch" | "breach"
}
