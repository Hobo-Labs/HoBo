// The incarnation rule (design §6.16, §7.6 `incarnation-stale`): a session
// ticket or registry record signed before the last restore names an older
// authority incarnation than the pinned trust record, and is refused. Private
// to L27; the authority and the callout apply the same rule.
import { fromBinary } from "@bufbuild/protobuf";
import {
	KeyPurpose,
	MEMBER_RECORD_CONTEXT,
	MemberRecordSchema,
	type Outcome,
	SESSION_TICKET_CONTEXT,
	SessionTicketSchema,
	type SignedEnvelope,
	type TrustRecord,
} from "@hobo/fleet";
import { verifyEnvelope } from "@hobo/fleet/keys";

/** Verifies a session ticket or member record against `trust` and refuses one from an earlier incarnation. */
export function checkIncarnation(
	envelope: SignedEnvelope,
	trust: TrustRecord,
): Outcome<number> {
	const key = trust.authorityKeys.find(
		(candidate) =>
			candidate.keyId === envelope.keyId &&
			candidate.purpose === KeyPurpose.AUTHORITY,
	);
	const context =
		envelope.context === SESSION_TICKET_CONTEXT
			? SESSION_TICKET_CONTEXT
			: envelope.context === MEMBER_RECORD_CONTEXT
				? MEMBER_RECORD_CONTEXT
				: undefined;
	if (
		key === undefined ||
		context === undefined ||
		!verifyEnvelope(envelope, context, key)
	)
		return {
			ok: false,
			error: {
				code: "proof-invalid",
				message: "the credential does not verify against the trust record",
			},
		};
	const incarnation =
		context === SESSION_TICKET_CONTEXT
			? fromBinary(SessionTicketSchema, envelope.payload).authorityIncarnation
			: fromBinary(MemberRecordSchema, envelope.payload).authorityIncarnation;
	if (incarnation < trust.authorityIncarnation)
		return {
			ok: false,
			error: {
				code: "incarnation-stale",
				message: `issued in authority incarnation ${incarnation}; the authority is in incarnation ${trust.authorityIncarnation}`,
			},
		};
	return { ok: true, value: incarnation };
}
