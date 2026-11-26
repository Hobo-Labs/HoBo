package usage_permissions

#AllowProvenance: "inferred-from-usage" | "declared-narrow-or-equal" | "declared-dynamic"

#ObservedCall: {
	verb:   string & !=""
	source: string & !=""
}

#ResourcePermissionInput: {
	kind:          string & !=""
	name:          string & !=""
	port:          string & !=""
	catalog_verbs: [...string]
	observed_calls?: [...#ObservedCall]
	declared_allow?: [...string]
	dynamic_allow?:  [...string]
	dynamic_reason?: string
}

#UsagePermissionInput: {
	bindle:    string & !=""
	resources: [...#ResourcePermissionInput]
}

#AllowEntry: {
	verb:       string & !=""
	provenance: #AllowProvenance
}

#CapabilityFailure: {
	code:    "capability.required-not-granted"
	missing: [...string]
	message: string & !=""
}

#CapabilityContract: {
	required: [...string]
	granted:  [...string]
	status:   "satisfied" | "failed"
	failures: [...#CapabilityFailure]
}

#ResourceLink: {
	import:          string & !=""
	to:              string & !=""
	allow:           [...string]
	contract_status: "satisfied" | "failed"
}

#LoweredResourcePermission: {
	kind:                 string & !=""
	name:                 string & !=""
	port:                 string & !=""
	allow:                [...#AllowEntry]
	link:                 #ResourceLink
	capability_contract:  #CapabilityContract
}

#UsagePermissionManifest: {
	schema:    "hobo.manifest/v1"
	bindle:    string & !=""
	resources: [...#LoweredResourcePermission]
	links:     [...#ResourceLink]
}

#PermissionTripleIam: {
	verbs:      [...string]
	provenance: [...#AllowEntry]
}

#PermissionTripleLink: #ResourceLink

#TokenScope: {
	resource: string & !=""
	verbs:    [...string]
}

#PermissionTriple: {
	resource:    string & !=""
	iam:         #PermissionTripleIam
	link:        #PermissionTripleLink
	token_scope: #TokenScope
}
