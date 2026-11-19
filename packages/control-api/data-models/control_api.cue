package control_api


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

#WorldStreamEvent: {
	event:         "world-snapshot" | "world" | "heartbeat"
	tick:          uint
	demo:          bool
	json_payload?: string
}


#CdReasonCode: "route-unknown" | "method-not-allowed" | "not-found" | "query-invalid" |
	"last-event-id-invalid" | "store-unavailable" | "view-failed" | "not-ready" |
	"step-failed" | "reconciler-crashed" | "drain-deadline-exceeded" | "already-started"

#CdReason: {
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
