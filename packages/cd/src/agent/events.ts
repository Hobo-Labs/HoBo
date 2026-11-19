
// public-contract: agent-identity event names appended by `@hobo/cd/agent`.
export const AGENT_EVENTS = Object.freeze({
	BootstrapTokenIssued: "reconciler.BootstrapTokenIssued",
	BootstrapTokenConsumed: "reconciler.BootstrapTokenConsumed",
	SvidIssued: "reconciler.SvidIssued",
	DpopProofAccepted: "reconciler.DpopProofAccepted",
} as const);

// public-contract: agent-identity stream ids.
export const AGENT_STREAMS = Object.freeze({
	bootstrap: (tokenHash: string) => `cd-bootstrap-${tokenHash}`,
	dpop: (reconcilerId: string, bucket: number) =>
		`cd-dpop-${reconcilerId}-${bucket}`,
});

// public-contract: schema id of agent-identity event bodies.
export const AGENT_EVENT_SCHEMA = "hobo.cd.agent-identity/v1" as const;
