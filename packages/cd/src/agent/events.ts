// Event names and stream ids the agent module appends beyond the frozen
// CD_EVENTS / CD_STREAMS (plan 0024 A.6 does not name them). Reported to the
// coordinator as a contract-amendment candidate; until then they are owned
// here and are wire contract.

// public-contract: agent-identity event names appended by `@hobo/cd/agent`.
export const AGENT_EVENTS = Object.freeze({
	/** Stream `cd-bootstrap-<sha256(token)>`: a single-use token was issued (hash only, never the token). */
	BootstrapTokenIssued: "reconciler.BootstrapTokenIssued",
	/** Same stream: the token was consumed by one key thumbprint. */
	BootstrapTokenConsumed: "reconciler.BootstrapTokenConsumed",
	/** Reconciler stream: a key-bound JWT-SVID was issued (its jti and expiry; never the token). */
	SvidIssued: "reconciler.SvidIssued",
	/** Reconciler stream: an SVID refresh failed (CREDENTIAL_VALID evidence). */
	SvidRefreshFailed: "reconciler.SvidRefreshFailed",
	/** Stream `cd-dpop-<reconcilerId>-<bucket>`: a DPoP proof jti was seen (idempotency key = jti). */
	DpopProofAccepted: "reconciler.DpopProofAccepted",
} as const);

// public-contract: agent-identity stream ids.
export const AGENT_STREAMS = Object.freeze({
	bootstrap: (tokenHash: string) => `cd-bootstrap-${tokenHash}`,
	dpop: (reconcilerId: string, bucket: number) => `cd-dpop-${reconcilerId}-${bucket}`,
});

// public-contract: schema id of agent-identity event bodies.
export const AGENT_EVENT_SCHEMA = "hobo.cd.agent-identity/v1" as const;
