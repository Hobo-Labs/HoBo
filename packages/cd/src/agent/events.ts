// Event names and stream ids the agent module appends beyond the frozen
// CD_EVENTS / CD_STREAMS. Since L19 the fleet holds reconciler identity
// (tokens, keys, SVIDs, DPoP replay); what is left here is the Camp scope of
// a bootstrap token.

// public-contract: agent event names appended by `@hobo/cd/agent`.
export const AGENT_EVENTS = Object.freeze({
	/** Stream `cd-bootstrap-<sha256(token)>`: the Camp scope of a fleet bootstrap token (hash only, never the token). */
	BootstrapTokenIssued: "reconciler.BootstrapTokenIssued",
} as const);

// public-contract: agent stream ids.
export const AGENT_STREAMS = Object.freeze({
	bootstrap: (tokenHash: string) => `cd-bootstrap-${tokenHash}`,
});

// public-contract: schema id of agent event bodies.
export const AGENT_EVENT_SCHEMA = "hobo.cd.agent-identity/v1" as const;
