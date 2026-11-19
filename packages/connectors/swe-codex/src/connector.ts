import {
	type AcpConnectorBinding,
	type AcpConnectorManifestEntry,
	acpConnector,
	lowerAcpConnector,
} from "@hobo/connector-acp";

// public-contract: the connector target name apps declare.
export const SWE_CODEX_CONNECTOR = "swe-codex";

export function sweCodexConnector(): AcpConnectorBinding {
	return acpConnector(SWE_CODEX_CONNECTOR, {
		operations: {
			"workspace.read": "workspace:read",
			"workspace.write": "workspace:write",
			"tests.run": "tests:run",
			"tasks.run": "tasks:run",
			"reports.read": "reports:read",
		},
	});
}

export function lowerSweCodexUsage(
	observedOperations: readonly string[],
): AcpConnectorManifestEntry {
	return lowerAcpConnector(sweCodexConnector(), observedOperations);
}
