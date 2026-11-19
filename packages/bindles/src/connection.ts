
import { isJsonString } from "./json.js";

export type ConnectionRequirement = Readonly<{
	kind: "connection-requirement";
	provider: string;
	alias?: string;
	scopes: readonly string[];
	anyHealthy?: boolean;
}>;

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
