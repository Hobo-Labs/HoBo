package hobo

// CUE constraints for the Gemini SWE adapter wire records. One constraint
// per protobuf message in swe_gemini.proto.

#GeminiLaunchRecord: {
	command: "gemini"
	args: ["--experimental-acp"]
	cwd:           string & !=""
	credentialEnv: "GEMINI_API_KEY"
}

#TranscriptStepRecord: {
	kind:       "update" | "tool-permission"
	value:      string & !=""
	toolCallId: string
}

#SweTaskRecord: {
	taskId:      string & !=""
	instruction: string & !=""
	workspace:   string & !=""
}

#SweTaskReportRecord: {
	schema:     "hobo.swe-task-report/v1"
	taskId:     string & !=""
	sessionId:  string & !=""
	stopReason: "end_turn" | "cancelled" | "refusal" | "max_tokens" | "max_turn_requests" | "unknown"
	edits: [...string]
	refusals: [...string]
	completed: bool
}
