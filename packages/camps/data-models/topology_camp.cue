package data_models

#ResolutionOrder: ["bindings", "tiers", "defaultProvider"]

#ProviderSelection: {
	kind:        "provider-selection"
	provider_id: string & !=""
	selector:    string & !=""
}

#CampTopology: {
	id:               string & !=""
	logical_id?:      string & !=""
	env:              string & !=""
	env_type:         string & !=""
	provider_id:      string & !=""
	resolution_order: #ResolutionOrder
}
