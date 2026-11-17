package stations

#RoutingEventReason: {
	code:    string & !=""
	message: string & !=""
}

#RoutingReplanProposedEventData: {
	service:       string & !=""
	planId:        string & !=""
	fromBackendId: string & !=""
	toBackendId:   string & !=""
	revision:      uint32
}

#RoutingReplanHeldEventData: {
	service:           string & !=""
	reason:            "cooldown" | "flip-limit"
	selectedBackendId: string & !=""
}

#RoutingReplanDeniedEventData: {
	service: string & !=""
	reasons: [#RoutingEventReason, ...#RoutingEventReason]
}

#RoutingReappliedEventData: {
	service:     string & !=""
	planId:      string & !=""
	toBackendId: string & !=""
	revision:    uint32
	realized?:   "full" | "partial" | "none"
}

#RoutingReconciliationRequiredEventData: {
	service: string & !=""
	reasons: [#RoutingEventReason, ...#RoutingEventReason]
	{
		pendingPlanId: string & !=""
	} | {
		planId?:    string & !=""
		percent:    uint32 & <=100
		observedAt: string & !=""
	}
}

#RoutingApplyRequestedEventData: {
	service:     string & !=""
	planId:      string & !=""
	phase:       "ramp" | "restore"
	requestedAt: string & !=""
	effects: {
		schemaVersion: "hobo.effect-spec/v1"
		purity:        "noRollback"
		capabilities: [...("decides" | "suspends")]
		domains: [...("network" | "externalCall" | "policyEval" | "eventEmit" | "clock")]
	}
	if phase == "restore" {
		restorationOfPlanId: string & !=""
		restorationPlanHash: string & =~"^sha256:[a-f0-9]{64}$"
	}
}

#RoutingObservedEventData: {
	service:    string & !=""
	planId:     string & !=""
	phase:      "ramp" | "restore"
	observedAt: string & !=""
}
