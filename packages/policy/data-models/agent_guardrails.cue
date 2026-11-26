package data_models

#AgentActionClassEffect: "auto-allow" | "require-approval" | "deny" | "unspecified"

#AgentActionClassPolicy: {
	read:    #AgentActionClassEffect
	write:   #AgentActionClassEffect
	deploy:  #AgentActionClassEffect
	destroy: #AgentActionClassEffect
	token:   #AgentActionClassEffect
	admin:   #AgentActionClassEffect
}

#DestroyGrant: {
	granted:  bool
	grant_id?: string
}

#AgentGuardrailPolicy: {
	schema_version:     string & !=""
	agent_id:           string & !=""
	action_classes:     #AgentActionClassPolicy
	spend_cap_usd?:     number & >=0
	allowed_approvers?: [...string]
	destroy_grant:      #DestroyGrant
}

#AgentGuardrailEvaluation: {
	action_class:       string & !=""
	effect:             "allow" | "deny" | "require-approval"
	reason:             string & !=""
	enforcement_point:  "gateway" | "runtime"
}
