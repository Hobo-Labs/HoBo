/**
 * Bindle-side Connection helpers (provider-agnostic declaration).
 * Connections are broker-owned; Bindles only declare requirements / references.
 */

import { isJsonString } from "./json.js";

export type ConnectionRequirement = Readonly<{
	kind: "connection-requirement";
	/** Capability Manifest / Registry provider key (e.g. "asana"). */
	provider: string;
	/** Optional named Connection alias preferred at resolution. */
	alias?: string;
	/** Scopes the Bindle will request (must sit under Connection ceiling). */
	scopes: readonly string[];
	/** When true, any healthy Connection for the provider may satisfy. */
	anyHealthy?: boolean;
}>;

/**
 * Declare that a Bindle needs a durable Connection for an external app.
 * Provider selection still belongs on the Yard; this is not a provider pin.
 */
export function requireConnection(input: {
	provider: string;
	alias?: string;
	scopes?: readonly string[];
	anyHealthy?: boolean;
}): ConnectionRequirement {
	if (!isJsonString(input.provider) || input.provider.length === 0) {
		throw new TypeError("requireConnection: provider is required");
	}
	return Object.freeze({
		kind: "connection-requirement",
		provider: input.provider,
		...(input.alias !== undefined ? { alias: input.alias } : undefined),
		scopes: Object.freeze([...(input.scopes ?? [])]),
		anyHealthy: input.anyHealthy !== false,
	});
}

/**
 * SDK helper layout for `ctx.connection(aliasOrId).token({ scopes? })`.
 * Resolution is performed by the Yard token broker / ConnectionService.
 */
export interface ConnectionClient {
	readonly ref: string;
	token(options?: {
		readonly scopes?: readonly string[];
		readonly action?: string;
	}): Promise<{
		readonly token: string;
		readonly tokenRef: string;
		readonly expiresAt: string;
		readonly connectionId: string;
	}>;
}

export function connectionRef(aliasOrId: string): { readonly ref: string } {
	if (!isJsonString(aliasOrId) || aliasOrId.length === 0) {
		throw new TypeError("connection ref must be a non-empty string");
	}
	return Object.freeze({ ref: aliasOrId });
}
