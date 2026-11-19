import {
	type AcpConnectorBinding,
	type AcpConnectorManifestEntry,
	acpConnector,
	lowerAcpConnector,
} from "@hobo/connector-acp";

// public-contract: the connector target name apps declare.
export const SWE_CLAUDE_CONNECTOR = "swe-claude";

export function sweClaudeConnector(): AcpConnectorBinding {
	return acpConnector(SWE_CLAUDE_CONNECTOR, {
		operations: {
			"workspace.read": "workspace:read",
			"workspace.write": "workspace:write",
			"tests.run": "tests:run",
			"tasks.run": "tasks:run",
			"reports.read": "reports:read",
		},
	});
}

export function lowerSweClaudeUsage(
	observedOperations: readonly string[],
): AcpConnectorManifestEntry {
	return lowerAcpConnector(sweClaudeConnector(), observedOperations);
}
