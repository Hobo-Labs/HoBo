package architecture_evidence

#ResourceId: string & =~"^[A-Za-z][A-Za-z0-9_-]*$"
#LazyToken: string & =~"^\\{[A-Za-z][A-Za-z0-9_-]*\\.[A-Za-z][A-Za-z0-9_.-]*\\}$"
#Lifetime: "session" | "persistent"
#WaitUntil: "ready" | "completed"
#ResolutionOrder: ["bindings", "tiers", "defaultProvider"]

#Link: {
	import: string & !=""
	to:   #ResourceId
}

#BindingMeta: {
	port:        string & !=""
	resource:    #ResourceId
	client_type: string & !=""
}

#ProviderSelection: {
	kind:        "provider-selection"
	provider_id: string & !=""
	selector:    string & !=""
}

#CampTopology: {
	id:                string & !=""
	env:               string & !=""
	env_type:          string & !=""
	provider_id:       string & !=""
	resolution_order:  #ResolutionOrder
}

#YardTopology: {
	name:        string & !=""
	provider_id: string & !=""
}

#S1_15BindWiringTopologyRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
