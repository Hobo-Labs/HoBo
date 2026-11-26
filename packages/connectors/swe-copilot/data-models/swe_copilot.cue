package hobo

// CUE constraints for the Copilot SWE adapter wire records. One constraint
// per protobuf message in swe_copilot.proto.

#CopilotLaunchRecord: {
	command: "copilot"
	args: ["--acp"]
	cwd:           string & !=""
	credentialEnv: "GH_TOKEN"
}

#CopilotTranscriptStepRecord: {
	kind:       "update" | "tool-permission"
	value:      string & !=""
	toolCallId: string
}

#CopilotSweTaskRecord: {
	taskId:      string & !=""
	instruction: string & !=""
	workspace:   string & !=""
}

#CopilotSweTaskReportRecord: {
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
