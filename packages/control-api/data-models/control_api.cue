package control_api

// CUE constraints for every protobuf message in control_api.proto.

#ControlApiError: {
	code:    string
	message: string
	remediation: [...string]
}

#ControlApiResponse: {
	ok:         bool
	code:       string
	message:    string
	json_data?: string
}

#YardStreamEvent: {
	event:          "yard" | "heartbeat"
	seq:            uint
	json_snapshot?: string
}

// Envelope only: world/event payload shapes are owned by package yardworld
// (packages/yard-world/data-models/yard_world.cue) — referenced, not duplicated.
#WorldStreamEvent: {
	event:         "world-snapshot" | "world" | "heartbeat"
	tick:          uint
	demo:          bool
	json_payload?: string
}

// ── CD read API under /v1/cd/ (plan 0024 WP12) ─────────────────────────────
// Record payloads are hobo.cd.v1 messages (packages/cd/data-models) as
// canonical protobuf JSON — referenced, not duplicated.

#CdReasonCode: "route-unknown" | "method-not-allowed" | "not-found" | "query-invalid" |
	"last-event-id-invalid" | "store-unavailable" | "view-failed" | "not-ready" |
	"step-failed" | "reconciler-crashed" | "drain-deadline-exceeded" | "already-started"

#CdReason: {
	// Read-API codes, or a delivery-feed code when the request fell through.
	code:        #CdReasonCode | (string & !="")
	message:     string
	remediation: string & !=""
	subject:     string
}

#CdReadEnvelope: {
	ok:          bool
	json_value?: string
	reasons?: [...#CdReason]
}

#CdPosition: =~"^(0|[1-9][0-9]{0,19})$"

#CdStreamFrame: {
	position:   #CdPosition
	stream_id:  =~"^cd-"
	type:       string & !=""
	ts:         string
	json_data?: string
}

#CdCampCurrent: {
	camp_id:     string & !=""
	freight_id?: =~"^sha256:[0-9a-f]+$"
	set_id?:     string
}

#CdPipelineNodeView: {
	name: string & !=""
	from_sources: [...string]
	from_nodes: [...string]
	placement?:   string
	decision_id?: string
	qualified_camp_ids?: [...string]
	qualified_freight_id?: string
	camps: [...#CdCampCurrent]
	json_available: string
}

#CdTimelineEntry: {
	at:          string
	kind:        "recorded" | "promotion" | "qualified" | "approved" | "yanked" | "retired"
	camp_id?:    string
	json_detail: string
}
