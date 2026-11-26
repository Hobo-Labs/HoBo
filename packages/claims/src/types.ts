/**
 * Durable guest-deployment, lease, and claim contracts.
 *
 * An anonymous deployment is not "a normal resource plus a claim URL string".
 * It is a lease with an expiry the provider owns, a bundle of typed ownership
 * transitions, and a set of post-claim obligations that gate completion.
 */

export type Instant = number;

export type ClaimSubjectKind =
	| "yard"
	| "camp"
	| "resource"
	| "connector"
	| "bindle"
	| "agent-principal";

export type OwnershipTransitionMode =
	| "account-claim"
	| "organization-claim"
	| "workspace-claim"
	| "project-transfer"
	| "site-claim"
	| "resource-claim"
	| "credential-exchange"
	| "explicit-user-reauthorization"
	| "migration"
	| "none";

export type BootstrapClass =
	| "public-anonymous"
	| "anonymous-claimable"
	| "proof-of-work"
	| "capability-token"
	| "agent-self-registration"
	| "wallet"
	| "sponsor"
	| "local"
	| "preauthenticated-agent"
	| "self-hosted-hobo";

export type EndpointContinuity =
	| "preserved"
	| "rebound"
	| "changed"
	| "not-applicable";
export type DataContinuity =
	| "preserved"
	| "migrated"
	| "discarded"
	| "not-applicable";
export type CredentialContinuity =
	| "revoked"
	| "rotated"
	| "reauthorized"
	| "retained"
	| "unknown"
	| "not-applicable";

export type CreatorAuthorityAfterClaim =
	| "absent"
	| "reauthorization-required"
	| "rotatable"
	| "retained"
	| "unknown";

export type ClaimAtomicity =
	| "single-resource"
	| "provider-bundled"
	| "best-effort-saga";

export type GuestLeaseStatus =
	| "provisioning"
	| "active"
	| "claiming"
	| "claimed-needs-reauthorization"
	| "owner-controlled"
	| "owner-and-agent-controlled"
	| "expired"
	| "compensating"
	| "destroyed"
	| "failed";

export type GuestLeaseCleanupPolicy =
	| "delete"
	| "retain-until-provider-expiry"
	| "transfer"
	| "migrate";

export type GuestLease = {
	readonly schemaVersion: "hobo.guest-lease/v1";
	readonly id: string;
	readonly subjectRef: string;
	readonly bootstrapStrategyRef: string;
	readonly bootstrapClass: BootstrapClass;
	readonly createdAt: Instant;
	/** Provider-reported expiry. Never a locally invented duration. */
	readonly expiresAt?: Instant;
	readonly claimBy?: Instant;
	readonly renewable: boolean;
	readonly maximumRenewals?: number;
	readonly renewalCount: number;
	readonly quotaRef?: string;
	readonly costCapRef?: string;
	readonly cleanupPolicy: GuestLeaseCleanupPolicy;
	readonly status: GuestLeaseStatus;
	readonly observedProviderVersion?: string;
	/** Monotonic fence. A stale worker cannot act after this advances. */
	readonly fencingToken: string;
};

export type PostClaimAction =
	| "rotate-binding"
	| "revoke-bootstrap-authority"
	| "reauthorize-agent"
	| "verify-health"
	| "migrate-data";

export type ClaimItemStatus =
	| "pending"
	| "in-progress"
	| "observed"
	| "verified"
	| "needs-rotation"
	| "completed"
	| "expired"
	| "repairable-failure"
	| "compensating"
	| "failed";

export type ClaimItem = {
	readonly id: string;
	readonly subjectRef: string;
	readonly subjectKind: ClaimSubjectKind;
	readonly providerId: string;
	readonly claimStrategyRef: string;
	readonly mode: OwnershipTransitionMode;
	/** Opaque handle into the one-time action store. Never the URL itself. */
	readonly oneTimeActionRef?: string;
	readonly deadline?: Instant;
	readonly continuity: {
		readonly endpoint: EndpointContinuity;
		readonly data: DataContinuity;
		readonly credentials: CredentialContinuity;
	};
	readonly creatorAuthorityAfterClaim: CreatorAuthorityAfterClaim;
	readonly verificationRef: string;
	readonly postClaimActions: readonly PostClaimAction[];
	readonly completedPostClaimActions: readonly PostClaimAction[];
	readonly status: ClaimItemStatus;
	readonly evidenceRef?: string;
	readonly failureCode?: string;
};

export type ClaimDependency = {
	readonly fromItemId: string;
	readonly toItemId: string;
};

export type ClaimBundleStatus =
	| "pending"
	| "in-progress"
	| "partially-claimed"
	| "claimed-needs-remediation"
	| "complete"
	| "expired"
	| "compensating"
	| "failed";

export type ClaimBundle = {
	readonly schemaVersion: "hobo.claim-bundle/v1";
	readonly id: string;
	readonly deploymentRef: string;
	readonly items: readonly ClaimItem[];
	readonly dependencyEdges: readonly ClaimDependency[];
	readonly atomicity: ClaimAtomicity;
	readonly earliestDeadline?: Instant;
	readonly compensation: {
		readonly onTimeout: "destroy" | "retain-until-provider-expiry";
		readonly onPartialClaim:
			| "rollback-when-supported"
			| "continue-and-repair"
			| "migrate";
		readonly rollbackWindowMs?: number;
	};
	readonly status: ClaimBundleStatus;
};

/** The shared lifecycle every guest deployment moves through. */
export type GuestDeploymentState =
	| "Offered"
	| "Accepted"
	| "Provisioning"
	| "UnclaimedActive"
	| "ClaimPending"
	| "ClaimedNeedsVerification"
	| "ClaimedNeedsRotation"
	| "OwnerControlled"
	| "OwnerAndAgentControlled"
	| "RepairableFailure"
	| "Expired"
	| "Compensating"
	| "Destroyed";

export type MigrationState =
	| "MigrationRequired"
	| "DestinationProvisioning"
	| "SourceQuiescing"
	| "Exporting"
	| "Importing"
	| "Verifying"
	| "CutoverReady"
	| "CutoverCommitted"
	| "SourceRetiring"
	| "OwnerControlled";

/** Stable error codes shared across the claim plane. */
export const CLAIM_ERROR_CODES = [
	"CONSENT_REQUIRED",
	"LEASE_EXPIRED",
	"CLAIM_EXPIRED",
	"CLAIM_NOT_VERIFIED",
	"CLAIM_PARTIALLY_COMPLETED",
	"CLAIM_REPAIR_REQUIRED",
	"BINDING_ROTATION_REQUIRED",
	"BOOTSTRAP_AUTHORITY_REMAINS",
	"ONE_TIME_ACTION_EXPIRED",
	"ONE_TIME_ACTION_REPLAYED",
	"MIGRATION_FAILED",
	"MIGRATION_VERIFICATION_FAILED",
	"CONNECTOR_CUTOVER_FAILED",
	"CLEANUP_FAILED",
	"PROVISIONING_CONFLICT",
	"STALE_FENCE",
	"ANONYMOUS_QUOTA_EXCEEDED",
	"SPONSOR_BUDGET_EXCEEDED",
] as const;

export type ClaimErrorCode = (typeof CLAIM_ERROR_CODES)[number];

export class ClaimError extends Error {
	readonly code: ClaimErrorCode;

	constructor(code: ClaimErrorCode, message: string) {
		super(message);
		this.name = "ClaimError";
		this.code = code;
	}
}
