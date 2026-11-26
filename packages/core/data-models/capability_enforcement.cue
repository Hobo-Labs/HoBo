package data_models

import "list"

#CapabilityDenialCode:
	"capability.import-not-declared" |
	"capability.export-not-found" |
	"capability.no-inferred-grant" |
	"capability.operation-not-granted" |
	"capability.no-linked-route" |
	"capability.fabricated-handle" |
	"capability.operation-not-found" |
	"capability.component-not-registered" |
	"capability.provider-not-registered"

#CapabilityDiagnosticCode:
	#CapabilityDenialCode |
	"capability.allow.narrow-below-usage" |
	"capability.usage.cannot-prove-operation"

#DiagnosticSeverity: "error" | "warning" | "info"

#CapabilityGrant: {
	component_id:     string & !=""
	import_interface: string & !=""
	resource:         string & !=""
	operations:       [...string & !=""] & list.UniqueItems()
	_operationsAreSorted: true & list.IsSortedStrings(operations)
}

#CapabilityUsage: {
	inferred: [...string & !=""] & list.UniqueItems()
	_inferredAreSorted: true & list.IsSortedStrings(inferred)
	source:   "static-analysis"
}

#CapabilityDiagnostic: {
	code:      #CapabilityDiagnosticCode
	severity:  #DiagnosticSeverity
	resource:  string & !=""
	message:   string & !=""
	file_name: string
	line:      int & >=0
}

#GrantEvaluation: {
	schema:               "hobo.capability-enforcement/v1"
	ok:                   bool
	can_deploy_dimension: "capabilityGrants"
	diagnostics:          [...#CapabilityDiagnostic]
	grants:               [...#CapabilityGrant]
}

#LinkEstablished: {
	component_id:     string & !=""
	import_interface: string & !=""
	provider_id:      string & !=""
	export_interface: string & !=""
	transport:        "in-process"
	grant_source:     "usage-inferred"
}

#LinkCalled: {
	component_id:     string & !=""
	import_interface: string & !=""
	provider_id:      string & !=""
	export_interface: string & !=""
	operation:        string & !=""
	resource:         string & !=""
	grant_source:     "usage-inferred"
	transport:        "in-process"
}

#CapabilityGrantDenied: {
	reason:           #CapabilityDenialCode
	component_id:     string
	import_interface: string
	operation:        string
	resource:         string
	provider_id:      string
	export_interface: string
}
