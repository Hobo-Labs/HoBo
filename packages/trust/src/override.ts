/**
 * The audited escape hatch.
 *
 * An operator can accept a provider the evidence does not vouch for, but only
 * by naming themselves, the reason, the exact reason codes being waived, and an
 * expiry. The resulting record never sets `selectable`: automatic selection
 * keeps ignoring the adapter, and only a caller that explicitly consults
 * `manuallyAuthorized` can act on the override.
 */
import { sha256Of } from "./canonical.js";
import type { TrustReasonCode, TrustVerdict } from "./evaluate.js";

// public-contract: audited operator override schema identifier used by manual authorization.
export const TRUST_OVERRIDE_SCHEMA_VERSION = "hobo.trust-override/v1";

export type OperatorOverrideInput = {
	readonly schemaVersion: typeof TRUST_OVERRIDE_SCHEMA_VERSION;
	readonly operatorId: string;
	readonly reason: string;
	readonly grantedAtMs: number;
	readonly expiresAtMs: number;
	/** Exactly the codes this override waives. Anything else still gates. */
	readonly waivedCodes: readonly TrustReasonCode[];
	readonly ticketRef?: string;
};

// parallel-type-allowed: the audited override as applyOperatorOverride constructs it — the only constructor — with waived codes carrying the TrustReasonCode union; hobo.trust.v1.OperatorOverrideRecord is its persisted projection.
export type OperatorOverrideRecord = {
	readonly schemaVersion: typeof TRUST_OVERRIDE_SCHEMA_VERSION;
	readonly operatorId: string;
	readonly reason: string;
	readonly grantedAtMs: number;
	readonly expiresAtMs: number;
	readonly waivedCodes: readonly TrustReasonCode[];
	readonly ticketRef?: string;
	readonly active: boolean;
	/** Reason codes the override did not cover, in verdict order. */
	readonly unwaivedCodes: readonly TrustReasonCode[];
	readonly recordDigest: string;
};

export type OverriddenTrustVerdict = TrustVerdict & {
	/**
	 * Never true. An override is an operator accepting a known risk, not
	 * evidence appearing, so the automatic path must keep seeing `false`.
	 */
	readonly selectable: false;
	/** True only when an active override waives every recorded reason code. */
	readonly manuallyAuthorized: boolean;
	readonly override: OperatorOverrideRecord;
};

export class OperatorOverrideError extends Error {
	readonly code = "INVALID_TRUST_OVERRIDE" as const;

	constructor(message: string) {
		super(message);
		this.name = "OperatorOverrideError";
	}
}

/** An override may not outlive the operator's memory of granting it. */
export const MAXIMUM_OVERRIDE_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;

const MINIMUM_REASON_LENGTH = 12;

/**
 * Record an override against a verdict.
 *
 * Applying an override to a verdict that already passed is rejected: a silent
 * "override" on a clean verdict is exactly the audit-trail pollution this path
 * exists to avoid.
 */
export function applyOperatorOverride(
	verdict: TrustVerdict,
	override: OperatorOverrideInput,
): OverriddenTrustVerdict {
	if (override.schemaVersion !== TRUST_OVERRIDE_SCHEMA_VERSION) {
		throw new OperatorOverrideError(
			`unsupported override schemaVersion ${String(override.schemaVersion)}`,
		);
	}
	if (verdict.selectable) {
		throw new OperatorOverrideError(
			"refusing to record an override for a verdict that already passed every gate",
		);
	}
	if (override.operatorId.trim().length === 0) {
		throw new OperatorOverrideError(
			"an override must name the operator granting it",
		);
	}
	if (override.reason.trim().length < MINIMUM_REASON_LENGTH) {
		throw new OperatorOverrideError(
			`an override reason must be at least ${MINIMUM_REASON_LENGTH} characters of actual justification`,
		);
	}
	if (
		!Number.isInteger(override.grantedAtMs) ||
		!Number.isInteger(override.expiresAtMs) ||
		override.expiresAtMs <= override.grantedAtMs
	) {
		throw new OperatorOverrideError(
			"an override must have integer instants with expiresAtMs after grantedAtMs",
		);
	}
	if (
		override.expiresAtMs - override.grantedAtMs >
		MAXIMUM_OVERRIDE_WINDOW_MS
	) {
		throw new OperatorOverrideError(
			`an override may not last longer than ${MAXIMUM_OVERRIDE_WINDOW_MS}ms`,
		);
	}
	if (override.waivedCodes.length === 0) {
		throw new OperatorOverrideError(
			"an override must enumerate the reason codes it waives; blanket overrides are not expressible",
		);
	}

	const waived = [...new Set(override.waivedCodes)].sort((a, b) =>
		a.localeCompare(b),
	);
	const recorded = [
		...new Set(verdict.reasons.map((reason) => reason.code)),
	].sort((a, b) => a.localeCompare(b));
	const unwaivedCodes = recorded.filter((code) => !waived.includes(code));
	const active =
		verdict.evaluatedAtMs >= override.grantedAtMs &&
		verdict.evaluatedAtMs < override.expiresAtMs;

	const record: Omit<OperatorOverrideRecord, "recordDigest"> = {
		schemaVersion: TRUST_OVERRIDE_SCHEMA_VERSION,
		operatorId: override.operatorId,
		reason: override.reason,
		grantedAtMs: override.grantedAtMs,
		expiresAtMs: override.expiresAtMs,
		waivedCodes: waived,
		...(override.ticketRef !== undefined
			? { ticketRef: override.ticketRef }
			: {}),
		active,
		unwaivedCodes,
	};

	const recordDigest = sha256Of({
		...record,
		waivedCodes: [...record.waivedCodes],
		unwaivedCodes: [...record.unwaivedCodes],
		verdictDigest: verdict.verdictDigest,
	});

	return {
		...verdict,
		selectable: false,
		manuallyAuthorized: active && unwaivedCodes.length === 0,
		override: { ...record, recordDigest },
	};
}

/** Narrowing helper: did this verdict travel through the audited path? */
export function isOverriddenTrustVerdict(
	verdict: TrustVerdict | OverriddenTrustVerdict,
): verdict is OverriddenTrustVerdict {
	return "override" in verdict;
}
