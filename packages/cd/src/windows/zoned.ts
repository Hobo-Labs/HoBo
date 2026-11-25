// Wall-clock arithmetic in an IANA time zone through `Intl`, with no clock of
// its own: every function maps an instant the caller passes. DST rules come
// from the runtime's tz database, so a window written as "09:00
// America/Chicago" opens at 09:00 local on both sides of a transition.

/** A civil (wall-clock) date and time. Months are 1–12. */
export type LocalDateTime = Readonly<{
	year: number;
	month: number;
	day: number;
	hour: number;
	minute: number;
	second: number;
}>;

/** A civil date. Months are 1–12. */
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

/** True when the runtime knows this IANA zone name. */
export function isTimeZone(timeZone: string): boolean {
	if (timeZone.length === 0) return false;
	try {
		formatter(timeZone);
		return true;
	} catch {
		return false;
	}
}

/** The wall-clock reading of an instant in a zone. */
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

/** Offset of the zone from UTC at an instant, in ms (local − UTC). */
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

/**
 * The instant a wall-clock reading denotes in a zone (RFC 5545 §3.3.5):
 * - an ambiguous reading (the repeated hour when clocks fall back) is the
 *   first, earlier instant;
 * - a nonexistent reading (the skipped hour when clocks spring forward) is
 *   moved forward by the length of the gap, so 02:30 on a spring-forward
 *   night in America/Chicago is 03:30 CDT.
 */
export function fromLocal(local: LocalDateTime, timeZone: string): number {
	const asUtc = utcOf(local);
	const before = offsetAt(asUtc - DAY_MS, timeZone);
	const after = offsetAt(asUtc + DAY_MS, timeZone);
	const candidates = [asUtc - before, asUtc - after].filter((instant) =>
		sameLocal(toLocal(instant, timeZone), local),
	);
	if (candidates.length > 0) return Math.min(...candidates);
	// In the gap: interpret with the offset in force before the transition.
	return asUtc - before;
}

/** Days since 1970-01-01 of a civil date (proleptic Gregorian). */
export function dayNumber(date: CivilDate): number {
	return Math.round(Date.UTC(date.year, date.month - 1, date.day) / DAY_MS);
}

/** The civil date of a day number. */
export function civilOf(day: number): CivilDate {
	const instant = new Date(day * DAY_MS);
	return {
		year: instant.getUTCFullYear(),
		month: instant.getUTCMonth() + 1,
		day: instant.getUTCDate(),
	};
}

/** ISO weekday index with Monday = 0 … Sunday = 6. */
export function weekdayOf(date: CivilDate): number {
	return (new Date(dayNumber(date) * DAY_MS).getUTCDay() + 6) % 7;
}

/** Number of days in a month (1–12) of a year. */
export function daysInMonth(year: number, month: number): number {
	return new Date(Date.UTC(year, month, 0)).getUTCDate();
}
