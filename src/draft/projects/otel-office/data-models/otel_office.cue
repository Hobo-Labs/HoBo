package oteloffice

// CUE constraints for data-models/otel_office.proto. Every proto message
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
