
package connector_firecrawl

#ConnectorAuthRecord: {
	protocol:  "auth.md"
	discovery: string & !=""
}

#ConnectorDefinitionRecord: {
	kind:      "connector-definition"
	id:        "firecrawl"
	origin:    "https://api.firecrawl.dev"
	audience?: string & !=""
	auth:      #ConnectorAuthRecord
	capabilities: [...("search" | "scrape" | "map" | "extract")]
}
