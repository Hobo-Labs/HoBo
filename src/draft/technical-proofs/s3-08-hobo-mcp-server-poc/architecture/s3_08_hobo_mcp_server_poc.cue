package architecture_evidence

#S308HoboMcpServerPocEvidenceKind: "unspecified" | "design-record" | "contract-test"

#McpGatewayRateLimitDecision: {
	principal_id:   string & !=""
	tenant_id:      string & !=""
	tool:           string & !=""
	code:           "MCP_RATE_LIMITED"
	retry_after_ms: int & >0
}

#S308HoboMcpServerPocRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
