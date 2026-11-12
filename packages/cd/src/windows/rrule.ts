// The RFC 5545 RRULE subset change windows accept (D10): FREQ
// DAILY|WEEKLY|MONTHLY|YEARLY with BYDAY, BYMONTHDAY, BYMONTH, BYHOUR,
// BYMINUTE, INTERVAL, COUNT and UNTIL. Expansion happens in wall-clock time
// in the window's IANA zone and is then mapped to instants, so a weekly
// 09:00 window stays at 09:00 local across DST. Pure: no clock, no I/O.
import type { Outcome } from "../ports.js";
import { refuse, WINDOW_REASON } from "./reasons.js";
import {
	type CivilDate,
	civilOf,
	dayNumber,
	daysInMonth,
	fromLocal,
	type LocalDateTime,
	toLocal,
	weekdayOf,
} from "./zoned.js";

export type Frequency = "DAILY" | "WEEKLY" | "MONTHLY" | "YEARLY";

/** A BYDAY entry: weekday Monday = 0 … Sunday = 6; ordinal 0 means every. */
export type WeekdaySpec = Readonly<{ weekday: number; ordinal: number }>;

export type Until =
	| Readonly<{ kind: "instant"; ms: number }>
	| Readonly<{ kind: "date"; date: CivilDate }>;

// domain-view: parse-don't-validate derived type for the RRULE string field of ChangeWindowRecord (cd.proto); the string is the wire form.
export type RecurrenceRule = Readonly<{
	freq: Frequency;
	interval: number;
	count?: number | undefined;
	until?: Until | undefined;
	byDay: readonly WeekdaySpec[];
	byMonthDay: readonly number[];
	byMonth: readonly number[];
	byHour: readonly number[];
	byMinute: readonly number[];
}>;

/** One recurring (or single) series of occurrence starts. */
export type Series = Readonly<{
	rule?: RecurrenceRule | undefined;
	startMs: number;
	timeZone: string;
}>;

// public-contract: bounds of the accepted subset.
export const RRULE_LIMITS = Object.freeze({
	maxCount: 10_000,
	maxInterval: 1_000,
	/** Consecutive periods without an occurrence before expansion gives up. */
	maxEmptyPeriods: 5_000,
} as const);

const WEEKDAYS = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"] as const;
const FREQUENCIES: readonly Frequency[] = [
	"DAILY",
	"WEEKLY",
	"MONTHLY",
	"YEARLY",
];
const SUPPORTED = new Set([
	"FREQ",
	"INTERVAL",
	"COUNT",
	"UNTIL",
	"BYDAY",
	"BYMONTHDAY",
	"BYMONTH",
	"BYHOUR",
	"BYMINUTE",
]);

/** Expansion gave up: the rule matches no instant within the period limit. */
export class RecurrenceLimitError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "RecurrenceLimitError";
	}
}

function integerList(
	value: string,
	min: number,
	max: number,
	allowNegative: boolean,
): readonly number[] | undefined {
	const out: number[] = [];
	for (const item of value.split(",")) {
		if (!/^[+-]?\d{1,3}$/.test(item)) return undefined;
		const parsed = Number(item);
		const magnitude = Math.abs(parsed);
		if (parsed < 0 && !allowNegative) return undefined;
		if (magnitude < min || magnitude > max) return undefined;
		out.push(parsed);
	}
	return [...new Set(out)].sort((a, b) => a - b);
}

function weekdayList(value: string): readonly WeekdaySpec[] | undefined {
	const out: WeekdaySpec[] = [];
	for (const item of value.split(",")) {
		const match = /^([+-]?\d{1,2})?(MO|TU|WE|TH|FR|SA|SU)$/.exec(item);
		if (!match) return undefined;
		const ordinal = match[1] === undefined ? 0 : Number(match[1]);
		if (match[1] !== undefined && (ordinal === 0 || Math.abs(ordinal) > 53))
			return undefined;
		const code = match[2];
		const weekday = WEEKDAYS.findIndex((day) => day === code);
		out.push({ weekday, ordinal });
	}
	return out;
}

function parseUntil(value: string): Until | undefined {
	const instant = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(value);
	if (instant) {
		const [, y, mo, d, h, mi, s] = instant.map(Number);
		const ms = Date.UTC(y ?? 0, (mo ?? 1) - 1, d, h, mi, s);
		const check = new Date(ms);
		if (check.getUTCDate() !== d || check.getUTCMonth() + 1 !== mo)
			return undefined;
		return { kind: "instant", ms };
	}
	const date = /^(\d{4})(\d{2})(\d{2})$/.exec(value);
	if (date) {
		const [, y, mo, d] = date.map(Number);
		if (
			y === undefined ||
			mo === undefined ||
			d === undefined ||
			mo < 1 ||
			mo > 12 ||
			d < 1 ||
			d > daysInMonth(y, mo)
		)
			return undefined;
		return { kind: "date", date: { year: y, month: mo, day: d } };
	}
	return undefined;
}

/**
 * Parse the accepted RRULE subset. Every problem is reported at once with a
 * remediation; anything outside the subset (BYSETPOS, WKST, BYSECOND,
 * BYWEEKNO, BYYEARDAY, sub-daily FREQ) is refused, never ignored.
 */
export function parseRrule(text: string): Outcome<RecurrenceRule> {
	const problems: string[] = [];
	const body = text.startsWith("RRULE:") ? text.slice(6) : text;
	const parts = new Map<string, string>();
	for (const piece of body.split(";")) {
		const eq = piece.indexOf("=");
		const key = eq < 0 ? piece : piece.slice(0, eq);
		const value = eq < 0 ? "" : piece.slice(eq + 1);
		if (!SUPPORTED.has(key)) {
			problems.push(`unsupported part "${key}"`);
			continue;
		}
		if (parts.has(key)) problems.push(`duplicate part "${key}"`);
		if (value.length === 0) problems.push(`empty part "${key}"`);
		parts.set(key, value);
	}
	const freqText = parts.get("FREQ");
	const freq = FREQUENCIES.find((candidate) => candidate === freqText);
	if (!freq) problems.push("FREQ must be DAILY, WEEKLY, MONTHLY or YEARLY");

	let interval = 1;
	const intervalText = parts.get("INTERVAL");
	if (intervalText !== undefined) {
		interval = Number(intervalText);
		if (
			!/^\d+$/.test(intervalText) ||
			interval < 1 ||
			interval > RRULE_LIMITS.maxInterval
		)
			problems.push(`INTERVAL must be 1–${RRULE_LIMITS.maxInterval}`);
	}
	let count: number | undefined;
	const countText = parts.get("COUNT");
	if (countText !== undefined) {
		count = Number(countText);
		if (!/^\d+$/.test(countText) || count < 1 || count > RRULE_LIMITS.maxCount)
			problems.push(`COUNT must be 1–${RRULE_LIMITS.maxCount}`);
	}
	let until: Until | undefined;
	const untilText = parts.get("UNTIL");
	if (untilText !== undefined) {
		until = parseUntil(untilText);
		if (!until)
			problems.push("UNTIL must be YYYYMMDD or YYYYMMDDTHHMMSSZ (UTC)");
	}
	if (count !== undefined && until !== undefined)
		problems.push("COUNT and UNTIL are mutually exclusive");

	const list = (
		key: string,
		min: number,
		max: number,
		allowNegative: boolean,
	): readonly number[] => {
		const value = parts.get(key);
		if (value === undefined) return [];
		const parsed = integerList(value, min, max, allowNegative);
		if (!parsed) {
			problems.push(`${key} must list integers in ${min}–${max}`);
			return [];
		}
		return parsed;
	};
	const byMonthDay = list("BYMONTHDAY", 1, 31, true);
	const byMonth = list("BYMONTH", 1, 12, false);
	const byHour = list("BYHOUR", 0, 23, false);
	const byMinute = list("BYMINUTE", 0, 59, false);
	let byDay: readonly WeekdaySpec[] = [];
	const byDayText = parts.get("BYDAY");
	if (byDayText !== undefined) {
		const parsed = weekdayList(byDayText);
		if (!parsed) problems.push("BYDAY must list [±n]MO…SU");
		else byDay = parsed;
	}
	const ordinals = byDay.some((spec) => spec.ordinal !== 0);
	if (ordinals && (freq === "DAILY" || freq === "WEEKLY"))
		problems.push("BYDAY ordinals (e.g. 1MO) need FREQ=MONTHLY or YEARLY");
	if (
		ordinals &&
		freq === "MONTHLY" &&
		byDay.some((s) => Math.abs(s.ordinal) > 5)
	)
		problems.push("monthly BYDAY ordinals must be within ±5");
	if (ordinals && byMonthDay.length > 0)
		problems.push("BYDAY ordinals cannot be combined with BYMONTHDAY");
	if (freq === "WEEKLY" && byMonthDay.length > 0)
		problems.push("BYMONTHDAY is not allowed with FREQ=WEEKLY");

	if (problems.length > 0 || !freq) {
		return refuse(
			WINDOW_REASON.rruleInvalid,
			`rrule "${text}": ${problems.join("; ")}`,
			"Use the subset FREQ=DAILY|WEEKLY|MONTHLY|YEARLY with BYDAY, BYMONTHDAY, BYMONTH, BYHOUR, BYMINUTE, INTERVAL and COUNT or UNTIL.",
			"rrule",
		);
	}
	const rule: RecurrenceRule = {
		freq,
		interval,
		byDay,
		byMonthDay,
		byMonth,
		byHour,
		byMinute,
		count,
		until,
	};
	return { ok: true, value: rule };
}

function monthDayMatches(
	date: CivilDate,
	byMonthDay: readonly number[],
): boolean {
	const length = daysInMonth(date.year, date.month);
	return byMonthDay.some((value) =>
		value > 0 ? value === date.day : length + value + 1 === date.day,
	);
}

/** Days of a scope (a month or a year) selected by plain and ordinal BYDAY. */
function weekdaysIn(
	scope: readonly CivilDate[],
	byDay: readonly WeekdaySpec[],
): CivilDate[] {
	const chosen = new Set<number>();
	for (const spec of byDay) {
		const matching = scope.filter((date) => weekdayOf(date) === spec.weekday);
		if (spec.ordinal === 0) {
			for (const date of matching) chosen.add(dayNumber(date));
		} else {
			const pick =
				spec.ordinal > 0
					? matching[spec.ordinal - 1]
					: matching[matching.length + spec.ordinal];
			if (pick) chosen.add(dayNumber(pick));
		}
	}
	return [...chosen].sort((a, b) => a - b).map(civilOf);
}

function monthScope(year: number, month: number): CivilDate[] {
	const out: CivilDate[] = [];
	for (let day = 1; day <= daysInMonth(year, month); day += 1)
		out.push({ year, month, day });
	return out;
}

function daysOfMonth(
	rule: RecurrenceRule,
	year: number,
	month: number,
	start: CivilDate,
): CivilDate[] {
	const scope = monthScope(year, month);
	if (rule.byMonthDay.length === 0 && rule.byDay.length === 0)
		return start.day <= scope.length ? [{ year, month, day: start.day }] : [];
	let days = scope;
	if (rule.byMonthDay.length > 0)
		days = days.filter((date) => monthDayMatches(date, rule.byMonthDay));
	if (rule.byDay.length > 0) {
		const selected = new Set(
			weekdaysIn(scope, rule.byDay).map((date) => dayNumber(date)),
		);
		days = days.filter((date) => selected.has(dayNumber(date)));
	}
	return days;
}

function mondayOf(date: CivilDate): number {
	return dayNumber(date) - weekdayOf(date);
}

/** Candidate civil dates of period k (k counts periods, not intervals). */
function periodDates(
	rule: RecurrenceRule,
	period: number,
	start: CivilDate,
): CivilDate[] {
	switch (rule.freq) {
		case "DAILY": {
			const date = civilOf(dayNumber(start) + period);
			const keep =
				(rule.byMonth.length === 0 || rule.byMonth.includes(date.month)) &&
				(rule.byMonthDay.length === 0 ||
					monthDayMatches(date, rule.byMonthDay)) &&
				(rule.byDay.length === 0 ||
					rule.byDay.some((spec) => spec.weekday === weekdayOf(date)));
			return keep ? [date] : [];
		}
		case "WEEKLY": {
			const monday = mondayOf(start) + period * 7;
			const weekdays =
				rule.byDay.length > 0
					? rule.byDay.map((spec) => spec.weekday)
					: [weekdayOf(start)];
			return [...new Set(weekdays)]
				.sort((a, b) => a - b)
				.map((weekday) => civilOf(monday + weekday))
				.filter(
					(date) =>
						rule.byMonth.length === 0 || rule.byMonth.includes(date.month),
				);
		}
		case "MONTHLY": {
			const index = start.month - 1 + period;
			const year = start.year + Math.floor(index / 12);
			const month = (index % 12) + 1;
			if (rule.byMonth.length > 0 && !rule.byMonth.includes(month)) return [];
			return daysOfMonth(rule, year, month, start);
		}
		case "YEARLY": {
			const year = start.year + period;
			if (rule.byMonth.length > 0) {
				return rule.byMonth.flatMap((month) =>
					daysOfMonth(rule, year, month, start),
				);
			}
			if (rule.byMonthDay.length > 0) {
				return Array.from({ length: 12 }, (_, i) => i + 1).flatMap((month) =>
					daysOfMonth(rule, year, month, start),
				);
			}
			if (rule.byDay.length > 0) {
				const scope = Array.from({ length: 12 }, (_, i) => i + 1).flatMap(
					(month) => monthScope(year, month),
				);
				return weekdaysIn(scope, rule.byDay);
			}
			return start.day <= daysInMonth(year, start.month)
				? [{ year, month: start.month, day: start.day }]
				: [];
		}
	}
}

function periodOf(
	rule: RecurrenceRule,
	start: CivilDate,
	local: CivilDate,
): number {
	switch (rule.freq) {
		case "DAILY":
			return dayNumber(local) - dayNumber(start);
		case "WEEKLY":
			return Math.floor((mondayOf(local) - mondayOf(start)) / 7);
		case "MONTHLY":
			return (local.year - start.year) * 12 + (local.month - start.month);
		case "YEARLY":
			return local.year - start.year;
	}
}

function untilMs(until: Until, timeZone: string): number {
	if (until.kind === "instant") return until.ms;
	return fromLocal(
		{ ...until.date, hour: 23, minute: 59, second: 59 },
		timeZone,
	);
}

/**
 * Occurrence starts at or after `fromMs`, ascending. DTSTART is the series
 * start; it counts as an occurrence only when it matches the rule. COUNT
 * counts from DTSTART, so a COUNT rule always expands from the beginning.
 * Throws RecurrenceLimitError when `maxEmptyPeriods` consecutive periods
 * produce nothing (a rule such as BYMONTH=2;BYMONTHDAY=30 that never fires).
 */
export function* occurrenceStarts(
	series: Series,
	fromMs: number,
): Generator<number> {
	const { rule, startMs, timeZone } = series;
	if (!rule) {
		if (startMs >= fromMs) yield startMs;
		return;
	}
	const local: LocalDateTime = toLocal(startMs, timeZone);
	const startDate: CivilDate = {
		year: local.year,
		month: local.month,
		day: local.day,
	};
	const hours = rule.byHour.length > 0 ? rule.byHour : [local.hour];
	const minutes = rule.byMinute.length > 0 ? rule.byMinute : [local.minute];
	const limit = rule.until
		? untilMs(rule.until, timeZone)
		: Number.POSITIVE_INFINITY;
	let emitted = 0;
	let step = 0;
	if (rule.count === undefined && fromMs > startMs) {
		const margin = toLocal(fromMs - 2 * 86_400_000, timeZone);
		const period = periodOf(rule, startDate, margin);
		step = Math.max(0, Math.floor(period / rule.interval) - 1);
	}
	let empty = 0;
	for (;;) {
		const dates = periodDates(rule, step * rule.interval, startDate);
		step += 1;
		const starts: number[] = [];
		for (const date of dates) {
			for (const hour of hours) {
				for (const minute of minutes) {
					starts.push(
						fromLocal(
							{ ...date, hour, minute, second: local.second },
							timeZone,
						),
					);
				}
			}
		}
		starts.sort((a, b) => a - b);
		let produced = false;
		for (const start of starts) {
			if (start < startMs) continue;
			if (start > limit) return;
			produced = true;
			emitted += 1;
			if (start >= fromMs) yield start;
			if (rule.count !== undefined && emitted >= rule.count) return;
		}
		empty = produced ? 0 : empty + 1;
		if (empty >= RRULE_LIMITS.maxEmptyPeriods)
			throw new RecurrenceLimitError(
				`no occurrence in ${RRULE_LIMITS.maxEmptyPeriods} consecutive periods`,
			);
	}
}
