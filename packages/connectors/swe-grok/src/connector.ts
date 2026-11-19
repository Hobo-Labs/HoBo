import {
	type AcpConnectorBinding,
	type AcpConnectorManifestEntry,
	acpConnector,
	lowerAcpConnector,
} from "@hobo/connector-acp";

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

export function lowerSweGrokUsage(
	observedOperations: readonly string[],
): AcpConnectorManifestEntry {
	return lowerAcpConnector(sweGrokConnector(), observedOperations);
}
