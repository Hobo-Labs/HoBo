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

#JsonValue: null | bool | number | string | [...#JsonValue] | {[string]: #JsonValue}

#LegacyCampMappingSelector: {
	resourceKind?: string
	resourceName?: string
	portRef?:      string
	labels?: {[string]: string}
}

#LegacyCampMappingRule: {
	selector:      #LegacyCampMappingSelector
	definitionId?: string
	resolverId?:   string
	className?:    string
	require: [...string]
	prefer: [...string]
	properties: {[string]: #JsonValue}
}

#ParsedLegacyCampMappings: {
	resourceMappings: [...#LegacyCampMappingRule]
	deprecation: string & !=""
}
