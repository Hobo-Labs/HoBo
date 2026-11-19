package conformance


#ScratchDesiredRecord: {
	resource_type:   string & !=""
	logical_id:      string & =~"^[a-z0-9][a-z0-9-]*$"
	properties_json: string & !=""
	stables_json:    string & !=""
}

#ScratchResourceRecord: {
	id:            string & !=""
	resource_type: string & !=""
	logical_id:    string & =~"^[a-z0-9][a-z0-9-]*$"
	owned:         bool
	outputs_json:  string & !=""
	stables_json:  string & !=""
}

#ProviderLifecycleCaseName: "provider-lifecycle/create" |
	"provider-lifecycle/update-in-place" |
	"provider-lifecycle/replace" |
	"provider-lifecycle/delete-idempotent" |
	"provider-lifecycle/adopt" |
	"provider-lifecycle/crash-resume-idempotency"

#ProviderLifecycleFailureRecord: {
	name:  #ProviderLifecycleCaseName
	error: string & !=""
}

#ProviderLifecycleResultRecord: {
	suite_id: "hobo.conformance.provider-lifecycle/v1"
	passed:   int & >=0 & <=6
	failed: [...#ProviderLifecycleFailureRecord]

	_everyCaseAccountedFor: true & (passed + len(failed) == 6)
}
