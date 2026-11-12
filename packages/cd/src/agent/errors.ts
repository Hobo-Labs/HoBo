// Typed failure modes of the agent identity boundary (WP11, plan 0024). Every
// refusal carries a stable code, the HTTP status the delivery feed answers
// with, and a remediation an operator or agent can act on.
import { create } from "@bufbuild/protobuf";
import { type ReasonRecord, ReasonRecordSchema } from "../_generated/cd_pb.js";
import { ENROLLMENT_INCOMPLETE } from "../events.js";
import type { Refusal } from "../ports.js";

export type FailureSpec = Readonly<{ status: number; remediation: string }>;

// public-contract: refusal codes of `@hobo/cd/agent` with HTTP status and remediation.
export const AGENT_FAILURES = Object.freeze({
	"token-invalid": {
		status: 401,
		remediation:
			"Ask an operator for a new bootstrap token (`reconciler.enroll`); tokens are single-use and shown once.",
	},
	"token-expired": {
		status: 401,
		remediation:
			"The bootstrap token expired before use; issue a new one (default TTL 1 h, at most 24 h).",
	},
	"token-used": {
		status: 409,
		remediation:
			"Bootstrap tokens are single-use. If this agent already enrolled, keep its key; otherwise issue a new token.",
	},
	"token-scope-invalid": {
		status: 422,
		remediation:
			"Every Camp in a bootstrap token must belong to the named Camp set; fix the set or the Camp list.",
	},
	"token-ttl-invalid": {
		status: 422,
		remediation:
			"Choose a bootstrap token TTL between 1 ms and 24 h (default 1 h).",
	},
	"mode-invalid": {
		status: 422,
		remediation:
			"Only `agent` and `publisher` reconcilers enroll; conductors run inside the Station and need no enrollment.",
	},
	"jwk-invalid": {
		status: 422,
		remediation:
			"Send a public EC P-256 (ES256) or OKP Ed25519 (EdDSA) JWK with no private member `d`.",
	},
	"claim-invalid": {
		status: 422,
		remediation:
			"Claims are name/value pairs of non-empty strings, each name at most once.",
	},
	"key-already-enrolled": {
		status: 409,
		remediation:
			"This public key is already enrolled; reuse its reconciler or generate a new key pair.",
	},
	"key-revoked": {
		status: 403,
		remediation:
			"A revoked key can never re-enroll; generate a new key pair and enroll with a new bootstrap token.",
	},
	"reconciler-unknown": {
		status: 404,
		remediation:
			"No enrollment exists for this reconciler id; enroll with a bootstrap token first.",
	},
	"reconciler-revoked": {
		status: 403,
		remediation:
			"The reconciler was revoked; its SVID and key are no longer accepted. Re-enroll with a new key if this is unexpected.",
	},
	[ENROLLMENT_INCOMPLETE]: {
		status: 403,
		remediation:
			"Enrollment needs both grants (`reconciler.approve-key` and `reconciler.accept`) or a matching Rail auto-accept scope (I24).",
	},
	"separate-approvers-required": {
		status: 403,
		remediation:
			"The Rail sets `separate_approvers`: the second grant must come from a different principal than the first.",
	},
	"camp-out-of-scope": {
		status: 403,
		remediation:
			"Accept only Camps named by the bootstrap token's Camp-set scope; issue a new token for other Camps.",
	},
	"proposal-only": {
		status: 403,
		remediation:
			"Agent principals propose by default (ADR-0094); a granted human or service principal must perform this action.",
	},
	"policy-denied": {
		status: 403,
		remediation:
			"The delivery policy pack denied the action; read the decision and ask a principal the pack grants.",
	},
	"svid-required": {
		status: 401,
		remediation:
			"Send `Authorization: DPoP <JWT-SVID>` and a `DPoP` proof header; activate the reconciler first if it has no SVID.",
	},
	"svid-invalid": {
		status: 401,
		remediation:
			"The JWT-SVID failed verification (signature, issuer, audience or subject); re-activate with a DPoP proof.",
	},
	"svid-expired": {
		status: 401,
		remediation:
			"The SVID expired before it was refreshed; re-activate with a DPoP proof of the enrolled key.",
	},
	"dpop-required": {
		status: 401,
		remediation:
			"Every request carries a `DPoP` proof header (RFC 9449) signed by the enrolled key.",
	},
	"dpop-invalid": {
		status: 401,
		remediation:
			"The DPoP proof is malformed or its signature does not verify; sign a fresh `dpop+jwt` with the enrolled key.",
	},
	"dpop-method-mismatch": {
		status: 401,
		remediation: "Set the proof's `htm` to the request method.",
	},
	"dpop-url-mismatch": {
		status: 401,
		remediation:
			"Set the proof's `htu` to the request URL without query or fragment.",
	},
	"dpop-stale": {
		status: 401,
		remediation:
			"The proof's `iat` is outside ±60 s of the Station clock; fix the agent clock (NTP) and retry.",
	},
	"dpop-ath-mismatch": {
		status: 401,
		remediation:
			"Set `ath` to base64url(SHA-256(SVID)) of the SVID sent with the request.",
	},
	"dpop-replayed": {
		status: 401,
		remediation:
			"A DPoP proof is single-use; mint a fresh proof with a new `jti` for every request.",
	},
	"dpop-key-mismatch": {
		status: 401,
		remediation:
			"The proof key does not match the SVID's `cnf.jkt` or the enrolled key; sign with the enrolled private key.",
	},
	"store-unavailable": {
		status: 503,
		remediation:
			"The journal failed; retry with backoff and check storage health.",
	},
	"egress-refused": {
		status: 0,
		remediation:
			"Agent egress is restricted to the Station's delivery feed (`https://<station>/v1/cd/`); fix the configured base URL.",
	},
	"station-unavailable": {
		status: 0,
		remediation:
			"The Station did not answer; the agent backs off and retries. Check network egress to the Station.",
	},
	"response-invalid": {
		status: 0,
		remediation:
			"The Station answered with a body that does not match the feed contract; check Station and agent versions.",
	},
} satisfies Record<string, FailureSpec>);

export type AgentFailureCode = keyof typeof AGENT_FAILURES;

export function reasonOf(
	code: string,
	message: string,
	remediation: string,
	subject = "",
): ReasonRecord {
	return create(ReasonRecordSchema, { code, message, remediation, subject });
}

export function agentRefusal(
	code: AgentFailureCode,
	message: string,
	subject = "",
): Refusal {
	return {
		ok: false,
		reasons: [
			reasonOf(code, message, AGENT_FAILURES[code].remediation, subject),
		],
	};
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- SAFETY: JavaScript catch values are untrusted; only the message is read.
export function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
