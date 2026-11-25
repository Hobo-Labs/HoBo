import { ACP_PROTOCOL } from "./types.js";

// public-contract: the manifest entry type connector declarations lower to.
export const CONNECTOR_ENTRY_TYPE = "connector.v1";

export interface AcpConnectorDeclaration {
	readonly name: string;
	readonly protocol: typeof ACP_PROTOCOL;
	readonly operationScopes: Record<string, string>;
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
