import { isJsonString } from "./json.js";

type FinancialInstant = Readonly<{ secondMillis: number; fraction: string }>;

const TIMESTAMP =
	/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/;

function parseFinancialTime(value: string): FinancialInstant | undefined {
	if (!isJsonString(value)) return undefined;
	const match = TIMESTAMP.exec(value);
	if (!match) return undefined;
	const base = match[1];
	const zone = match[3];
	if (base === undefined || zone === undefined) return undefined;
	const local = Date.parse(`${base}Z`);
	if (
		!Number.isFinite(local) ||
		new Date(local).toISOString().slice(0, 19) !== base
	)
		return undefined;
	const secondMillis = Date.parse(`${base}${zone}`);
	if (!Number.isFinite(secondMillis)) return undefined;
	return { secondMillis, fraction: (match[2] ?? "").replace(/0+$/, "") };
}

export function validFinancialTime(value: string): boolean {
	return parseFinancialTime(value) !== undefined;
}

export function compareFinancialTime(left: string, right: string): number {
	const a = parseFinancialTime(left);
	const b = parseFinancialTime(right);
	if (!a || !b) throw new TypeError("invalid financial evidence timestamp");
	if (a.secondMillis !== b.secondMillis)
		return a.secondMillis < b.secondMillis ? -1 : 1;
	return a.fraction < b.fraction ? -1 : a.fraction > b.fraction ? 1 : 0;
}

export function addFinancialMilliseconds(
	value: string,
	milliseconds: number,
): string {
	const instant = parseFinancialTime(value);
	if (!instant || !Number.isSafeInteger(milliseconds))
		throw new TypeError("invalid financial timestamp or duration");
	const fraction = instant.fraction.padEnd(3, "0");
	const elapsedMillis = Number(fraction.slice(0, 3));
	const shifted = instant.secondMillis + elapsedMillis + milliseconds;
	if (!Number.isSafeInteger(shifted))
		throw new RangeError("financial timestamp is out of range");
	const date = new Date(shifted);
	if (!Number.isFinite(date.getTime()))
		throw new RangeError("financial timestamp is out of range");
	const result = `${date.toISOString().slice(0, -1)}${fraction.slice(3)}Z`;
	if (!validFinancialTime(result))
		throw new RangeError("financial timestamp is out of range");
	return result;
}

export function ceilFinancialMinutes(start: string, finish: string): number {
	if (
		!validFinancialTime(start) ||
		!validFinancialTime(finish) ||
		compareFinancialTime(finish, start) < 0
	)
		throw new TypeError("invalid financial time interval");
	const elapsedMillis = Date.parse(finish) - Date.parse(start);
	if (!Number.isSafeInteger(elapsedMillis))
		throw new RangeError("financial time interval is out of range");
	let minutes = Math.ceil(elapsedMillis / 60_000);
	if (
		compareFinancialTime(
			finish,
			addFinancialMilliseconds(start, minutes * 60_000),
		) > 0
	)
		minutes += 1;
	if (!Number.isSafeInteger(minutes))
		throw new RangeError("financial time interval is out of range");
	return minutes;
}
