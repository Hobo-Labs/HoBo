package data_models


#WorkflowRunJournalRecord: {
	run_id:     string & !=""
	step_name:  string & !=""
	step_index: int & >=0
	status:     "scheduled" | "completed" | "failed"
}

#ActorActivationRecord: {
	type_name:   string & !=""
	actor_key:   string & !=""
	holder_id:   string & !=""
	fence_token: int & >=1
}

#AgentToolCallRecord: {
	agent_name: string & !=""
	tool_name:  string & !=""
	capability: string & =~"^(tool|token):"
}

#CapabilityGrantRecord: {
	subject:      string & !=""
	capabilities: [...string]
}
