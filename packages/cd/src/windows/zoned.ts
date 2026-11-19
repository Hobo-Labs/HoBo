
export type LocalDateTime = Readonly<{
	year: number;
	month: number;
	day: number;
	hour: number;
	minute: number;
	second: number;
}>;

export type CivilDate = Readonly<{ year: number; month: number; day: number }>;

const DAY_MS = 86_400_000;
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
	const cached = formatters.get(timeZone);
	if (cached) return cached;
	const created = new Intl.DateTimeFormat("en-US", {
		timeZone,
		hourCycle: "h23",
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
	});
	formatters.set(timeZone, created);
	return created;
}

export function isTimeZone(timeZone: string): boolean {
	if (timeZone.length === 0) return false;
	try {
		formatter(timeZone);
		return true;
	} catch {
		return false;
	}
}

export function toLocal(ms: number, timeZone: string): LocalDateTime {
	const fields = { year: 0, month: 0, day: 0, hour: 0, minute: 0, second: 0 };
	for (const part of formatter(timeZone).formatToParts(new Date(ms))) {
		const key = part.type;
		if (
			key === "year" ||
			key === "month" ||
			key === "day" ||
			key === "hour" ||
			key === "minute" ||
			key === "second"
		) {
			fields[key] = Number(part.value);
		}
	}
	return fields;
}

function utcOf(local: LocalDateTime): number {
	return Date.UTC(
		local.year,
		local.month - 1,
		local.day,
		local.hour,
		local.minute,
		local.second,
	);
}

export function offsetAt(ms: number, timeZone: string): number {
	const whole = Math.floor(ms / 1000) * 1000;
	return utcOf(toLocal(whole, timeZone)) - whole;
}

function sameLocal(a: LocalDateTime, b: LocalDateTime): boolean {
	return (
		a.year === b.year &&
		a.month === b.month &&
		a.day === b.day &&
		a.hour === b.hour &&
		a.minute === b.minute &&
		a.second === b.second
	);
}

export function fromLocal(local: LocalDateTime, timeZone: string): number {
	const asUtc = utcOf(local);
	const before = offsetAt(asUtc - DAY_MS, timeZone);
	const after = offsetAt(asUtc + DAY_MS, timeZone);
	const candidates = [asUtc - before, asUtc - after].filter((instant) =>
		sameLocal(toLocal(instant, timeZone), local),
	);
	if (candidates.length > 0) return Math.min(...candidates);
	return asUtc - before;
}

export function dayNumber(date: CivilDate): number {
	return Math.round(Date.UTC(date.year, date.month - 1, date.day) / DAY_MS);
}

export function civilOf(day: number): CivilDate {
	const instant = new Date(day * DAY_MS);
	return {
		year: instant.getUTCFullYear(),
		month: instant.getUTCMonth() + 1,
		day: instant.getUTCDate(),
	};
}

export function weekdayOf(date: CivilDate): number {
	return (new Date(dayNumber(date) * DAY_MS).getUTCDay() + 6) % 7;
}

export function daysInMonth(year: number, month: number): number {
	return new Date(Date.UTC(year, month, 0)).getUTCDate();
}
