// Event names and stream ids the agent module appends beyond the frozen

// public-contract: agent event names appended by `@hobo/cd/agent`.
export const AGENT_EVENTS = Object.freeze({
	BootstrapTokenIssued: "reconciler.BootstrapTokenIssued",
} as const);

// public-contract: agent stream ids.
export const AGENT_STREAMS = Object.freeze({
	bootstrap: (tokenHash: string) => `cd-bootstrap-${tokenHash}`,
});

// public-contract: schema id of agent event bodies.
export const AGENT_EVENT_SCHEMA = "hobo.cd.agent-identity/v1" as const;
