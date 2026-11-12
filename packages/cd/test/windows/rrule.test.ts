// The RRULE subset and its wall-clock expansion, with DST golden cases for
// America/Chicago (2026-03-08 spring forward, 2026-11-01 fall back) and
// Europe/London (2026-03-29 spring forward, 2026-10-25 fall back).
import { describe, expect, it } from "vitest";
import {
	fromLocal,
	occurrenceStarts,
	parseRrule,
	RecurrenceLimitError,
	type Series,
	toLocal,
} from "../../src/windows/index.js";

const iso = (ms: number) => new Date(ms).toISOString();

function series(rrule: string, startIso: string, timeZone: string): Series {
	const parsed = parseRrule(rrule);
	if (!parsed.ok) throw new Error(parsed.reasons.map((r) => r.message).join());
	return { rule: parsed.value, startMs: Date.parse(startIso), timeZone };
}

function take(s: Series, n: number, fromIso?: string): string[] {
	const out: string[] = [];
	for (const start of occurrenceStarts(s, fromIso ? Date.parse(fromIso) : s.startMs)) {
		out.push(iso(start));
		if (out.length >= n) break;
	}
	return out;
}

describe("wall-clock conversion (golden)", () => {
	it("maps a skipped America/Chicago reading forward by the gap", () => {
		const ms = fromLocal({ year: 2026, month: 3, day: 8, hour: 2, minute: 30, second: 0 }, "America/Chicago");
		expect(iso(ms)).toBe("2026-03-08T08:30:00.000Z");
		expect(toLocal(ms, "America/Chicago")).toMatchObject({ hour: 3, minute: 30 });
	});

	it("maps a repeated America/Chicago reading to its first instant", () => {
		const ms = fromLocal({ year: 2026, month: 11, day: 1, hour: 1, minute: 30, second: 0 }, "America/Chicago");
		expect(iso(ms)).toBe("2026-11-01T06:30:00.000Z");
	});

	it("maps Europe/London readings around both transitions", () => {
		expect(iso(fromLocal({ year: 2026, month: 3, day: 29, hour: 1, minute: 30, second: 0 }, "Europe/London"))).toBe(
			"2026-03-29T01:30:00.000Z",
		);
		expect(iso(fromLocal({ year: 2026, month: 10, day: 25, hour: 1, minute: 30, second: 0 }, "Europe/London"))).toBe(
			"2026-10-25T00:30:00.000Z",
		);
	});
});

describe("RRULE expansion across DST (golden)", () => {
	it("keeps a daily 09:00 America/Chicago window at 09:00 local across spring forward", () => {
		expect(take(series("FREQ=DAILY", "2026-03-06T15:00:00Z", "America/Chicago"), 4)).toEqual([
			"2026-03-06T15:00:00.000Z",
			"2026-03-07T15:00:00.000Z",
			"2026-03-08T14:00:00.000Z",
			"2026-03-09T14:00:00.000Z",
		]);
	});

	it("moves a daily 02:30 America/Chicago occurrence that falls in the gap to 03:30 CDT", () => {
		expect(take(series("FREQ=DAILY;BYHOUR=2;BYMINUTE=30", "2026-03-07T08:30:00Z", "America/Chicago"), 3)).toEqual([
			"2026-03-07T08:30:00.000Z",
			"2026-03-08T08:30:00.000Z",
			"2026-03-09T07:30:00.000Z",
		]);
	});

	it("takes the first 01:30 on the America/Chicago fall-back night", () => {
		expect(take(series("FREQ=DAILY;BYHOUR=1;BYMINUTE=30", "2026-10-31T06:30:00Z", "America/Chicago"), 3)).toEqual([
			"2026-10-31T06:30:00.000Z",
			"2026-11-01T06:30:00.000Z",
			"2026-11-02T07:30:00.000Z",
		]);
	});

	it("keeps a weekly Sunday 01:30 Europe/London rule on wall-clock time through both transitions", () => {
		const s = series("FREQ=WEEKLY;BYDAY=SU;BYHOUR=1;BYMINUTE=30", "2026-03-22T01:30:00Z", "Europe/London");
		expect(take(s, 3)).toEqual([
			"2026-03-22T01:30:00.000Z",
			"2026-03-29T01:30:00.000Z",
			"2026-04-05T00:30:00.000Z",
		]);
		expect(take(s, 2, "2026-10-20T00:00:00Z")).toEqual([
			"2026-10-25T00:30:00.000Z",
			"2026-11-01T01:30:00.000Z",
		]);
	});
});

describe("RRULE subset", () => {
	it("expands the last Friday of each month", () => {
		expect(take(series("FREQ=MONTHLY;BYDAY=-1FR;BYHOUR=18", "2026-01-01T00:00:00Z", "UTC"), 3)).toEqual([
			"2026-01-30T18:00:00.000Z",
			"2026-02-27T18:00:00.000Z",
			"2026-03-27T18:00:00.000Z",
		]);
	});

	it("expands the first Monday and the last day of the month", () => {
		expect(take(series("FREQ=MONTHLY;BYDAY=1MO", "2026-01-01T09:00:00Z", "UTC"), 2)).toEqual([
			"2026-01-05T09:00:00.000Z",
			"2026-02-02T09:00:00.000Z",
		]);
		expect(take(series("FREQ=MONTHLY;BYMONTHDAY=-1", "2026-01-01T09:00:00Z", "UTC"), 2)).toEqual([
			"2026-01-31T09:00:00.000Z",
			"2026-02-28T09:00:00.000Z",
		]);
	});

	it("skips months without the start day instead of clamping (RFC 5545)", () => {
		expect(take(series("FREQ=MONTHLY", "2026-01-31T09:00:00Z", "UTC"), 3)).toEqual([
			"2026-01-31T09:00:00.000Z",
			"2026-03-31T09:00:00.000Z",
			"2026-05-31T09:00:00.000Z",
		]);
	});

	it("honours INTERVAL, COUNT and UNTIL", () => {
		expect(take(series("FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE", "2026-11-02T10:00:00Z", "UTC"), 5)).toEqual([
			"2026-11-02T10:00:00.000Z",
			"2026-11-04T10:00:00.000Z",
			"2026-11-16T10:00:00.000Z",
			"2026-11-18T10:00:00.000Z",
			"2026-11-30T10:00:00.000Z",
		]);
		expect(take(series("FREQ=DAILY;COUNT=2", "2026-11-02T10:00:00Z", "UTC"), 5)).toHaveLength(2);
		expect(take(series("FREQ=DAILY;UNTIL=20261104T100000Z", "2026-11-02T10:00:00Z", "UTC"), 9)).toHaveLength(3);
		expect(take(series("FREQ=DAILY;UNTIL=20261103", "2026-11-02T10:00:00Z", "UTC"), 9)).toHaveLength(2);
	});

	it("expands yearly holiday freezes by month and day", () => {
		expect(take(series("FREQ=YEARLY;BYMONTH=12;BYMONTHDAY=24,25", "2026-01-01T00:00:00Z", "UTC"), 3)).toEqual([
			"2026-12-24T00:00:00.000Z",
			"2026-12-25T00:00:00.000Z",
			"2027-12-24T00:00:00.000Z",
		]);
	});

	it("skips ahead to a late instant without expanding every earlier period", () => {
		expect(take(series("FREQ=DAILY;BYHOUR=9", "2000-01-01T09:00:00Z", "UTC"), 1, "2026-11-12T10:00:00Z")).toEqual([
			"2026-11-13T09:00:00.000Z",
		]);
	});

	it("refuses parts outside the subset with a remediation", () => {
		for (const bad of [
			"FREQ=HOURLY",
			"FREQ=MONTHLY;BYSETPOS=1",
			"FREQ=DAILY;COUNT=2;UNTIL=20261231",
			"FREQ=WEEKLY;BYDAY=1MO",
			"FREQ=DAILY;BYHOUR=24",
			"FREQ=MONTHLY;BYMONTHDAY=0",
			"FREQ=WEEKLY;BYMONTHDAY=1",
			"FREQ=DAILY;INTERVAL=0",
			"FREQ=DAILY;UNTIL=20260231",
		]) {
			const parsed = parseRrule(bad);
			expect(parsed.ok, bad).toBe(false);
			if (!parsed.ok) {
				expect(parsed.reasons[0]?.code).toBe("window-rrule-invalid");
				expect(parsed.reasons[0]?.remediation).not.toBe("");
			}
		}
	});

	it("gives up on a rule that never fires instead of looping", () => {
		const s = series("FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=30", "2026-01-01T00:00:00Z", "UTC");
		expect(() => take(s, 1)).toThrow(RecurrenceLimitError);
	});
});
