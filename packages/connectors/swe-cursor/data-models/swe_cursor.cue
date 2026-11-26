package hobo

// CUE constraints for the Cursor SWE adapter wire records. One constraint
// per protobuf message in swe_cursor.proto.

#CursorLaunchRecord: {
	command: "cursor-agent-acp"
	args: []
	cwd:           string & !=""
	credentialEnv: "CURSOR_API_KEY"
}

#CursorTranscriptStepRecord: {
	kind:       "update" | "tool-permission"
	value:      string & !=""
	toolCallId: string
}

#CursorSweTaskRecord: {
	taskId:      string & !=""
	instruction: string & !=""
	workspace:   string & !=""
}

#CursorSweTaskReportRecord: {
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
