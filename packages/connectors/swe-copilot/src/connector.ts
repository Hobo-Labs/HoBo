import {
	type AcpConnectorBinding,
	type AcpConnectorManifestEntry,
	acpConnector,
	lowerAcpConnector,
} from "@hobo/connector-acp";

// public-contract: the connector target name apps declare.
export const SWE_COPILOT_CONNECTOR = "swe-copilot";

export function sweCopilotConnector(): AcpConnectorBinding {
	return acpConnector(SWE_COPILOT_CONNECTOR, {
		operations: {
			"workspace.read": "workspace:read",
			"workspace.write": "workspace:write",
			"tests.run": "tests:run",
			"tasks.run": "tasks:run",
			"reports.read": "reports:read",
		},
	});
}

export function lowerSweCopilotUsage(
	observedOperations: readonly string[],
): AcpConnectorManifestEntry {
	return lowerAcpConnector(sweCopilotConnector(), observedOperations);
}
