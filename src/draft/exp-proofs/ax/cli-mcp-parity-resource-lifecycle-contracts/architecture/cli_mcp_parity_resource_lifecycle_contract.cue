package cli_mcp_parity

#CliMcpOperation: {
	id: =~"^(collect|plan|up|inspect|logs|doctor|import|migrate)$"
	cli_synopsis: =~"^hobo "
	flags: [...string]
	mcp_tool: =~"^hobo\\."
	shared_call_path: "gateway-command-path"
	mcp_input_schema: #McpInputSchema
}

#McpInputSchema: {
	schema_id: =~"^hobo\\.570\\.(collect|plan|up|inspect|logs|doctor|import|migrate)\\.input/v1$"
	fields: [...#McpInputField] & [_, ...]
}

#McpInputField: {
	name: =~"^[a-z][a-zA-Z0-9]*$"
	type: "string" | "boolean" | "enum"
	required: bool
	maps_to_cli_flag?: =~"^--[a-z][a-z-]*$"
	purpose: string & != ""
	enum_values?: [...string]
}

#ResultEnvelope: {
	status: "ok" | "blocked" | "warning" | "handoff"
	code: =~"^[a-z]+\\.[a-z0-9-]+"
	human_message: string & != ""
	remediation: string & != ""
	proof_mode: "reference-fixture" | "simulated-reference" | "design-record"
	fixture_id: =~"^hobo-570-"
	correlation_id: =~"^corr-hobo-570-"
	redaction_class: "public" | "tenant-safe" | "support-safe"
}

#ProofFixture: {
	case_name: "successful-deploy" | "blocked-deploy" | "stale-projection" | "non-portable-edge" | "support-handoff"
	fixture_id: =~"^hobo-570-"
	cli_command: =~"^hobo "
	mcp_tool: =~"^hobo\\."
	mcp_input: {...}
	result: #ResultEnvelope
}
