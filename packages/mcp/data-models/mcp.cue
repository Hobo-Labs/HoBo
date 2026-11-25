package hobo

// CUE constraints for the @hobo/mcp wire records (S3-01/S3-02). One constraint
// definition per protobuf message/enum in mcp.proto. Design source:
// docs/design/ai-native-agent-auth.md §6.4 + ADR-0023 item 3.

#McpToolDecisionEffect: "allow" | "deny"

#McpCapabilityScope: {
	port:     string & !=""
	resource: string & !=""
	verb:     string & !=""
}

#McpToolDescriptor: {
	name:            string & !=""
	verb:            string & !=""
	role:            string & !=""
	summary:         string & !=""
	capability:      #McpCapabilityScope
	inputSchemaJson: string & !=""
}

#McpToolCallRequest: {
	tool:          string & !=""
	correlationId: string & !=""
	cwd?:          string
	inputJson:     string
}

#McpToolCallResult: {
	tool:       string & !=""
	ok:         bool
	status:     string & !=""
	code:       string & !=""
	outputJson: string
}

#McpAuthDecisionEvent: {
	schemaVersion: "hobo.mcp-events/v1"
	type:          "mcp.ToolCallDecided"
	tool:          string & !=""
	subject:       string & !=""
	tenant:        string & !=""
	effect:        #McpToolDecisionEffect
	reason:        string & !=""
	seq:           int & >=0
	time:          string & !=""
	correlationId: string & !=""
}

#McpToolOutputObservation: {
	tool:                  string & !=""
	subject:               string & !=""
	recordedText:          string
	authorizedToolsBefore: [...string]
	authorizedToolsAfter: [...string]
	// Inert-output invariant: a tool output can never widen the grant set.
	widened: false
}

// S3-06 — rate-limit / quota backpressure (NFR-019). One constraint per new
// message in mcp.proto.

#McpQuota: {
	limit:    int & >0
	windowMs: int & >0
}

#McpRateLimitPolicy: {
	capacity:         int & >0
	refillTokens:     int & >0
	refillIntervalMs: int & >0
	quota?:           #McpQuota
}

#McpRateLimitDecision: {
	allowed:         bool
	key:             string & !=""
	reason:          "ok" | "rate" | "quota"
	retryAfterMs:    int & >=0
	remainingTokens: int & >=0
	quotaRemaining:  int & >=0
}

#McpToolCallThrottledEvent: {
	schemaVersion: "hobo.mcp-events/v1"
	type:          "mcp.ToolCallThrottled"
	tool:          string & !=""
	subject:       string & !=""
	tenant:        string & !=""
	reason:        "rate" | "quota"
	key:           string & !=""
	seq:           int & >=0
	time:          string & !=""
	correlationId: string & !=""
}
