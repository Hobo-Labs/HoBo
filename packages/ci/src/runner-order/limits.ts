/**
 * The two limits a runner-order step can carry: a share of the Actions
 * minutes a plan includes, and a monthly spend at a hosted provider.
 *
 * Both answer "is this step still allowed" from a measurement the caller
 * already has. A measurement that is missing never blocks a step: refusing a
 * runner because a billing read failed would stop CI over a number nobody
 * saw.
 *
 * Pure functions: no clock, network or store.
 */

/** What an account has used of the Actions minutes its plan includes. */
export type MinutesUsage = Readonly<{
	usedMinutes: number;
	/** Minutes the plan includes this billing cycle. */
	includedMinutes: number;
	/** Minutes used per hour over the recent past. Absent when not measured. */
	burnPerHour?: number;
}>;

/**
 * How far ahead the minutes limit looks. With less than this much burn left
 * before the included minutes run out, the step is left alone so the jobs
 * already running do not carry the account over.
 */
// public-contract: hours of burn the minutes limit keeps in reserve.
export const MINUTES_RUNWAY_HOURS = 2;

export type MinutesVerdict =
	| Readonly<{ allowed: true }>
	| Readonly<{
			allowed: false;
			reason: "minutes_limit" | "minutes_runway";
			detail: string;
	  }>;

/**
 * Whether a `github` step limited to `percent` of the included minutes may
 * take a job. Refused once usage reaches the limit, and also when the
 * minutes left would be gone within `MINUTES_RUNWAY_HOURS` at the measured
 * burn. Unknown usage, or a plan with no included minutes on record, allows.
 */
export function minutesVerdict(
	percent: number,
	usage: MinutesUsage | undefined,
): MinutesVerdict {
	if (!usage || usage.includedMinutes <= 0) return { allowed: true };
	const limit = (usage.includedMinutes * percent) / 100;
	if (usage.usedMinutes >= limit)
		return {
			allowed: false,
			reason: "minutes_limit",
			detail: `${Math.round(usage.usedMinutes)} of ${usage.includedMinutes} included minutes used; the limit is ${percent}%`,
		};
	const left = usage.includedMinutes - usage.usedMinutes;
	const burn = usage.burnPerHour ?? 0;
	if (burn > 0 && left < burn * MINUTES_RUNWAY_HOURS)
		return {
			allowed: false,
			reason: "minutes_runway",
			detail: `${Math.round(left)} included minutes left at ${Math.round(burn)} a hour`,
		};
	return { allowed: true };
}

export type SpendVerdict =
	| Readonly<{ allowed: true }>
	| Readonly<{ allowed: false; reason: "spend_limit"; detail: string }>;

/**
 * Whether a hosted provider step limited to `limitUsd` this month may take a
 * job. `spentUsd` is what the account's finished jobs cost at that provider
 * since the first of the month; absent means nobody has measured it, which
 * allows.
 */
export function spendVerdict(
	limitUsd: number,
	spentUsd: number | undefined,
): SpendVerdict {
	if (spentUsd === undefined || spentUsd < limitUsd) return { allowed: true };
	return {
		allowed: false,
		reason: "spend_limit",
		detail: `$${spentUsd.toFixed(2)} of $${limitUsd} spent this month`,
	};
}
