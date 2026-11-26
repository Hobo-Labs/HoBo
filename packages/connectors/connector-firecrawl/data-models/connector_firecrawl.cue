// CUE constraints for every protobuf type in connector_firecrawl.proto, so
// the architecture guard can confirm the declaration is bounded at parse time.

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
