package hobo

// CUE constraints for the Claude SWE adapter wire records. One constraint
// per protobuf message in swe_claude.proto.

#ClaudeLaunchRecord: {
	command: "claude-code-acp"
	args: []
	cwd:           string & !=""
	credentialEnv: "ANTHROPIC_API_KEY"
}

#ClaudeTranscriptStepRecord: {
	kind:       "update" | "tool-permission"
	value:      string & !=""
	toolCallId: string
}

#ClaudeSweTaskRecord: {
	taskId:      string & !=""
	instruction: string & !=""
	workspace:   string & !=""
}

#ClaudeSweTaskReportRecord: {
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
