package architecture_evidence

#AllowDeclarationRecord: {
	bindle:       string & !=""
	component_id: string & !=""
	resource_id:  string & !=""
	port:         string & !=""
	verbs:        [...string] & [_, ...string]
}

#IamEffectRecord: {
	policy_id:        string & !=""
	subject:          string & !=""
	actions:          [...string] & [_, ...string]
	resource_pattern: string & !=""
}

#LinkTableEffectRecord: {
	component_id:     string & !=""
	import:           string & !=""
	to:               string & !=""
	allowed_verbs:    [...string]
	deny_by_default:  true
}

#TokenScopeCeilingRecord: {
	resource: string & !=""
	port:     string & !=""
	verbs:    [...string] & [_, ...string]
}

#AllowTripleEffectsRecord: {
	iam:                 #IamEffectRecord
	link_table:          #LinkTableEffectRecord
	token_scope_ceiling: #TokenScopeCeilingRecord
}
