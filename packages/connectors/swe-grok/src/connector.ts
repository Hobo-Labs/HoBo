import {
	type AcpConnectorBinding,
	type AcpConnectorManifestEntry,
	acpConnector,
	lowerAcpConnector,
} from "@hobo/connector-acp";

// The connector registration: `connector("swe-grok", { protocol: "acp" })`
// resolves to this binding — the SWE-task operations and their scopes the
// lowering infers `allow` from.

// public-contract: the connector target name apps declare.
export const SWE_GROK_CONNECTOR = "swe-grok";

export function sweGrokConnector(): AcpConnectorBinding {
	return acpConnector(SWE_GROK_CONNECTOR, {
		operations: {
			"workspace.read": "workspace:read",
			"workspace.write": "workspace:write",
			"tests.run": "tests:run",
			"tasks.run": "tasks:run",
			"reports.read": "reports:read",
		},
	});
}

// Lower the connector's observed usage into its manifest entry (HOBO-88
// seam via the shared connector-acp lowering).
export function lowerSweGrokUsage(
	observedOperations: readonly string[],
): AcpConnectorManifestEntry {
	return lowerAcpConnector(sweGrokConnector(), observedOperations);
}
