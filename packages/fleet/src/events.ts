/**
 * The `fleet.*` event family (design §7.5): event type names, the two fixed
 * stream ids, and the log event names (`FleetLogEvent`). The per-entity stream
 * ids (`fleet-member-<MemberId>` and the rest) are the patterns of the §7.5
 * table; the lanes that write each stream build them.
 *
 * Streams are on the core `EventStore` port. Every name here is a stored or
 * logged contract: projections replay by these strings, so a meaning change is
 * a new event type, never an edit.
 */
// public-contract: every array below is the stored and logged vocabulary of §7.5.
/** Events of the `token` streams. */
export const FLEET_TOKEN_EVENTS = [
	"fleet.TokenIssued",
	"fleet.TokenConsumed",
	"fleet.TokenRevoked",
] as const;

/** Events of the `thumbprint` streams. */
export const FLEET_THUMBPRINT_EVENTS = ["fleet.ThumbprintBound"] as const;

/** Events of the `member` streams. */
export const FLEET_MEMBER_EVENTS = [
	"fleet.EnrollmentRequested",
	"fleet.MemberDeclared",
	"fleet.KeyApproved",
	"fleet.EnrollmentAccepted",
	"fleet.EnrollmentRejected",
	"fleet.MemberActivated",
	"fleet.MembershipAssigned",
	"fleet.CredentialsIssued",
	"fleet.KeysRotated",
	"fleet.IdentityKeyRotated",
	"fleet.MemberSuspended",
	"fleet.MemberResumed",
	"fleet.MemberLocked",
	"fleet.MemberUnlocked",
	"fleet.MemberRevoked",
	"fleet.ViolationReported",
] as const;

/** Events of the `fleet` streams. */
export const FLEET_FLEET_EVENTS = [
	"fleet.FleetDefined",
	"fleet.FleetPolicyChanged",
] as const;

/** Events of the `signin` streams. */
export const FLEET_SIGN_IN_EVENTS = [
	"fleet.SignInStarted",
	"fleet.SignInAuthenticated",
	"fleet.SignInApproved",
	"fleet.SignInCompleted",
] as const;

/** Events of the `person` streams. */
export const FLEET_PERSON_EVENTS = ["fleet.PersonSignedIn"] as const;

/** Events of the `session` streams. */
export const FLEET_SESSION_EVENTS = [
	"fleet.SessionGranted",
	"fleet.SessionClosed",
] as const;

/** Events of the `work` streams. */
export const FLEET_WORK_EVENTS = [
	"fleet.WorkSubmitted",
	"fleet.WorkOffered",
	"fleet.WorkClaimed",
	"fleet.WorkOrdered",
	"fleet.WorkStarted",
	"fleet.WorkSucceeded",
	"fleet.WorkFailed",
	"fleet.WorkCancelled",
	"fleet.WorkAbandoned",
	"fleet.WorkRefused",
] as const;

/** Events of the `trust` streams. */
export const FLEET_TRUST_EVENTS = ["fleet.TrustRotated"] as const;

/** Events of the `audit` streams. */
export const FLEET_AUDIT_EVENTS = ["fleet.AuditCheckpointed"] as const;

/** Every `fleet.*` event type of §7.5, in table order. */
export const FLEET_EVENT_TYPES = [
	...FLEET_TOKEN_EVENTS,
	...FLEET_THUMBPRINT_EVENTS,
	...FLEET_MEMBER_EVENTS,
	...FLEET_FLEET_EVENTS,
	...FLEET_SIGN_IN_EVENTS,
	...FLEET_PERSON_EVENTS,
	...FLEET_SESSION_EVENTS,
	...FLEET_WORK_EVENTS,
	...FLEET_TRUST_EVENTS,
	...FLEET_AUDIT_EVENTS,
] as const;

/**
 * The log event names of §7.5: `hobo_fleet_<snake_case>` for each `fleet.<PascalCase>`
 * event above, then the operational names that have no stream.
 */
export const FLEET_LOG_EVENTS = [
	"hobo_fleet_token_issued",
	"hobo_fleet_token_consumed",
	"hobo_fleet_token_revoked",
	"hobo_fleet_thumbprint_bound",
	"hobo_fleet_enrollment_requested",
	"hobo_fleet_member_declared",
	"hobo_fleet_key_approved",
	"hobo_fleet_enrollment_accepted",
	"hobo_fleet_enrollment_rejected",
	"hobo_fleet_member_activated",
	"hobo_fleet_membership_assigned",
	"hobo_fleet_credentials_issued",
	"hobo_fleet_keys_rotated",
	"hobo_fleet_identity_key_rotated",
	"hobo_fleet_member_suspended",
	"hobo_fleet_member_resumed",
	"hobo_fleet_member_locked",
	"hobo_fleet_member_unlocked",
	"hobo_fleet_member_revoked",
	"hobo_fleet_violation_reported",
	"hobo_fleet_fleet_defined",
	"hobo_fleet_fleet_policy_changed",
	"hobo_fleet_sign_in_started",
	"hobo_fleet_sign_in_authenticated",
	"hobo_fleet_sign_in_approved",
	"hobo_fleet_sign_in_completed",
	"hobo_fleet_person_signed_in",
	"hobo_fleet_session_granted",
	"hobo_fleet_session_closed",
	"hobo_fleet_work_submitted",
	"hobo_fleet_work_offered",
	"hobo_fleet_work_claimed",
	"hobo_fleet_work_ordered",
	"hobo_fleet_work_started",
	"hobo_fleet_work_succeeded",
	"hobo_fleet_work_failed",
	"hobo_fleet_work_cancelled",
	"hobo_fleet_work_abandoned",
	"hobo_fleet_work_refused",
	"hobo_fleet_trust_rotated",
	"hobo_fleet_audit_checkpointed",
	"hobo_fleet_bus_status",
	"hobo_fleet_observation_rejected",
	"hobo_fleet_offer_unfit",
	"hobo_fleet_claims_unreachable",
	"hobo_fleet_claim_discarded",
	"hobo_fleet_capacity",
	"hobo_fleet_capacity_exhausted",
	"hobo_fleet_capacity_restored",
	"hobo_fleet_callout_refused",
	"hobo_fleet_transport_selected",
	"hobo_fleet_sandbox_unavailable",
	"hobo_fleet_update_required",
	"hobo_fleet_clock_skew",
	"hobo_fleet_assignment_tick",
	"hobo_fleet_assignment_sealed_too_long",
	"hobo_fleet_witness_lag",
	"hobo_fleet_witness_refused",
] as const;

export type FleetEventType = (typeof FLEET_EVENT_TYPES)[number];

// public-contract: the core policy event every governed action appends (ADR-0136); never retried.
export const POLICY_DECIDED_EVENT = "policy.Decided";

// public-contract: the single trust-rotation stream.
export const FLEET_TRUST_STREAM = "fleet-trust";
// public-contract: the single audit-chain stream.
export const FLEET_AUDIT_STREAM = "fleet-audit";
