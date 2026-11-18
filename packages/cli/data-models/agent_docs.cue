package hobo

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
