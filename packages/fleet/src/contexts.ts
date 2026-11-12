/**
 * The signing and sealing contexts of the signed envelope (design §7.4).
 *
 * `signature = Sign(key, utf8(context) || 0x00 || payload)`. A verifier accepts
 * a record only under the one context listed for it; a change to what a record
 * means needs a new version suffix, never an edit to one of these strings.
 */

// public-contract: TrustRecord, signed by the authority and the witness.
export const TRUST_RECORD_CONTEXT = "hobo-fleet/trust-record/v1";
// public-contract: KeyBundle, signed by the device identity key.
export const KEY_BUNDLE_CONTEXT = "hobo-fleet/key-bundle/v1";
// public-contract: RotationStatement, signed by the old device identity key.
export const ROTATION_CONTEXT = "hobo-fleet/rotation/v1";
// public-contract: MemberRecord, signed by the authority.
export const MEMBER_RECORD_CONTEXT = "hobo-fleet/member-record/v1";
// public-contract: FleetRecord, signed by the authority.
export const FLEET_RECORD_CONTEXT = "hobo-fleet/fleet-record/v1";
// public-contract: FleetView, signed by the authority.
export const FLEET_VIEW_CONTEXT = "hobo-fleet/fleet-view/v1";
// public-contract: SessionTicket, signed by the authority.
export const SESSION_TICKET_CONTEXT = "hobo-fleet/session-ticket/v1";
// public-contract: SessionGrant, signed by the authority.
export const SESSION_GRANT_CONTEXT = "hobo-fleet/session-grant/v1";
// public-contract: WorkSubmission, signed by the authority.
export const WORK_SUBMISSION_CONTEXT = "hobo-fleet/work-submission/v1";
// public-contract: MemberControl, signed by the authority.
export const CONTROL_CONTEXT = "hobo-fleet/control/v1";
// public-contract: AuditCheckpoint, signed by the authority, then the witness.
export const AUDIT_CHECKPOINT_CONTEXT = "hobo-fleet/audit-checkpoint/v1";
// public-contract: ConnectProof, signed by the device SIGN key.
export const NATS_CONNECT_CONTEXT = "hobo-fleet/nats-connect/v1";
// public-contract: Observation, signed by the observer's SIGN key.
export const OBSERVATION_CONTEXT = "hobo-fleet/observation/v1";
// public-contract: Claim, signed by the device SIGN key.
export const CLAIM_CONTEXT = "hobo-fleet/claim/v1";
// public-contract: WorkReceipt, signed by the device SIGN key.
export const RECEIPT_CONTEXT = "hobo-fleet/receipt/v1";
// public-contract: WorkLogChunk, signed by the device SIGN key.
export const LOG_CONTEXT = "hobo-fleet/log/v1";
// public-contract: SessionClose, signed by the device SIGN key.
export const SESSION_CLOSE_CONTEXT = "hobo-fleet/session-close/v1";
// public-contract: WorkOffer, signed by a dispatcher's SIGN key.
export const OFFER_CONTEXT = "hobo-fleet/offer/v1";
// public-contract: WorkOrder, signed by a dispatcher's SIGN key.
export const ORDER_CONTEXT = "hobo-fleet/order/v1";
// public-contract: the @hobo/identity launch measurement as JSON bytes, signed by the device SIGN key.
export const HOST_ATTESTATION_CONTEXT = "hobo-fleet/host-attestation/v1";
// public-contract: the sealing context of an order's secret (associated data `order_id ‖ 0x00 ‖ member_id`).
export const ORDER_SECRET_CONTEXT = "hobo-fleet/order-secret/v1";

/** Exactly the context strings of the §7.4 table plus the order-secret sealing context. */
export const FLEET_CONTEXTS = [
	TRUST_RECORD_CONTEXT,
	KEY_BUNDLE_CONTEXT,
	ROTATION_CONTEXT,
	MEMBER_RECORD_CONTEXT,
	FLEET_RECORD_CONTEXT,
	FLEET_VIEW_CONTEXT,
	SESSION_TICKET_CONTEXT,
	SESSION_GRANT_CONTEXT,
	WORK_SUBMISSION_CONTEXT,
	CONTROL_CONTEXT,
	AUDIT_CHECKPOINT_CONTEXT,
	NATS_CONNECT_CONTEXT,
	OBSERVATION_CONTEXT,
	CLAIM_CONTEXT,
	RECEIPT_CONTEXT,
	LOG_CONTEXT,
	SESSION_CLOSE_CONTEXT,
	OFFER_CONTEXT,
	ORDER_CONTEXT,
	HOST_ATTESTATION_CONTEXT,
	ORDER_SECRET_CONTEXT,
] as const;
