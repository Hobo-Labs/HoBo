package hobo

// CUE constraints for the Codex SWE adapter wire records. One constraint
// per protobuf message in swe_codex.proto.

#CodexLaunchRecord: {
	command: "codex-acp"
	args: []
	cwd:           string & !=""
	credentialEnv: "OPENAI_API_KEY"
}

#CodexTranscriptStepRecord: {
	kind:       "update" | "tool-permission"
	value:      string & !=""
	toolCallId: string
}

#CodexSweTaskRecord: {
	taskId:      string & !=""
	instruction: string & !=""
	workspace:   string & !=""
}

#CodexSweTaskReportRecord: {
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
