/**
 * Claim-plane commands and events.
 *
 * Event payloads carry opaque references, control-plane-safe IDs, digests,
 * non-secret endpoint metadata, timestamps, and status codes. They never carry
 * claim URLs, tokens, connection strings, passwords, private keys, admin keys,
 * identity assertions, or raw environment variables — {@link assertNoSecrets}
 * is the enforcement point, not a convention.
 */
import {
	JWT_DETECTOR,
	PRIVATE_KEY_DETECTOR,
} from "@hobo/core/provider-redaction";
import type {
	ClaimAtomicity,
	ClaimBundle,
	ClaimItem,
	ClaimSubjectKind,
	CreatorAuthorityAfterClaim,
	GuestLease,
	Instant,
	PostClaimAction,
} from "./types.js";

export type ClaimCommand =
	| {
			readonly kind: "CompileDeploymentOffer";
			readonly deploymentRef: string;
			readonly offerId: string;
	  }
	| {
			readonly kind: "AcceptDeploymentOffer";
			readonly offerId: string;
			readonly offerDigest: string;
			readonly acceptedAt: Instant;
	  }
	| { readonly kind: "ReserveGuestLease"; readonly lease: GuestLease }
	| {
			readonly kind: "StartGuestDeployment";
			readonly deploymentRef: string;
			readonly idempotencyKey: string;
	  }
	| {
			readonly kind: "RecordProvisionedSubject";
			readonly subjectRef: string;
			readonly subjectKind: ClaimSubjectKind;
			readonly providerId: string;
			readonly idempotencyKey: string;
	  }
	| { readonly kind: "AttachClaimBundle"; readonly bundle: ClaimBundle }
	| {
			readonly kind: "RecordClaimAction";
			readonly itemId: string;
			readonly oneTimeActionRef: string;
			readonly deadline?: Instant;
	  }
	| {
			readonly kind: "BeginClaimBundle";
			readonly bundleId: string;
			readonly at: Instant;
	  }
	| {
			readonly kind: "BeginClaimItem";
			readonly itemId: string;
			readonly at: Instant;
	  }
	| {
			readonly kind: "ObserveClaimItem";
			readonly itemId: string;
			readonly observedStatus: "pending" | "claimed" | "expired";
			readonly at: Instant;
	  }
	| {
			readonly kind: "VerifyOwnership";
			readonly itemId: string;
			readonly verified: boolean;
			readonly evidenceRef: string;
			readonly creatorAuthorityAfterClaim: CreatorAuthorityAfterClaim;
	  }
	| {
			readonly kind: "RotateCapabilityBinding";
			readonly itemId: string;
			readonly bindingId: string;
	  }
	| {
			readonly kind: "RevokeBootstrapAuthority";
			readonly itemId: string;
			readonly evidenceRef: string;
	  }
	| {
			readonly kind: "AuthorizePostClaimAgent";
			readonly itemId: string;
			readonly granted: boolean;
	  }
	| {
			readonly kind: "BeginResourceMigration";
			readonly itemId: string;
			readonly migrationProfileRef: string;
	  }
	| {
			readonly kind: "RecordMigrationCheckpoint";
			readonly itemId: string;
			readonly checkpoint: string;
	  }
	| {
			readonly kind: "CommitConnectorCutover";
			readonly itemId: string;
			readonly connectorRef: string;
	  }
	| {
			readonly kind: "CompleteClaimItem";
			readonly itemId: string;
			readonly at: Instant;
	  }
	| {
			readonly kind: "CompleteClaimBundle";
			readonly bundleId: string;
			readonly at: Instant;
	  }
	| {
			readonly kind: "ExpireGuestLease";
			readonly leaseId: string;
			readonly at: Instant;
	  }
	| {
			readonly kind: "CompensateFailedClaim";
			readonly bundleId: string;
			readonly reason: string;
	  }
	| { readonly kind: "DestroyGuestDeployment"; readonly deploymentRef: string }
	| {
			readonly kind: "RetryRepairableClaim";
			readonly itemId: string;
			readonly at: Instant;
	  };

export type ClaimEvent =
	| {
			readonly type: "DeploymentOfferCompiled";
			readonly offerId: string;
			readonly offerDigest: string;
	  }
	| {
			readonly type: "DeploymentOfferAccepted";
			readonly offerId: string;
			readonly offerDigest: string;
			readonly at: Instant;
	  }
	| {
			readonly type: "GuestLeaseReserved";
			readonly leaseId: string;
			readonly expiresAt?: Instant;
			readonly claimBy?: Instant;
	  }
	| { readonly type: "GuestDeploymentStarted"; readonly deploymentRef: string }
	| {
			readonly type: "ProviderSubjectProvisioned";
			readonly subjectRef: string;
			readonly subjectKind: ClaimSubjectKind;
			readonly providerId: string;
	  }
	| {
			readonly type: "ClaimActionSecured";
			readonly itemId: string;
			readonly oneTimeActionRef: string;
			readonly deadline?: Instant;
	  }
	| { readonly type: "ClaimBundleStarted"; readonly bundleId: string }
	| { readonly type: "ClaimItemStarted"; readonly itemId: string }
	| {
			readonly type: "ClaimStatusObserved";
			readonly itemId: string;
			readonly observedStatus: string;
	  }
	| {
			readonly type: "OwnershipVerified";
			readonly itemId: string;
			readonly evidenceRef: string;
	  }
	| {
			readonly type: "CapabilityBindingRotationRequired";
			readonly itemId: string;
	  }
	| {
			readonly type: "CapabilityBindingRotated";
			readonly itemId: string;
			readonly bindingId: string;
	  }
	| {
			readonly type: "BootstrapAuthorityRevoked";
			readonly itemId: string;
			readonly evidenceRef: string;
	  }
	| {
			readonly type: "PostClaimAgentAuthorizationRequested";
			readonly itemId: string;
	  }
	| { readonly type: "PostClaimAgentAuthorized"; readonly itemId: string }
	| {
			readonly type: "ResourceMigrationStarted";
			readonly itemId: string;
			readonly migrationProfileRef: string;
	  }
	| {
			readonly type: "ResourceMigrationCheckpointRecorded";
			readonly itemId: string;
			readonly checkpoint: string;
	  }
	| { readonly type: "ResourceMigrationVerified"; readonly itemId: string }
	| {
			readonly type: "LogicalConnectorCutoverCommitted";
			readonly itemId: string;
			readonly connectorRef: string;
	  }
	| {
			readonly type: "ClaimItemCompleted";
			readonly itemId: string;
			readonly at: Instant;
	  }
	| {
			readonly type: "ClaimBundleCompleted";
			readonly bundleId: string;
			readonly at: Instant;
	  }
	| {
			readonly type: "GuestLeaseExpired";
			readonly leaseId: string;
			readonly at: Instant;
	  }
	| {
			readonly type: "ClaimCompensationStarted";
			readonly bundleId: string;
			readonly reason: string;
	  }
	| { readonly type: "ClaimCompensationCompleted"; readonly bundleId: string }
	| {
			readonly type: "GuestDeploymentDestroyed";
			readonly deploymentRef: string;
	  }
	| {
			readonly type: "ClaimRepairRequested";
			readonly itemId: string;
			readonly failureCode: string;
	  };

/** Patterns that must never reach a durable event payload. */
const FORBIDDEN_IN_EVENTS: readonly {
	readonly label: string;
	readonly pattern: RegExp;
}[] = [
	{
		label: "connection string",
		pattern:
			/\b(?:postgres(?:ql)?|mysql|rediss?|mongodb(?:\+srv)?|amqps?):\/\//iu,
	},
	{ label: "bearer token", pattern: /\bBearer\s+[A-Za-z0-9._-]{8,}/iu },
	{ label: "private key", pattern: PRIVATE_KEY_DETECTOR },
	{ label: "jwt", pattern: JWT_DETECTOR },
	{
		label: "api key",
		pattern: /\b(?:sk|pk|ghp|gho|xox[abpsr])[-_][A-Za-z0-9_-]{12,}/u,
	},
	{
		label: "password assignment",
		pattern: /\b(?:password|passwd|secret|admin_key|adminKey)\s*[:=]\s*\S/iu,
	},
	{
		label: "claim url",
		// The first `http(s)://` in a run, the first `claim`/`transfer` word after
		// it, the first `?`/`#` after that, and a credential parameter after
		// that: each part stops at its first occurrence, so the search is linear
		// where `\S*` before each part was not.
		pattern:
			/(?<!\S)(?:(?!https?:\/\/)\S)*https?:\/\/(?:(?!\b(?:claim|transfer)\b)\S)*\b(?:claim|transfer)\b[^\s?#]*[?#](?:(?!(?:token|code|key)=)\S)*(?:token|code|key)=/iu,
	},
];

export class EventSecretLeakError extends Error {
	readonly code = "EVENT_SECRET_LEAK" as const;

	constructor(label: string, eventType: string) {
		super(
			`refusing to append ${eventType}: payload contains what looks like a ${label}; store a reference instead`,
		);
		this.name = "EventSecretLeakError";
	}
}

/**
 * Guard invoked before appending any claim event.
 *
 * This is deliberately a hard failure rather than a redaction: silently
 * scrubbing a payload would hide the bug that produced it.
 */
export function assertNoSecrets(event: ClaimEvent): void {
	const serialized = JSON.stringify(event);
	for (const { label, pattern } of FORBIDDEN_IN_EVENTS) {
		if (pattern.test(serialized)) {
			throw new EventSecretLeakError(label, event.type);
		}
	}
}

/** Post-claim obligations that must finish before an item may complete. */
export function outstandingObligations(
	item: ClaimItem,
): readonly PostClaimAction[] {
	const done = new Set(item.completedPostClaimActions);
	return item.postClaimActions.filter((action) => !done.has(action));
}

export function claimAtomicityOf(items: readonly ClaimItem[]): ClaimAtomicity {
	if (items.length <= 1) return "single-resource";
	const providers = new Set(items.map((item) => item.providerId));
	// One provider presenting one ceremony is bundled; two providers each with
	// their own expiring action is a saga, and pretending otherwise is how a
	// partial claim gets reported as success.
	return providers.size === 1 ? "provider-bundled" : "best-effort-saga";
}
