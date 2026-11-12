// D18 retention decision. Pure: the ledger gathers the inputs from the
// journal and appends `freight.Retired` for what this returns. No clock, no
// I/O; the same inputs in any order give the same decision (I8).
import { CD_DEFAULTS } from "../events.js";

// public-contract: label key that always places Freight under legal hold, in
// addition to any key a RetentionPolicyRecord lists.
export const LEGAL_HOLD_LABEL = "hobo.cd/legal-hold" as const;

export type RetentionKeepReason =
	| "deployed"
	| "rollback-depth"
	| "legal-hold"
	| "in-flight-promotion"
	| "approval"
	| "young";

export type RetentionCandidate = Readonly<{
	freightId: string;
	bindle: string;
	recordedAtMs: number;
	labels: Readonly<Record<string, string>>;
}>;

/** One Camp's Set history, oldest first: the last entry is what the Camp runs now. */
export type CampDeployments = Readonly<{
	campId: string;
	freightIds: readonly string[];
}>;

export type RetentionPin = Readonly<{
	freightId: string;
	reason: "in-flight-promotion" | "approval";
}>;

export type RetentionPolicy = Readonly<{
	/** Empty sweeps every Bindle. */
	bindle: string;
	/** 0 reads as CD_DEFAULTS.retentionKeepPerCamp. */
	keepPerCamp: number;
	/** 0 reads as CD_DEFAULTS.retentionKeepUnpromotedMs. */
	keepUnpromotedMs: number;
	/** Label keys (`key`) or exact pairs (`key=value`). */
	legalHoldLabels: readonly string[];
}>;

export type RetentionInput = Readonly<{
	policy: RetentionPolicy;
	nowMs: number;
	candidates: readonly RetentionCandidate[];
	deployments: readonly CampDeployments[];
	pinned: readonly RetentionPin[];
}>;

export type RetentionPlan = Readonly<{
	retire: readonly string[];
	kept: readonly Readonly<{ freightId: string; reason: RetentionKeepReason }>[];
}>;

function underHold(
	labels: Readonly<Record<string, string>>,
	holds: readonly string[],
): boolean {
	if (Object.hasOwn(labels, LEGAL_HOLD_LABEL)) return true;
	return holds.some((hold) => {
		const at = hold.indexOf("=");
		if (at < 0) return Object.hasOwn(labels, hold);
		return labels[hold.slice(0, at)] === hold.slice(at + 1);
	});
}

export function planRetention(input: RetentionInput): RetentionPlan {
	const keepPerCamp =
		input.policy.keepPerCamp > 0
			? input.policy.keepPerCamp
			: CD_DEFAULTS.retentionKeepPerCamp;
	const keepMs =
		input.policy.keepUnpromotedMs > 0
			? input.policy.keepUnpromotedMs
			: CD_DEFAULTS.retentionKeepUnpromotedMs;
	const reasons = new Map<string, RetentionKeepReason>();
	const mark = (freightId: string, why: RetentionKeepReason) => {
		if (!reasons.has(freightId)) reasons.set(freightId, why);
	};
	for (const camp of input.deployments) {
		const history = camp.freightIds;
		const current = history.at(-1);
		if (current) mark(current, "deployed");
	}
	for (const camp of input.deployments) {
		for (const freightId of camp.freightIds.slice(-(keepPerCamp + 1), -1))
			mark(freightId, "rollback-depth");
	}
	const pins = [...input.pinned].sort((a, b) =>
		a.reason < b.reason ? 1 : a.reason > b.reason ? -1 : 0,
	);
	for (const pin of pins) mark(pin.freightId, pin.reason);

	const retire: string[] = [];
	const kept: { freightId: string; reason: RetentionKeepReason }[] = [];
	const ordered = [...input.candidates]
		.filter(
			(candidate) =>
				input.policy.bindle === "" || candidate.bindle === input.policy.bindle,
		)
		.sort((a, b) =>
			a.freightId < b.freightId ? -1 : a.freightId > b.freightId ? 1 : 0,
		);
	for (const candidate of ordered) {
		if (underHold(candidate.labels, input.policy.legalHoldLabels))
			mark(candidate.freightId, "legal-hold");
		if (input.nowMs - candidate.recordedAtMs < keepMs)
			mark(candidate.freightId, "young");
		const why = reasons.get(candidate.freightId);
		if (why) kept.push({ freightId: candidate.freightId, reason: why });
		else retire.push(candidate.freightId);
	}
	return Object.freeze({
		retire: Object.freeze(retire),
		kept: Object.freeze(kept),
	});
}
