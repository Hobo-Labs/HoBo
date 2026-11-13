// Typed failure modes of the outbound boundary (WP16, plan 0024 D17). Every
// code carries its remediation so an operator-facing caller (health, CLI,
// runbook) can say exactly what to do.

// public-contract: boundary failure codes with remediation.
export const BOUNDARY_FAILURES = Object.freeze({
	"webhook-endpoint-invalid": {
		remediation:
			"Set the webhook endpoint to an absolute https URL without credentials, query secrets or a fragment. Plain http is accepted only with allowInsecureHttp for a loopback receiver.",
	},
	"webhook-secret-missing": {
		remediation:
			"The signing secret reference did not resolve to a `secret` value. Store the HMAC secret under the configured secretRef in the credential store; HoBo never sends an unsigned webhook.",
	},
	"webhook-rejected": {
		remediation:
			"The receiver refused the delivery with a non-retryable status (4xx other than 408/425/429). Check the receiver's signature verification and route; the event was dead-lettered.",
	},
	"webhook-retries-exhausted": {
		remediation:
			"The receiver stayed unavailable for every attempt (408/425/429/5xx or transport errors). Check receiver health and capacity, then replay the dead-letter entry.",
	},
	"webhook-signature-invalid": {
		remediation:
			"The signature did not verify: the body was altered, the secret differs, or the header is malformed. Compare the receiver's secret with the configured secretRef.",
	},
	"webhook-timestamp-stale": {
		remediation:
			"The webhook-timestamp is outside the tolerance window, so the delivery may be a replay. Check clock sync on sender and receiver.",
	},
	"notification-channel-unknown": {
		remediation:
			"The notification names a channel with no configured sink. Add the channel to createNotificationPort({ channels }) or fix the channel name in the pipeline hook.",
	},
	"cdevent-invalid": {
		remediation:
			"A projected CDEvent failed the pinned-spec structural check. This is a projector bug: file it with the source event id; nothing was sent.",
	},
} as const);

export type BoundaryFailureCode = keyof typeof BOUNDARY_FAILURES;

export class BoundaryError extends Error {
	readonly code: BoundaryFailureCode;
	readonly remediation: string;
	readonly status: number | undefined;
	constructor(code: BoundaryFailureCode, message: string, status?: number) {
		super(`${code}: ${message}`);
		this.name = "BoundaryError";
		this.code = code;
		this.remediation = BOUNDARY_FAILURES[code].remediation;
		this.status = status;
	}
}
