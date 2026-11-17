package stations

#CutoverTtlPrecondition: {
	previous_ttl_seconds: uint32 & >0
	lowered_ttl_seconds:  uint32 & >0
	waited_seconds:       uint32 & >0
}

#CutoverValidation: {
	status:     string & !=""
	change_id?: string
}

#CutoverPreconditionRecord: {
	validation:           #CutoverValidation
	ttl?:                 #CutoverTtlPrecondition
	mechanism?:           "weighted" | "dns"
	incumbent_plan_id?:   string
	incumbent_plan_json?: string
}

#CutoverReason: {
	code:    string & !=""
	message: string & !=""
}

#CutoverRefusedEventData: {
	service:         string & !=""
	from_backend_id: string & !=""
	to_backend_id:   string & !=""
	reasons: [...#CutoverReason]
	refused_at: string & !=""
}

#TtlLoweredEventData: {
	service:               string & !=""
	previous_ttl_seconds:  uint32 & >0
	lowered_ttl_seconds:   uint32 & >0
	waited_seconds:        uint32 & >0
	effective_rto_seconds: uint32 & >0
	lowered_at:            string & !=""
}

#CutoverStartedEventData: {
	service:         string & !=""
	from_backend_id: string & !=""
	to_backend_id:   string & !=""
	ramp_steps: [...uint32 & >0 & <=100]
	validation_change_id?:  string
	effective_rto_seconds?: uint32 & >0
	started_at:             string & !=""
}

#RampAdvancedEventData: {
	service: string & !=""
	percent: uint32 & >0 & <=100
	{
		toBackendId: string & !=""
		planId:      string & !=""
	} | {
		to_backend_id: string & !=""
		plan_id:       string & !=""
	}
}

#RoutingChangedEventData: {
	service:         string & !=""
	from_backend_id: string & !=""
	to_backend_id:   string & !=""
	changed_at:      string & !=""
}

#RolledBackEventData: {
	service:            string & !=""
	from_backend_id:    string & !=""
	to_backend_id:      string & !=""
	aborted_at_percent: uint32 & <=100
	reasons: [...#CutoverReason]
	effective_rto_seconds?: uint32 & >0
	rolled_back_at:         string & !=""
}
