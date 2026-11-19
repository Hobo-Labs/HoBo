import {
	addDecimal,
	type Consumption,
	compareDecimal,
	DECIMAL_ZERO,
	type Decimal,
	parseDecimal,
	subtractDecimal,
} from "@hobo/pricing";

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

function safeName(value: string): boolean {
	return (
		value.length > 0 &&
		value.length <= 200 &&
		value.trim() === value &&
		!/[\p{Cc}]/u.test(value)
	);
}

function compareIds(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function ceilUnits(value: Decimal, scale: number): number | undefined {
	if (value.coefficient < 0n || value.scale > 128) return undefined;
	const numerator = value.coefficient * 10n ** BigInt(scale);
	const denominator = 10n ** BigInt(value.scale);
	const amount = (numerator + denominator - 1n) / denominator;
	return amount <= MAX_SAFE ? Number(amount) : undefined;
}

function readDecimal(value: string): Decimal | undefined {
	if (value.length > 128) return undefined;
	return parseDecimal(value);
}

export function incrementalEntitlementClaims(
	full: readonly Consumption[],
	base: readonly Consumption[],
	currency: string,
): { bucketId: string; unit: string; units: number }[] | undefined {
	type Row = { bucketId: string; unit: string; scale: number; amount: Decimal };
	function collect(rows: readonly Consumption[]): Map<string, Row> | undefined {
		const result = new Map<string, Row>();
		for (const row of rows) {
			const quantity = row.quantity;
			if (
				!safeName(row.sourceId) ||
				quantity === undefined ||
				!safeName(quantity.unit) ||
				!new Set(["allowance", "credit", "commitment"]).has(row.kind)
			)
				return undefined;
			const decimal = readDecimal(quantity.decimal);
			if (decimal === undefined || decimal.coefficient < 0n) return undefined;
			const money = row.kind === "credit" || row.kind === "commitment";
			if (money && quantity.unit !== currency) return undefined;
			const unit = money ? `${currency}.micros` : quantity.unit;
			const scale = money ? 6 : 0;
			const key = `${row.kind}\u0000${row.sourceId}\u0000${unit}\u0000${scale}`;
			const prior = result.get(key);
			result.set(key, {
				bucketId: row.sourceId,
				unit,
				scale,
				amount: addDecimal(prior?.amount ?? DECIMAL_ZERO, decimal),
			});
		}
		return result;
	}
	const current = collect(full);
	const before = collect(base);
	if (current === undefined || before === undefined) return undefined;
	const claims: { bucketId: string; unit: string; units: number }[] = [];
	for (const [key, row] of current) {
		const difference = subtractDecimal(
			row.amount,
			before.get(key)?.amount ?? DECIMAL_ZERO,
		);
		if (compareDecimal(difference, DECIMAL_ZERO) <= 0) continue;
		const units = ceilUnits(difference, row.scale);
		if (units === undefined) return undefined;
		claims.push({ bucketId: row.bucketId, unit: row.unit, units });
	}
	return claims.sort(
		(left, right) =>
			compareIds(left.bucketId, right.bucketId) ||
			compareIds(left.unit, right.unit),
	);
}
