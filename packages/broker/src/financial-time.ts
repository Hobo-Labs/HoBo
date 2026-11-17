import { isJsonString } from "./json.js";

type FinancialInstant = Readonly<{ secondMillis: number; fraction: string }>;

// Require an explicit offset; ambiguous local dates depend on the host timezone.
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
