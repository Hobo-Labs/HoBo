package hobo

// CUE constraints for the @hobo/cli agent-docs wire records (S3-05). One
// constraint definition per protobuf message in agent_docs.proto. Design source:
// docs/design/ai-native-agent-auth.md §6.4 + docs/design/developer-experience.md.
// The single source of truth is CANONICAL_VERBS; the manifest is a deterministic
// projection over it, so an entry always maps 1:1 to a canonical verb.

#AgentDocCapability: {
	port:     string & !=""
	resource: string & !=""
	verb:     string & !=""
}

#AgentDocEntry: {
	name:       string & !=""
	role:       string & !=""
	summary:    string & !=""
	cli:        string & !=""
	mcpTool:    string & !=""
	capability: #AgentDocCapability
}

#AgentDocsManifest: {
	schemaVersion: string & !=""
	generator:     string & !=""
	product:       string & !=""
	entries: [...#AgentDocEntry]
	globalFlags: [...string]
	artifacts: [...string]
}

#AgentDocsArtifact: {
	path:    string & !=""
	content: string
}
