package data_models

#PolicySubject: {
	kind: string & !=""
	id:   string & !=""
	roles?: [...string]
	scopes?: [...string]
	delegated_by?: string
}

#PolicyResource: {
	kind: string & !=""
	id:   string & !=""
}

#DecisionRequest: {
	schema_version: string & !=""
	subject:        #PolicySubject
	action:         string & !=""
	resource:       #PolicyResource
	phase:          string & !=""
	input_hash:     string & =~"^sha256:[a-f0-9]{64}$"
}

#DecisionEvidence: #JsonDecisionEvidence | #WitDecisionEvidence

#JsonDecisionEvidence: {
	policyIds?: [...string]
	inputHash:    string & =~"^sha256:[a-f0-9]{64}$"
	engine:       string & !=""
	packId?:      string & !=""
	packVersion?: string & !=""
	if packId != _|_ {packVersion: string & !=""}
	if packVersion != _|_ {packId: string & !=""}
}

#WitDecisionEvidence: {
	policy_ids: [...string]
	input_hash:    string & =~"^sha256:[a-f0-9]{64}$"
	engine:        string & !=""
	pack_id?:      string & !=""
	pack_version?: string & !=""
	if pack_id != _|_ {pack_version: string & !=""}
	if pack_version != _|_ {pack_id: string & !=""}
}

#PolicyDecision: {
	schema_version: string & !=""
	effect:         "allow" | "allow-degraded" | "deny" | "warn" | "mutate" | "require-approval"
	reason:         string & !=""
	evidence:       #DecisionEvidence
}

#PolicyDecidedEvent: {
	id:       string & !=""
	type:     "policy.Decided"
	request:  #DecisionRequest
	decision: #PolicyDecision
}
