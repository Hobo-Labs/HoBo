const MAX_EPOCH_SECONDS = 8_640_000_000_000;
const ISO_EPOCH =
	/^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2}))?$/u;

export function parseSourceDateEpochMs(sourceDateEpoch: string): number {
	const raw = sourceDateEpoch.trim();
	if (!raw) return Number.NaN;
	if (/^\d+$/u.test(raw)) {
		const seconds = Number(raw);
		if (!Number.isSafeInteger(seconds) || seconds > MAX_EPOCH_SECONDS) {
			return Number.NaN;
		}
		return seconds * 1000;
	}

	const match = ISO_EPOCH.exec(raw);
	if (!match) return Number.NaN;
	const year = Number(match[1]);
	const month = Number(match[2]);
	const day = Number(match[3]);
	const date = new Date(0);
	date.setUTCFullYear(year, month - 1, day);
	if (
		date.getUTCFullYear() !== year ||
		date.getUTCMonth() !== month - 1 ||
		date.getUTCDate() !== day
	) {
		return Number.NaN;
	}
	if (match[4] !== undefined) {
		const zone = match[8] ?? "";
		if (
			Number(match[4]) > 23 ||
			Number(match[5]) > 59 ||
			(match[6] !== undefined && Number(match[6]) > 59) ||
			(zone !== "Z" &&
				(Number(zone.slice(1, 3)) > 23 || Number(zone.slice(4, 6)) > 59))
		) {
			return Number.NaN;
		}
	}
	const ms = Date.parse(raw);
	return Number.isSafeInteger(ms) && ms >= 0 ? ms : Number.NaN;
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
