import {
	type AcpConnectorBinding,
	type AcpConnectorManifestEntry,
	acpConnector,
	lowerAcpConnector,
} from "@hobo/connector-acp";

// public-contract: the connector target name apps declare.
export const SWE_CURSOR_CONNECTOR = "swe-cursor";

export function sweCursorConnector(): AcpConnectorBinding {
	return acpConnector(SWE_CURSOR_CONNECTOR, {
		operations: {
			"workspace.read": "workspace:read",
			"workspace.write": "workspace:write",
			"tests.run": "tests:run",
			"tasks.run": "tasks:run",
			"reports.read": "reports:read",
		},
	});
}

export function lowerSweCursorUsage(
	observedOperations: readonly string[],
): AcpConnectorManifestEntry {
	return lowerAcpConnector(sweCursorConnector(), observedOperations);
}
