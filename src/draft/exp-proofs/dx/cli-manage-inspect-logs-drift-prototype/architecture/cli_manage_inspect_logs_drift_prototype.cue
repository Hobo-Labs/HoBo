package cli_manage_inspect_logs_drift

#ManageTranscriptPrototype: {
	issue:         "HOBO-574"
	phase:         "M2"
	targetPackage: "src/draft/exp-proofs/dx/cli-manage-inspect-logs-drift-prototype"
	proofNote:     "docs/design/proofs/cli-manage-inspect-logs-drift-prototype/README.md"
	designRefs: [...string]
	scenes: [...#ManageTranscriptScene]
	scopeOut: [...string]
}

#ManageTranscriptScene: {
	state:          "normal-operation" | "stale-projection" | "non-reactive-sink-warning" | "drift-detected" | "support-handoff" | "redacted-evidence-pack"
	fixtureId:      =~"^hobo-574-"
	fixtureSources: [...("run-inspector" | "projection-freshness" | "log-cursor" | "drift" | "token-audit" | "support-evidence")]
	proofMode:      "reference fixture"
	correlationId:  =~"^corr-hobo-574-"
	cli:            #CommandTranscript
	mcp:            #McpToolCall
	machine: #MachineResult
	human:          #HumanTranscript
	redaction:      #RedactionEvidence
}

#CommandTranscript: {
	command:  =~"^hobo "
	exitCode: 0 | 1 | 2
}

#McpToolCall: {
	tool: "hobo.inspect" | "hobo.logs" | "hobo.doctor"
	input: [string]: string | bool
	result: #MachineResult
}

#MachineResult: {
	status:      "ok" | "warning" | "blocked" | "handoff"
	code:        string
	message:     string
	remediation: string
}

#HumanTranscript: {
	summary: string
	lines: [...string]
	accessibilityNotes: [...string]
}

#RedactionEvidence: {
	redacted:       true
	classification: "tenant-safe" | "support-safe"
	visibleFields: [...string]
	withheldFields: [_, ...string]
}
