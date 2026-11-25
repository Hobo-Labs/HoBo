import type { AgentPrincipal } from "./types.js";

// public-contract: the token-exchange grant type the broker speaks.
export const TOKEN_EXCHANGE_GRANT =
	"urn:ietf:params:oauth:grant-type:token-exchange";

export interface ConnectorTokenRequest {
	readonly requestId: string;
	readonly subject: AgentPrincipal;
	readonly target: {
		readonly id: string;
		readonly audience: string;
	};
	readonly requestedScopes: readonly string[];
	readonly grantType: typeof TOKEN_EXCHANGE_GRANT;
}

export interface ConnectorTokenBroker {
	exchangeToken(request: ConnectorTokenRequest): Promise<{
		readonly token: string;
		readonly expiresAt: string;
	}>;
}

export function buildConnectorTokenRequest(input: {
	readonly requestId: string;
	readonly principal: AgentPrincipal;
	readonly target: { id: string; audience: string };
	readonly manifestAllow: readonly string[];
	readonly requestedScopes?: readonly string[];
}): ConnectorTokenRequest {
	if (input.principal.kind !== "agent" || !input.principal.svid) {
		throw new Error(
			"connector-acp: the token subject must be an SVID-bound agent principal",
		);
	}
	if (input.principal.delegatedBy?.kind !== "user") {
		throw new Error(
			"connector-acp: agent principals must be delegated by a user",
		);
	}
	const allow = new Set(input.manifestAllow);
	const requested = input.requestedScopes ?? input.manifestAllow;
	const widened = requested.filter((scope) => !allow.has(scope));
	if (widened.length > 0) {
		throw new Error(
			`connector-acp: cannot widen beyond manifest allow: ${widened.join(", ")}`,
		);
	}

	return Object.freeze({
		requestId: input.requestId,
		subject: input.principal,
		target: Object.freeze({ ...input.target }),
		requestedScopes: Object.freeze([...requested].sort()),
		grantType: TOKEN_EXCHANGE_GRANT,
	});
}
