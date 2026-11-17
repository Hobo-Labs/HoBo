export type MinutesUsage = Readonly<{
	usedMinutes: number;
	includedMinutes: number;
	burnPerHour?: number;
}>;

// public-contract: hours of burn the minutes limit keeps in reserve.
export const MINUTES_RUNWAY_HOURS = 2;

export type MinutesVerdict =
	| Readonly<{ allowed: true }>
	| Readonly<{
			allowed: false;
			reason: "minutes_limit" | "minutes_runway";
			detail: string;
	  }>;

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
