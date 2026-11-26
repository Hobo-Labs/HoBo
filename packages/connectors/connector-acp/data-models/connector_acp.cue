package hobo

// CUE constraints for the ACP connector wire records. One constraint per
// protobuf message in connector_acp.proto.

#AgentPrincipalRecord: {
	kind:            "agent"
	id:              string & !=""
	svid:            =~"^spiffe://"
	delegatedByKind: "user"
	delegatedById:   string & !=""
}

#SessionOpenedRecord: {
	sessionId: string & !=""
	connector: string & !=""
	protocol:  "acp"
	principal: #AgentPrincipalRecord
}

#PolicyDecidedRecord: {
	sessionId:   string & !=""
	toolCallId:  string & !=""
	action:      string
	actionClass: "read" | "write" | "deploy" | "destroy" | "token" | "admin"
	effect:      "allow" | "require-approval" | "deny"
	reasons: [...string] & !=[]
}

#ToolCallRefusedRecord: {
	sessionId:  string & !=""
	toolCallId: string & !=""
	action:     string
	refusal:    =~"^hobo\\.policy-refusal/v1:"
}

#ConnectorManifestEntryRecord: {
	type:                      "connector.v1"
	protocol:                  "acp"
	via:                       "xaa"
	onBehalfOf:                "user"
	allow: [...string]
	observedScopes: [...string]
	requestedScopeSource:      "usage-inferred" | "declared-narrowing"
	usageExceedsDeclaredAllow: bool
}

#SandboxPostureRecord: {
	schema:             "hobo.agent-sandbox-posture/v1"
	ambientCredentials: false
	filesystemScope:    "workspace"
	filesystemRoot:     string & !=""
	networkScope:       "allowlist"
	networkAllowlist: [...string]
	envAllowlist: [...string]
}
