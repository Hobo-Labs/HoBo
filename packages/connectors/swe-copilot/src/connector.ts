import {
	type AcpConnectorBinding,
	type AcpConnectorManifestEntry,
	acpConnector,
	lowerAcpConnector,
} from "@hobo/connector-acp";

// The connector registration: `connector("swe-copilot", { protocol: "acp" })`
// resolves to this binding — the SWE-task operations and their scopes the
// lowering infers `allow` from.

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

// Lower the connector's observed usage into its manifest entry (HOBO-88
// seam via the shared connector-acp lowering).
export function lowerSweCopilotUsage(
	observedOperations: readonly string[],
): AcpConnectorManifestEntry {
	return lowerAcpConnector(sweCopilotConnector(), observedOperations);
}
