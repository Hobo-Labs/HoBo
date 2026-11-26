package conformance

// Invariants for the provider scratch harness (ADR-0159).
//
// These are the rules that stop a lifecycle run from flattering the provider it
// describes: an instance always names both its instance id and the logical id
// it satisfies (that pair is what makes replace-vs-update decidable at all), a
// failure always names one of the six declared cases plus a non-empty reason,
// and a run reports no failures only when it genuinely had none — there is no
// partial credit and no "mostly reconciled".

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
	// A failure a provider author cannot act on is not a finding.
	error: string & !=""
}

#ProviderLifecycleResultRecord: {
	suite_id: "hobo.conformance.provider-lifecycle/v1"
	passed:   int & >=0 & <=6
	failed: [...#ProviderLifecycleFailureRecord]

	// Six cases, every one of them accounted for: a run that names the standard
	// suite neither invents passes nor loses failures.
	_everyCaseAccountedFor: true & (passed + len(failed) == 6)
}
