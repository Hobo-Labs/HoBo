/**
 * `assertNoSecrets` as it stood on the base branch (169d87fcf819), copied by a
 * script with only the declarations it reaches, as the oracle the differential
 * test holds the shared detectors to. Not edited by hand; do not import it from src.
 */
import type { ClaimSubjectKind, Instant } from "../../src/types.js";

type ClaimEvent =
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
	{ label: "private key", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/u },
	{ label: "jwt", pattern: /\bey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./u },
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
		pattern:
			/https?:\/\/\S*\b(?:claim|transfer)\b\S*[?#]\S*(?:token|code|key)=/iu,
	},
];

class EventSecretLeakError extends Error {
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
