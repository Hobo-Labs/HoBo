import {
	deepFreeze,
	requireNonEmptyString,
	requireRecord,
	SdkDeclarationError,
} from "./errors.js";
import { WAIVER_SCHEMA } from "./schema.js";

// Greenfield declaration factory (walkthrough §4.6): a waiver is a governed,
// time-boxed, separation-of-duties exception to a policy denial. The factory's
// authoring boundary parses and freezes the declaration. createWaiverService
// executes request/approval/authorization/expiry against the durable EventStore
// and the existing policy evaluator (waiver-chaos-execution.ts).

// domain-view: authored break-glass waiver; wire form is WaiverDeclaration in data-models/sdk.proto.
export interface WaiverDeclaration {
	readonly schema: string;
	/** The policy.Decided audit id being waived (walkthrough: "pol_7f31"). */
	readonly decisionId: string;
	readonly reason: string;
	/** role: / user: / spiffe: principal — never the author (SoD). */
	readonly approver: string;
	/** RFC 3339 expiry; the waiver auto-revokes. */
	readonly expires: string;
}

export interface WaiverSpec {
	reason: string;
	approver: string;
	expires: string;
}

const APPROVER_PATTERN = /^(role|user|spiffe):.+/;

export function waiver(
	decisionId: string,
	spec: WaiverSpec,
): WaiverDeclaration {
	requireNonEmptyString("waiver", "decisionId", decisionId);
	const record = requireRecord("waiver", "spec", spec);
	const reason = requireNonEmptyString("waiver", "reason", record.reason);
	const approver = requireNonEmptyString("waiver", "approver", record.approver);
	if (!APPROVER_PATTERN.test(approver)) {
		throw new SdkDeclarationError(
			"waiver",
			"approver",
			'must be a "role:", "user:", or "spiffe:" principal',
		);
	}
	const expires = requireNonEmptyString("waiver", "expires", record.expires);
	if (!Number.isFinite(Date.parse(expires))) {
		throw new SdkDeclarationError(
			"waiver",
			"expires",
			"must be an RFC 3339 timestamp",
		);
	}

	return deepFreeze({
		schema: WAIVER_SCHEMA,
		decisionId,
		reason,
		approver,
		expires,
	});
}
