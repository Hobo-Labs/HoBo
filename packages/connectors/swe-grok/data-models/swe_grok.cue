package hobo

// CUE constraints for the Grok SWE adapter wire records. One constraint
// per protobuf message in swe_grok.proto.

#GrokLaunchRecord: {
	command: "grok-acp"
	args: []
	cwd:           string & !=""
	credentialEnv: "XAI_API_KEY"
}

#GrokTranscriptStepRecord: {
	kind:       "update" | "tool-permission"
	value:      string & !=""
	toolCallId: string
}

#GrokSweTaskRecord: {
	taskId:      string & !=""
	instruction: string & !=""
	workspace:   string & !=""
}

#GrokSweTaskReportRecord: {
	schema:     "hobo.swe-task-report/v1"
	taskId:     string & !=""
	sessionId:  string & !=""
	stopReason: "end_turn" | "cancelled" | "refusal" | "max_tokens" | "max_turn_requests" | "unknown"
	edits: [...string]
	refusals: [...string]
	completed: bool
}

#SandboxAccessReportRecord: {
	schema:        "hobo.sandbox-access-report/v1"
	workspaceRoot: string & !=""
	grantedActions: [...string]
	outOfScopeAccess: [...string]
	clean: bool
}
