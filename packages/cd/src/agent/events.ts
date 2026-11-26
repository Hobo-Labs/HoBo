// Event names and stream ids the agent module appends beyond the frozen

export const AGENT_EVENTS = Object.freeze({
	BootstrapTokenIssued: "reconciler.BootstrapTokenIssued",
} as const);

export const AGENT_STREAMS = Object.freeze({
	bootstrap: (tokenHash: string) => `cd-bootstrap-${tokenHash}`,
});

export const AGENT_EVENT_SCHEMA = "hobo.cd.agent-identity/v1" as const;
