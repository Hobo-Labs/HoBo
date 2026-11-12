// Typed failure modes of the delivery feed (WP11, plan 0024). Each code has
// the HTTP status the feed answers with and a remediation. Agent-identity
// codes (SVID, DPoP, enrollment) live in ../agent/errors.ts.
import { AGENT_FAILURES, type FailureSpec, reasonOf } from "../agent/errors.js";
import type { Refusal } from "../ports.js";

// public-contract: refusal codes of `@hobo/cd/feed` with HTTP status and remediation.
export const FEED_FAILURES = Object.freeze({
	"request-invalid": {
		status: 400,
		remediation:
			"Send the JSON body the feed contract (contracts/feed.pact.json) defines for this route.",
	},
	"route-unknown": {
		status: 404,
		remediation: "Use a `/v1/cd/` route listed in the feed README.",
	},
	"method-not-allowed": {
		status: 405,
		remediation: "Use the method the route defines.",
	},
	"body-too-large": {
		status: 413,
		remediation:
			"Request bodies are limited to 1 MiB; report fewer resources per observation.",
	},
	"camp-not-accepted": {
		status: 403,
		remediation:
			"The reconciler is not accepted for this Camp; grant `reconciler.accept` for it (within the token scope).",
	},
	"lease-held": {
		status: 409,
		remediation:
			"Another reconciler holds the Camp lease (I4); wait for expiry or revoke that reconciler.",
	},
	"stale-fence": {
		status: 409,
		remediation:
			"This lease was taken over or expired; claim the Camp again before writing.",
	},
	"lease-mismatch": {
		status: 403,
		remediation:
			"A lease is used only by the reconciler that claimed it; claim your own lease.",
	},
	"checkpoint-regression": {
		status: 409,
		remediation:
			"A checkpoint behind the committed one is refused; resume from the committed position.",
	},
	"lease-unsupported": {
		status: 501,
		remediation:
			"Run the Station on an event store with durable subscription leases (SQLite or Postgres).",
	},
	"store-unavailable": {
		status: 503,
		remediation:
			"The journal failed; retry with backoff and check storage health.",
	},
	"blob-missing": {
		status: 404,
		remediation:
			"Restore the resolved-set blob into the artifact store or re-apply the Set.",
	},
	"blob-corrupt": {
		status: 409,
		remediation:
			"The stored blob does not match its digest; restore it from a verified copy (promotion never rebuilds, I1).",
	},
	"blob-not-referenced": {
		status: 403,
		remediation:
			"Only blobs referenced by a Set of an accepted Camp are served; pass that Camp.",
	},
	"observation-invalid": {
		status: 422,
		remediation:
			"Stamp the observation with the lease's Camp, reconciler id and fence token.",
	},
	"attribute-oversize": {
		status: 413,
		remediation:
			"Reported attributes are bounded to 16 KiB per resource; narrow the posture packs' observe_fields.",
	},
	"attribute-undeclared": {
		status: 422,
		remediation:
			"Report only the attribute paths in the frame's `observe_fields` (D25).",
	},
	"report-refused": {
		status: 503,
		remediation:
			"The status stream kept changing under a single-writer lease; retry the report.",
	},
	"resolved-set-missing": {
		status: 404,
		remediation:
			"Restore the resolved-set blob into the artifact store; the Camp stays blocked until it verifies.",
	},
	"resolved-set-mismatch": {
		status: 409,
		remediation:
			"The resolved set does not match the Set's digest or content hash; restore the original blob or re-promote.",
	},
} satisfies Record<string, FailureSpec>);

export type FeedFailureCode = keyof typeof FEED_FAILURES;

export function feedRefusal(
	code: FeedFailureCode,
	message: string,
	subject = "",
): Refusal {
	return {
		ok: false,
		reasons: [
			reasonOf(code, message, FEED_FAILURES[code].remediation, subject),
		],
	};
}

/** HTTP status for any refusal code the feed can return. */
const FEED_STATUS: ReadonlyMap<string, number> = new Map(
	Object.entries(FEED_FAILURES).map(([code, spec]) => [code, spec.status]),
);
const AGENT_STATUS: ReadonlyMap<string, number> = new Map(
	Object.entries(AGENT_FAILURES).map(([code, spec]) => [code, spec.status]),
);

export function statusFor(code: string): number {
	const feed = FEED_STATUS.get(code);
	if (feed !== undefined) return feed;
	const agent = AGENT_STATUS.get(code);
	if (agent !== undefined) return agent === 0 ? 400 : agent;
	return 403;
}
