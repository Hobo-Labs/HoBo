import { ACP_PROTOCOL } from "./types.js";

// Connector lowering for `connector(name, { protocol: "acp" })` (HOBO-88
// seam, promoted from the connector-authoring draft proof): the idiom-layer
// declaration lowers into a manifest external-dependency entry with
// usage-inferred `allow` scopes. There is NO public `agent()` factory —
// protocol use is explicit through the connector declaration
// (sdk-contracts.md §Protocol connectors; negative conformance vector).

// public-contract: the manifest entry type connector declarations lower to.
export const CONNECTOR_ENTRY_TYPE = "connector.v1";

export interface AcpConnectorDeclaration {
	readonly name: string;
	readonly protocol: typeof ACP_PROTOCOL;
	// The operations the app's code actually calls (usage observation) —
	// each maps to exactly one scope.
	readonly operationScopes: Record<string, string>;
	// Optional declared narrowing; observed usage may never exceed it.
	readonly declaredAllow?: readonly string[];
}

export interface AcpConnectorManifestEntry {
	readonly type: typeof CONNECTOR_ENTRY_TYPE;
	readonly protocol: typeof ACP_PROTOCOL;
	readonly via: "xaa";
	readonly onBehalfOf: "user";
	readonly allow: readonly string[];
	readonly observedScopes: readonly string[];
	readonly requestedScopeSource: "usage-inferred" | "declared-narrowing";
	readonly usageExceedsDeclaredAllow: boolean;
}

export interface AcpConnectorBinding {
	readonly name: string;
	readonly protocol: typeof ACP_PROTOCOL;
	readonly operationScopes: Record<string, string>;
	call(operation: string): { target: string; operation: string; scope: string };
}

// Declare an ACP protocol connector. This is the ONLY public entry point for
// agent-protocol interop — deliberately not named `agent`.
export function acpConnector(
	name: string,
	options: {
		operations: Record<string, string>;
		declaredAllow?: readonly string[];
	},
): AcpConnectorBinding {
	if (
		Object.prototype.toString.call(name) !== "[object String]" ||
		name.length === 0
	) {
		throw new Error("connector name must be a non-empty string");
	}
	for (const [operation, scope] of Object.entries(options.operations)) {
		if (!/^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/.test(operation)) {
			throw new Error(`Invalid connector operation name: ${operation}`);
		}
		if (!/^[a-z][a-z0-9.-]*:[a-z][a-z0-9.-]*$/.test(scope)) {
			throw new Error(`Invalid scope for operation ${operation}: ${scope}`);
		}
	}
	const operationScopes = Object.freeze({ ...options.operations });
	return Object.freeze({
		name,
		protocol: ACP_PROTOCOL,
		operationScopes,
		call(operation: string) {
			const scope = operationScopes[operation];
			if (!scope) {
				throw new Error(`Operation ${operation} is not advertised by ${name}`);
			}
			return { target: name, operation, scope };
		},
	});
}

// Lower a connector declaration + observed usage into the manifest entry:
// allow is usage-inferred unless a declared narrowing exists, and observed
// usage exceeding the declared allow is surfaced (the gate fails it).
export function lowerAcpConnector(
	binding: AcpConnectorBinding,
	observedOperations: readonly string[],
	declaredAllow?: readonly string[],
): AcpConnectorManifestEntry {
	const observedScopes = [
		...new Set(
			observedOperations.map((operation) => {
				const scope = binding.operationScopes[operation];
				if (!scope) {
					throw new Error(
						`Observed operation ${operation} is not advertised by ${binding.name}`,
					);
				}
				return scope;
			}),
		),
	].sort();
	const narrowed = declaredAllow ? [...declaredAllow].sort() : undefined;
	const usageExceedsDeclaredAllow = narrowed
		? observedScopes.some((scope) => !narrowed.includes(scope))
		: false;

	return Object.freeze({
		type: CONNECTOR_ENTRY_TYPE,
		protocol: ACP_PROTOCOL,
		via: "xaa",
		onBehalfOf: "user",
		allow: narrowed ?? observedScopes,
		observedScopes,
		requestedScopeSource: narrowed ? "declared-narrowing" : "usage-inferred",
		usageExceedsDeclaredAllow,
	});
}
