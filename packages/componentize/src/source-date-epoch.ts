/** Accept ISO timestamps or Unix epoch seconds (Reproducible Builds / CI deps image). */
export function parseSourceDateEpochMs(sourceDateEpoch: string): number {
	const raw = sourceDateEpoch.trim();
	if (!raw) return Number.NaN;
	if (/^\d+$/u.test(raw)) {
		const seconds = Number(raw);
		if (!Number.isFinite(seconds) || seconds < 0) return Number.NaN;
		return seconds * 1000;
	}
	return Date.parse(raw);
}

export function assertSourceDateEpoch(sourceDateEpoch: string): void {
	if (Number.isNaN(parseSourceDateEpochMs(sourceDateEpoch))) {
		throw new Error("componentize.invalid_source_date_epoch");
	}
}

export function sourceDateEpochToUnixSeconds(sourceDateEpoch: string): string {
	const ms = parseSourceDateEpochMs(sourceDateEpoch);
	if (Number.isNaN(ms)) {
		throw new Error("componentize.invalid_source_date_epoch");
	}
	return Math.floor(ms / 1000).toString();
}
