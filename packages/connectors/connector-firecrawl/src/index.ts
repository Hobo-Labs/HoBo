import { type ConnectorSymbol, defineConnector } from "@hobo/bindles/connector";

/**
 * Firecrawl external-service declaration for HoBo Bindles.
 *
 * This package intentionally does not depend on or re-export the Firecrawl SDK.
 * Applications import `firecrawl` from the official `firecrawl` package for API
 * calls and use this symbol only to declare Station-resolved connectivity.
 */
export const firecrawl: ConnectorSymbol = defineConnector({
	kind: "connector-definition",
	id: "firecrawl",
	origin: "https://api.firecrawl.dev",
	auth: {
		protocol: "auth.md",
		discovery: "https://www.firecrawl.dev/auth.md",
	},
	capabilities: ["search", "scrape", "map", "extract"] as const,
});

// public-contract: the package id consumers assert against.
export const HOBO_CONNECTOR_FIRECRAWL_PACKAGE = "@hobo/connector-firecrawl";
